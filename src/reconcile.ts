import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { createRemnawaveClient } from './remnawave-client.js';

interface PanelUser { id: string; deviceUserId?: string; tag: string | null; status: string }
interface PanelDevice { hwid: string; userId: string; createdAt: string }
interface Association { userId: string; tag: string | null; status: string; createdAt: string }
interface StoredOwner { hwid: string; user_uuid: string; first_seen_at: number }
interface DeviceRow {
  hwidSha256: string;
  storedOwnerId: string | null;
  firstSeenAtMs: number | null;
  associations: Association[];
}

const numericId = /^[1-9][0-9]*$/;
const fingerprint = (hwid: string) => createHash('sha256').update(hwid).digest('hex');

export async function reconcile(
  db: Database.Database,
  trialUsers: AsyncIterable<PanelUser>,
  devices: AsyncIterable<PanelDevice>,
) {
  const users = new Map<string, PanelUser>();
  const trialIds = new Set<string>();
  for await (const user of trialUsers) {
    trialIds.add(user.id);
    for (const id of [user.id, user.deviceUserId ?? user.id]) {
      const previous = users.get(id);
      if (previous && previous.id !== user.id) throw new Error('Panel returned conflicting device user IDs');
      users.set(id, user);
    }
  }

  const byDevice = new Map<string, Map<string, Association>>();
  for await (const { hwid, userId, createdAt } of devices) {
    const user = users.get(userId);
    if (!user) continue;
    const associations = byDevice.get(hwid) ?? new Map<string, Association>();
    const previous = associations.get(user.id);
    if (!previous || Date.parse(createdAt) < Date.parse(previous.createdAt)) {
      associations.set(user.id, { userId: user.id, tag: user.tag, status: user.status, createdAt });
    }
    byDevice.set(hwid, associations);
  }

  return db.transaction(() => {
    const owners = new Map(
      db.prepare<[], StoredOwner>('SELECT hwid, user_uuid, first_seen_at FROM trial_hwids')
        .all().map(owner => [owner.hwid, owner]),
    );
    const missingDevices: DeviceRow[] = [];
    const sharedDevices: DeviceRow[] = [];
    const unresolvedLegacyOwners: DeviceRow[] = [];
    const ownerConflicts: DeviceRow[] = [];
    let trialAssociations = 0;
    let storedLegacyOwners = 0;
    let attachedLegacyOwners = 0;
    const legacyOwnerIds = new Set<string>();
    for (const hwid of new Set([...byDevice.keys(), ...owners.keys()])) {
      const owner = owners.get(hwid);
      const associations = [...(byDevice.get(hwid)?.values() ?? [])]
        .sort((a, b) => a.userId.localeCompare(b.userId));
      const legacy = owner && !numericId.test(owner.user_uuid);
      if (!legacy && associations.length === 0) continue;
      trialAssociations += associations.length;
      const row = {
        hwidSha256: fingerprint(hwid), storedOwnerId: owner?.user_uuid ?? null,
        firstSeenAtMs: owner?.first_seen_at ?? null, associations,
      };
      if (!owner) missingDevices.push(row);
      if (associations.length > 1) sharedDevices.push(row);
      if (legacy) {
        legacyOwnerIds.add(owner.user_uuid);
        storedLegacyOwners++;
        if (associations.length) attachedLegacyOwners++;
      }
      if (!owner) continue;
      const ownerId = users.get(owner.user_uuid)?.id ?? owner.user_uuid;
      const mixedFormats = associations.some(a => numericId.test(a.userId) !== numericId.test(ownerId));
      if (mixedFormats || (legacy && associations.length === 0)) unresolvedLegacyOwners.push(row);
      const conflicts = associations.some(a => a.userId !== ownerId && numericId.test(a.userId) === numericId.test(ownerId));
      if (conflicts) {
        ownerConflicts.push(row);
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        trialUsers: trialIds.size, trialHwids: byDevice.size, trialAssociations,
        tracked: byDevice.size - missingDevices.length, missing: missingDevices.length,
        missingWithActiveTrial: missingDevices.filter(row => row.associations.some(a => a.status === 'ACTIVE')).length,
        shared: sharedDevices.length, missingShared: sharedDevices.filter(row => row.storedOwnerId === null).length,
        storedLegacyOwners, distinctStoredLegacyOwnerIds: legacyOwnerIds.size,
        attachedLegacyOwners, ownerConflicts: ownerConflicts.length,
      },
      missingDevices, sharedDevices, unresolvedLegacyOwners, ownerConflicts,
      ...readActionHistory(db),
    };
  })();
}

function readActionHistory(db: Database.Database) {
  const hasQueue = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'disable_jobs'").get();
  const byState: Record<string, number> = {};
  const reviewJobs = [];
  let overdue = 0;
  let oldestOpenAtMs: number | null = null;
  if (hasQueue) {
    const backlog = db.prepare<[number], { oldest: number | null; overdue: number }>(
      `SELECT min(detected_at) AS oldest, count(CASE WHEN max(detected_at,next_attempt_at) < ? THEN 1 END) AS overdue
       FROM disable_jobs WHERE state IN ('pending','retry','running')`,
    ).get(Date.now() - 5 * 60_000)!;
    overdue = backlog.overdue;
    oldestOpenAtMs = backlog.oldest;
    for (const row of db.prepare<[], { state: string; count: number }>(
      'SELECT state, COUNT(*) AS count FROM disable_jobs GROUP BY state',
    ).iterate()) byState[row.state] = row.count;
    const rows = db.prepare<[], {
      eventKey: string; userId: string; ownerId: string; hwid: string; reason: string | null;
    }>(`SELECT event_key AS eventKey, user_id AS userId, owner_id AS ownerId, hwid, last_error AS reason
        FROM disable_jobs WHERE state = 'review' ORDER BY detected_at, event_key`);
    for (const { hwid, ...job } of rows.iterate()) reviewJobs.push({ ...job, hwidSha256: fingerprint(hwid) });
  }
  const failures = db.prepare<[], {
    auditId: number; detectedAtMs: number; userId: string; tag: string; ownerId: string; hwid: string;
  }>(`SELECT f.id AS auditId, f.detected_at AS detectedAtMs, f.offender_uuid AS userId,
            f.offender_tag AS tag, f.original_uuid AS ownerId, f.hwid
       FROM abuse_log f JOIN (
         SELECT max(id) AS latest FROM abuse_log
         WHERE disable_status IN ('failed','success','already_disabled')
         GROUP BY hwid,offender_uuid,original_uuid
       ) recent ON recent.latest=f.id WHERE f.disable_status='failed' ${hasQueue ? `AND NOT EXISTS (
          SELECT 1 FROM disable_jobs j WHERE j.event_key = 'audit:' || f.id
            AND j.state IN ('success', 'already_disabled', 'skipped')
        )` : ''} ORDER BY f.id`);
  return {
    queue: { available: hasQueue, byState, overdue, oldestOpenAtMs, reviewJobs },
    unresolvedFailedActions: failures.all().map(({ hwid, ...row }) => ({ ...row, hwidSha256: fingerprint(hwid) })),
  };
}

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel }, process.stderr);
  const client = createRemnawaveClient({
    baseUrl: config.remnawaveBaseUrl, apiToken: config.remnawaveApiToken, logger,
  });
  const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
  try {
    const report = await reconcile(db, client.listTrialUsers(config.trialTags), client.listDevices());
    if (report.queue.overdue || report.queue.reviewJobs.length) {
      logger.warn({ overdue: report.queue.overdue, review: report.queue.reviewJobs.length }, 'disable queue needs attention');
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('Reconciliation failed:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  });
}
