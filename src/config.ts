import 'dotenv/config';
import { z } from 'zod';

const csv = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  dbPath: z.string().default('/data/anti-abuse.sqlite'),

  remnawaveBaseUrl: z.string().url(),
  remnawaveApiToken: z.string().min(1),

  webhookSecret: z.string().min(1),
  webhookTimestampToleranceSec: z.coerce.number().int().nonnegative().default(300),

  trialTags: z.preprocess(
    (v) => (typeof v === 'string' ? csv(v) : v),
    z.array(z.string().min(1)).min(1, 'TRIAL_TAGS must list at least one tag'),
  ),
  dryRun: z
    .preprocess((v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v), z.boolean())
    .default(false),

  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  const parsed = ConfigSchema.safeParse({
    port: process.env.PORT,
    host: process.env.HOST,
    dbPath: process.env.DB_PATH,
    remnawaveBaseUrl: process.env.REMNAWAVE_BASE_URL,
    remnawaveApiToken: process.env.REMNAWAVE_API_TOKEN,
    webhookSecret: process.env.WEBHOOK_SECRET,
    webhookTimestampToleranceSec: process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
    trialTags: process.env.TRIAL_TAGS,
    dryRun: process.env.DRY_RUN,
    logLevel: process.env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Invalid configuration:\n  ${summary}`);
  }
  return parsed.data;
}
