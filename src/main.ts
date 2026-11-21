import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createRemnawaveClient } from './remnawave-client.js';
import { DisableWorker } from './service/disable-worker.js';
import { TrialGuard } from './service/trial-guard.js';
import { registerWebhookRoute } from './webhook/route.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const isProd = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss.l' },
            },
          }),
    },
    disableRequestLogging: false,
  });
  const logger = app.log;

  logger.info(
    {
      trialTags: config.trialTags,
      dryRun: config.dryRun,
      dbPath: config.dbPath,
      panel: config.remnawaveBaseUrl,
    },
    'starting anti-abuse service',
  );

  const db = openDatabase(config.dbPath);
  const shutdownController = new AbortController();
  const client = createRemnawaveClient({
    signal: shutdownController.signal,
    baseUrl: config.remnawaveBaseUrl,
    apiToken: config.remnawaveApiToken,
    logger,
  });
  const options = { db, logger, trialTags: config.trialTags, dryRun: config.dryRun };
  const guard = new TrialGuard(options);
  const worker = new DisableWorker({ ...options, client });

  await registerWebhookRoute(app, {
    guard,
    logger,
    webhookSecret: config.webhookSecret,
    timestampToleranceSec: config.webhookTimestampToleranceSec,
  });

  await app.listen({ port: config.port, host: config.host });
  let running: Promise<void> | undefined;
  const poll = () => {
    if (running || shutdownController.signal.aborted) return;
    running = (async () => {
      while (!shutdownController.signal.aborted && await worker.runOne()) {
        // Drain due jobs serially before the next poll.
      }
    })().catch(err => logger.error({ err }, 'disable worker poll failed')).finally(() => { running = undefined; });
  };
  const pollIntervalMs = 5_000;
  const timer = setInterval(poll, pollIntervalMs).unref();
  poll();

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownController.signal.aborted) return;
    shutdownController.abort();
    clearInterval(timer);
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await running;
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
