import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { TrialGuard } from '../service/trial-guard.js';

// Validate the fields the guard uses across panel versions.
const envelopeSchema = z
  .object({
    scope: z.string(),
    event: z.string().optional(),
    data: z.unknown(),
  })
  .passthrough();

const userFields = z.object({
  username: z.string().default(''),
  tag: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }).optional().catch(undefined),
});

const userDataSchema = z.union([
  // Remnawave v2 included a numeric ID but used the UUID for user actions.
  userFields.extend({ uuid: z.string().min(1) })
    .transform(({ uuid, ...user }) => ({ ...user, id: uuid })),
  userFields.extend({ id: z.number().int().positive().safe().transform(id => String(id)) }),
]);

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
      guard.onUserCreated(data);
      return;
    }
    if (event.event === 'user.deleted') {
      const data = userDataSchema.parse(event.data);
      guard.onUserDeleted(data.id);
      return;
    }
    logger.debug({ event: event.event }, 'user event ignored');
    return;
  }

  if (event.scope === 'user_hwid_devices') {
    if (event.event === 'user_hwid_devices.added') {
      const data = hwidDataSchema.parse(event.data);
      await guard.onHwidAdded(data.user, { hwid: data.hwidUserDevice.hwid });
      return;
    }
    logger.debug({ event: event.event }, 'hwid event ignored');
    return;
  }

  logger.debug({ scope: event.scope, event: event.event }, 'webhook scope ignored');
}
