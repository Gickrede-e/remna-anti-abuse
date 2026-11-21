import { REST_API } from '@remnawave/backend-contract';
import { z } from 'zod';
import type { Logger } from './logger.js';

const numericId = z.number().int().positive().safe();
const userSchema = z.object({
  uuid: z.string().min(1).optional(),
  id: numericId,
  tag: z.string().nullable(),
  status: z.enum(['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']),
  createdAt: z.string().datetime({ offset: true }),
}).transform(user => ({
  id: user.uuid ?? String(user.id), deviceUserId: String(user.id),
  tag: user.tag, status: user.status, createdAt: user.createdAt,
}));

const deviceSchema = z.object({
  hwid: z.string().min(1),
  userUuid: z.string().min(1).optional(),
  userId: numericId.optional(),
  createdAt: z.string().datetime({ offset: true }),
}).refine(d => d.userId !== undefined || d.userUuid !== undefined, 'Missing device owner')
  .transform(d => ({ hwid: d.hwid, userId: d.userId === undefined ? d.userUuid! : String(d.userId), createdAt: d.createdAt }));

export type PanelUser = z.infer<typeof userSchema>;
export type PanelDevice = z.infer<typeof deviceSchema>;

export interface RemnawaveClient {
  getUser(userId: string): Promise<PanelUser>;
  getUserDevices(userId: string): Promise<PanelDevice[]>;
  listTrialUsers(tags: readonly string[]): AsyncIterable<PanelUser>;
  listDevices(): AsyncIterable<PanelDevice>;
  disableUser(userId: string): Promise<void>;
}

export interface RemnawaveClientOptions {
  baseUrl: string;
  apiToken: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class RemnawaveApiError extends Error {
  readonly errorCode?: string;
  constructor(message: string, readonly status: number, body: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RemnawaveApiError';
    try {
      const code: unknown = JSON.parse(body).errorCode;
      if (typeof code === 'string') this.errorCode = code;
    } catch {
      // Proxies may return plain text instead of a panel error.
    }
  }
}

const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 8_000;
const envelope = z.object({ response: z.unknown() });
const pageSchema = z.object({ total: z.number().int().nonnegative() });
function retryDelay(value: string | null): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function createRemnawaveClient(opts: RemnawaveClientOptions): RemnawaveClient {
  const fetchFn = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');

  async function request(path: string, method = 'GET'): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetchFn(base + path, {
      method,
      headers: { Authorization: 'Bearer ' + opts.apiToken, Accept: 'application/json' },
      redirect: 'error',
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new RemnawaveApiError('Remnawave HTTP ' + res.status, res.status, body, retryDelay(res.headers.get('retry-after')));
    }
    return envelope.parse(await res.json()).response;
  }

  async function* pages(path: string, field: 'users' | 'devices', params: URLSearchParams) {
    let start = 0;
    let total: number | undefined;
    do {
      params.set('start', String(start));
      params.set('size', String(PAGE_SIZE));
      const page = pageSchema.passthrough().parse(await request(path + '?' + params));
      const rows = z.array(z.unknown()).parse(page[field]);
      if ((total !== undefined && total !== page.total) || start + rows.length > page.total ||
          (!rows.length && start < page.total)) {
        throw new Error('Panel pagination changed or returned an incomplete page for ' + field);
      }
      total = page.total;
      yield* rows;
      start += rows.length;
    } while (start < total);
  }

  return {
    async getUser(userId) {
      const user = userSchema.parse(await request('/api/users/' + encodeURIComponent(userId)));
      if (user.id !== userId) throw new Error('Panel returned a different user');
      return user;
    },
    async getUserDevices(userId) {
      const page = pageSchema.extend({ devices: z.array(deviceSchema) })
        .parse(await request('/api/hwid/devices/' + encodeURIComponent(userId)));
      if (page.total !== page.devices.length) throw new Error('Incomplete per-user device list');
      return page.devices;
    },
    async *listTrialUsers(tags) {
      for (const tag of new Set(tags)) {
        const params = new URLSearchParams({
          filters: JSON.stringify([{ id: 'tag', value: tag }]),
          filterModes: JSON.stringify({ tag: 'equals' }),
          sorting: JSON.stringify([{ id: 'id', desc: false }]),
        });
        const seen = new Set<string>();
        for await (const row of pages('/api/users', 'users', params)) {
          const user = userSchema.parse(row);
          if (seen.has(user.id)) throw new Error('User list shifted during reconciliation');
          seen.add(user.id);
          if (user.tag === tag) yield user;
        }
      }
    },
    async *listDevices() {
      const path = '/api/hwid/devices';
      const probe = pageSchema.extend({ devices: z.array(z.object({
        userId: numericId.optional(), userUuid: z.string().optional(),
      })) }).parse(await request(path + '?start=0&size=1'));
      const first = probe.devices[0];
      if (!first) {
        if (probe.total) throw new Error('Incomplete device probe');
        return;
      }
      const ownerField = first.userId === undefined ? 'userUuid' : 'userId';
      const params = new URLSearchParams({
        sorting: JSON.stringify([{ id: 'hwid', desc: false }, { id: ownerField, desc: false }]),
      });
      const seen = new Set<string>();
      for await (const row of pages(path, 'devices', params)) {
        const device = deviceSchema.parse(row);
        const key = JSON.stringify([device.userId, device.hwid]);
        if (seen.has(key)) throw new Error('Device list shifted during reconciliation');
        seen.add(key);
        yield device;
      }
    },
    async disableUser(userId) {
      const user = userSchema.parse(await request(REST_API.USERS.ACTIONS.DISABLE(encodeURIComponent(userId)), 'POST'));
      if (user.id !== userId || user.status !== 'DISABLED') throw new Error('Disable response did not confirm the target account');
      opts.logger.info({ userId }, 'remnawave: user disabled');
    },
  };
}
