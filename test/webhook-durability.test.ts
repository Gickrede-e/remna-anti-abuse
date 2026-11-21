import Fastify from 'fastify';
import { pino } from 'pino';
import { expect, it, vi } from 'vitest';
import type { TrialGuard } from '../src/service/trial-guard.js';
import { registerWebhookRoute } from '../src/webhook/route.js';
import { computeSignature } from '../src/webhook/verify.js';

const secret = 'test-webhook-secret';
const validUser = { id: 101, username: 'alice', tag: 'TRIAL' };

it.each([
  { description: 'a persistence error', data: validUser, status: 503, calls: 1 },
  { description: 'invalid event data', data: { username: 'invalid' }, status: 400, calls: 0 },
])('returns $status for $description on an authenticated webhook', async ({ data, status, calls }) => {
  const app = Fastify();
  const onUserCreated = vi.fn(() => { throw new Error('database unavailable'); });
  const guard = {
    onUserCreated,
    onUserDeleted: vi.fn(),
    onHwidAdded: vi.fn(),
  } satisfies Pick<TrialGuard, 'onUserCreated' | 'onUserDeleted' | 'onHwidAdded'>;

  try {
    await registerWebhookRoute(app, {
      guard,
      logger: pino({ level: 'silent' }),
      webhookSecret: secret,
      timestampToleranceSec: 300,
    });
    const payload = JSON.stringify({ scope: 'user', event: 'user.created', data });
    const response = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-remnawave-signature': computeSignature(payload, secret),
        'x-remnawave-timestamp': new Date().toISOString(),
      },
    });

    expect(response.statusCode).toBe(status);
    expect(onUserCreated).toHaveBeenCalledTimes(calls);
  } finally {
    await app.close();
  }
});
