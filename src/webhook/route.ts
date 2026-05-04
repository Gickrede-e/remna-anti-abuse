import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleWebhookEvent, parseWebhookEvent } from './handler.js';
import type { Logger } from '../logger.js';
import type { TrialGuard } from '../service/trial-guard.js';
import { isFreshTimestamp, verifySignature } from './verify.js';

export interface WebhookRouteOptions {
  guard: TrialGuard;
  logger: Logger;
  webhookSecret: string;
  timestampToleranceSec: number;
}

const SIGNATURE_HEADER = 'x-remnawave-signature';
const TIMESTAMP_HEADER = 'x-remnawave-timestamp';

interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

export async function registerWebhookRoute(
  app: AnyFastifyInstance,
  opts: WebhookRouteOptions,
): Promise<void> {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req: RawBodyRequest, body: string, done) => {
      req.rawBody = body;
      try {
        done(null, body.length === 0 ? {} : JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/webhook', async (req: RawBodyRequest, reply) => {
    const rawBody = req.rawBody ?? '';
    const signature = header(req, SIGNATURE_HEADER);
    const timestamp = header(req, TIMESTAMP_HEADER);

    if (!signature) {
      opts.logger.warn(
        { headers: Object.keys(req.headers) },
        'webhook rejected: missing x-remnawave-signature header',
      );
      return reply.code(401).send({ error: 'missing signature header' });
    }
    if (!isFreshTimestamp(timestamp, opts.timestampToleranceSec)) {
      opts.logger.warn(
        { timestamp, toleranceSec: opts.timestampToleranceSec, now: new Date().toISOString() },
        'webhook rejected: stale or missing timestamp',
      );
      return reply.code(401).send({ error: 'stale or missing timestamp' });
    }
    if (!verifySignature(rawBody, signature, opts.webhookSecret)) {
      opts.logger.warn(
        {
          signaturePrefix: signature.slice(0, 8),
          signatureLength: signature.length,
          bodyLength: rawBody.length,
          secretLength: opts.webhookSecret.length,
        },
        'webhook rejected: signature mismatch — check WEBHOOK_SECRET matches the panel',
      );
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let event;
    try {
      event = parseWebhookEvent(req.body);
    } catch (err) {
      opts.logger.warn({ err }, 'webhook payload failed schema validation');
      return reply.code(400).send({ error: 'invalid payload' });
    }

    try {
      await handleWebhookEvent(event, { guard: opts.guard, logger: opts.logger });
    } catch (err) {
      opts.logger.error(
        { err, scope: event.scope, event: event.event },
        'webhook handler error',
      );
    }
    return reply.code(200).send({ ok: true });
  });

  app.get('/health', async () => ({ status: 'ok' }));
}
