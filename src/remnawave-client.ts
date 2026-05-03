import { REST_API } from '@remnawave/backend-contract';
import type { Logger } from './logger.js';

export interface RemnawaveClient {
  disableUser(uuid: string): Promise<void>;
}

export interface RemnawaveClientOptions {
  baseUrl: string;
  apiToken: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class RemnawaveApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'RemnawaveApiError';
  }
}

export function createRemnawaveClient(opts: RemnawaveClientOptions): RemnawaveClient {
  const fetchFn = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');

  return {
    async disableUser(uuid) {
      const url = base + REST_API.USERS.ACTIONS.DISABLE(uuid);
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new RemnawaveApiError(
          `disableUser(${uuid}) failed: ${res.status} ${res.statusText}`,
          res.status,
          body,
        );
      }
      opts.logger.info({ uuid, status: res.status }, 'remnawave: user disabled');
    },
  };
}
