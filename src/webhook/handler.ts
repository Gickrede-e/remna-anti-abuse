import { RemnawaveWebhookEventSchema } from '@remnawave/backend-contract';
import type { Logger } from '../logger.js';
import type { TrialGuard } from '../service/trial-guard.js';

export type WebhookEvent = ReturnType<typeof RemnawaveWebhookEventSchema.parse>;

export interface WebhookHandlerOptions {
  guard: TrialGuard;
  logger: Logger;
}

export function parseWebhookEvent(body: unknown): WebhookEvent {
  return RemnawaveWebhookEventSchema.parse(body);
}

export async function handleWebhookEvent(
  event: WebhookEvent,
  opts: WebhookHandlerOptions,
): Promise<void> {
  const { guard, logger } = opts;

  switch (event.scope) {
    case 'user': {
      if (event.event === 'user.created') {
        guard.onUserCreated({
          uuid: event.data.uuid,
          username: event.data.username,
          tag: event.data.tag,
        });
        return;
      }
      if (event.event === 'user.deleted') {
        guard.onUserDeleted(event.data.uuid);
        return;
      }
      logger.debug({ event: event.event }, 'user event ignored');
      return;
    }
    case 'user_hwid_devices': {
      if (event.event === 'user_hwid_devices.added') {
        await guard.onHwidAdded(
          {
            uuid: event.data.user.uuid,
            username: event.data.user.username,
            tag: event.data.user.tag,
          },
          { hwid: event.data.hwidUserDevice.hwid },
        );
        return;
      }
      logger.debug({ event: event.event }, 'hwid event ignored');
      return;
    }
    default:
      logger.debug({ scope: event.scope }, 'webhook scope ignored');
  }
}
