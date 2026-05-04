import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { TrialGuard } from '../service/trial-guard.js';

/**
 * Минимально валидируем только то, что нам нужно. Это устойчивее к разнице
 * версий между панелью и npm-пакетом @remnawave/backend-contract — реальный
 * payload может содержать больше или меньше полей, нам важны uuid + tag + hwid.
 */
const envelopeSchema = z
  .object({
    scope: z.string(),
    event: z.string().optional(),
    data: z.unknown(),
  })
  .passthrough();

const userDataSchema = z
  .object({
    uuid: z.string(),
    username: z.string().default(''),
    tag: z.string().nullable().optional(),
  })
  .passthrough();

const hwidDataSchema = z
  .object({
    user: userDataSchema,
    hwidUserDevice: z
      .object({
        hwid: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export type WebhookEvent = z.infer<typeof envelopeSchema>;

export interface WebhookHandlerOptions {
  guard: TrialGuard;
  logger: Logger;
}

export function parseWebhookEvent(body: unknown): WebhookEvent {
  return envelopeSchema.parse(body);
}

export async function handleWebhookEvent(
  event: WebhookEvent,
  opts: WebhookHandlerOptions,
): Promise<void> {
  const { guard, logger } = opts;

  if (event.scope === 'user') {
    if (event.event === 'user.created') {
      const data = userDataSchema.parse(event.data);
      guard.onUserCreated({
        uuid: data.uuid,
        username: data.username,
        tag: data.tag ?? null,
      });
      return;
    }
    if (event.event === 'user.deleted') {
      const data = userDataSchema.parse(event.data);
      guard.onUserDeleted(data.uuid);
      return;
    }
    logger.debug({ event: event.event }, 'user event ignored');
    return;
  }

  if (event.scope === 'user_hwid_devices') {
    if (event.event === 'user_hwid_devices.added') {
      const data = hwidDataSchema.parse(event.data);
      await guard.onHwidAdded(
        {
          uuid: data.user.uuid,
          username: data.user.username,
          tag: data.user.tag ?? null,
        },
        { hwid: data.hwidUserDevice.hwid },
      );
      return;
    }
    logger.debug({ event: event.event }, 'hwid event ignored');
    return;
  }

  logger.debug({ scope: event.scope, event: event.event }, 'webhook scope ignored');
}
