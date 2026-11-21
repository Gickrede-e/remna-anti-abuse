import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { reconcile } from '../src/reconcile.js';

async function* rows<T>(...values: T[]) {
  yield* values;
}

const trial = (id: string, status = 'ACTIVE') => ({ id, tag: 'trial', status });
const device = (hwid: string, userId: string, createdAt = '2025-01-01T00:00:00Z') =>
  ({ hwid, userId, createdAt });

function database() {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
  return db;
}

it('reports distinct trial associations, separates legacy owners, and keeps hardware IDs private', async () => {
  const db = database();
  try {
    db.exec(`INSERT INTO trial_hwids VALUES
      ('raw-legacy', 'legacy-a', 20), ('raw-detached', 'legacy-b', 21), ('raw-local', '11', 22)`);
    db.pragma('query_only = ON');
    const report = await reconcile(db, rows(trial('11'), trial('12', 'DISABLED'), trial('11')), rows(
      device('raw-missing', '11'), device('raw-missing', '12'), device('raw-missing', '11'),
      device('raw-missing', 'unrelated'), device('raw-legacy', '11'), device('raw-local', '12'),
    ));

    expect(report.summary).toMatchObject({
      trialUsers: 2, trialHwids: 3, trialAssociations: 4, tracked: 2, missing: 1,
      missingWithActiveTrial: 1, shared: 1, missingShared: 1, storedLegacyOwners: 2,
      attachedLegacyOwners: 1, ownerConflicts: 1,
    });
    expect(report.missingDevices[0]?.associations).toEqual([
      { userId: '11', tag: 'trial', status: 'ACTIVE', createdAt: '2025-01-01T00:00:00Z' },
      { userId: '12', tag: 'trial', status: 'DISABLED', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    expect(report.missingDevices[0]?.hwidSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.sharedDevices[0]).toEqual(report.missingDevices[0]);
    expect(report.unresolvedLegacyOwners.map(row => row.storedOwnerId).sort()).toEqual(['legacy-a', 'legacy-b']);
    expect(report.ownerConflicts.map(row => row.storedOwnerId)).toEqual(['11']);
    expect(JSON.stringify(report)).not.toMatch(/raw-|unrelated/);
  } finally {
    db.close();
  }
});


it('joins numeric device IDs to canonical panel UUIDs and resolves matching legacy owners', async () => {
  const db = database();
  try {
    db.exec("INSERT INTO trial_hwids VALUES ('same', 'legacy-a', 1), ('other', 'legacy-b', 2)");
    const report = await reconcile(db, rows({ ...trial('legacy-a'), deviceUserId: '11' }), rows(
      device('same', '11'), device('same', 'legacy-a'), device('other', 'legacy-a'),
    ));

    expect(report.summary).toMatchObject({ trialUsers: 1, trialHwids: 2, trialAssociations: 2, attachedLegacyOwners: 2, ownerConflicts: 1 });
    expect(report.unresolvedLegacyOwners).toHaveLength(0);
    expect(report.ownerConflicts[0]?.associations[0]?.userId).toBe('legacy-a');
  } finally {
    db.close();
  }
});

it('reports review jobs, backlog, and failed historical actions without writing to SQLite', async () => {
  const db = database();
  try {
    db.exec(`CREATE TABLE disable_jobs(event_key, user_id, hwid, owner_id, detected_at, state, attempts,
      next_attempt_at, last_error);
      INSERT INTO disable_jobs VALUES
        ('audit:1','11','hidden-a','12',1,'review',1,0,'unverified_legacy_identity'),
        ('audit:2','13','hidden-b','12',3,'retry',2,20,'http_503');
      INSERT INTO abuse_log(detected_at,hwid,offender_uuid,offender_tag,original_uuid,disable_status) VALUES
        (1,'hidden-a','11','trial','12','failed'),(2,'hidden-b','13','trial','12','failed'),
        (3,'hidden-b','13','trial','12','success');`);
    db.pragma('query_only = ON');
    const report = await reconcile(db, rows(), rows());

    expect(report.queue.byState).toEqual({ review: 1, retry: 1 });
    expect(report.queue.reviewJobs[0]).toMatchObject({
      eventKey: 'audit:1', userId: '11', reason: 'unverified_legacy_identity',
    });
    expect(report.unresolvedFailedActions.map(row => row.auditId)).toEqual([1]);
    expect(JSON.stringify(report)).not.toContain('hidden-');
  } finally {
    db.close();
  }
});
