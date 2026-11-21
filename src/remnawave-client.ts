import { REST_API } from '@remnawave/backend-contract';
import type { Logger } from './logger.js';

export interface RemnawaveClient {
  disableUser(userId: string): Promise<void>;
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
    async disableUser(userId) {
      const url = base + REST_API.USERS.ACTIONS.DISABLE(userId);
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiToken}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new RemnawaveApiError(
          `disableUser(${userId}) failed: ${res.status} ${res.statusText}`,
          res.status,
          body,
        );
      }
      opts.logger.info({ userId, status: res.status }, 'remnawave: user disabled');
    },
  };
}
