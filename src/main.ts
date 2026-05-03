import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createRemnawaveClient } from './remnawave-client.js';
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
  const client = createRemnawaveClient({
    baseUrl: config.remnawaveBaseUrl,
    apiToken: config.remnawaveApiToken,
    logger,
  });
  const guard = new TrialGuard({
    db,
    client,
    logger,
    trialTags: config.trialTags,
    dryRun: config.dryRun,
  });

  await registerWebhookRoute(app, {
    guard,
    logger,
    webhookSecret: config.webhookSecret,
    timestampToleranceSec: config.webhookTimestampToleranceSec,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
