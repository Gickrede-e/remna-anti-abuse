import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { DisableWorker } from '../src/service/disable-worker.js';
import { TrialGuard, type TrialUser, type HwidDevice } from '../src/service/trial-guard.js';

const logger = pino({ level: 'silent' });

interface AbuseRow {
  hwid: string;
  offender_uuid: string;
  original_uuid: string;
  disable_status: string;
}

describe('TrialGuard', () => {
  let dir: string;
  let db: DB;
  const makeClient = () => ({
    disableUser: vi.fn(async (_id: string) => {}),
    getUser: async (id: string) => ({ id, deviceUserId: id, tag: 'trial', status: 'ACTIVE' as const, createdAt: '2026-10-02T00:00:00Z' }),
    getUserDevices: async (id: string) => ['hwid-aaa','hwid-legacy'].map(hwid => ({ hwid, userId: id, createdAt: '2026-01-01T00:00:00Z' })),
  });
  let client: ReturnType<typeof makeClient>;
  let guard: TrialGuard;
  let worker: DisableWorker;
  let delivery = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trial-guard-'));
    db = openDatabase(join(dir, 'test.sqlite'));
    client = makeClient();
    const options = { db, logger, trialTags: ['trial', 'trial7d'], dryRun: false };
    guard = new TrialGuard(options);
    worker = new DisableWorker({ ...options, client });
  });

  async function recordDevice(receiver: TrialGuard, user: TrialUser, device: HwidDevice) {
    receiver.onHwidAdded(user, device, 'webhook:fixture-' + ++delivery);
    await worker.runOne();
  }

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records trial users on user.created', () => {
    guard.onUserCreated({ id: 'user-a', username: 'alice', tag: 'trial' });
    const row = db
      .prepare<[string], { tag: string; username: string }>(
        'SELECT tag, username FROM trial_users WHERE user_uuid = ?',
      )
      .get('user-a');
    expect(row).toEqual({ tag: 'trial', username: 'alice' });
  });

  it('ignores users without a trial tag', () => {
    guard.onUserCreated({ id: 'user-paid', username: 'paid', tag: 'paid' });
    guard.onUserCreated({ id: 'user-null', username: 'nolan', tag: null });
    const count = db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM trial_users')
      .get();
    expect(count?.c).toBe(0);
  });

  it('records first hwid for a trial user without disabling anyone', async () => {
    guard.onUserCreated({ id: 'user-a', username: 'alice', tag: 'trial' });
    await recordDevice(guard,
      { id: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
    const row = db
      .prepare<[string], { user_uuid: string }>(
        'SELECT user_uuid FROM trial_hwids WHERE hwid = ?',
      )
      .get('hwid-aaa');
    expect(row?.user_uuid).toBe('user-a');
  });

  it('is idempotent when the same user re-adds the same hwid', async () => {
    guard.onUserCreated({ id: '101', username: 'alice', tag: 'trial' });
    await recordDevice(guard,
      { id: '101', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await recordDevice(guard,
      { id: '101', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
    const count = db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM abuse_log')
      .get();
    expect(count?.c).toBe(0);
  });

  it('disables a second trial user reusing the same hwid', async () => {
    guard.onUserCreated({ id: 'user-a', username: 'alice', tag: 'trial' });
    guard.onUserCreated({ id: 'user-b', username: 'bob', tag: 'trial' });
    await recordDevice(guard,
      { id: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await recordDevice(guard,
      { id: 'user-b', username: 'bob', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).toHaveBeenCalledOnce();
    expect(client.disableUser).toHaveBeenCalledWith('user-b');
    const log = db
      .prepare<[], AbuseRow>(
        'SELECT hwid, offender_uuid, original_uuid, disable_status FROM abuse_log',
      )
      .all();
    expect(log).toEqual([
      {
        hwid: 'hwid-aaa',
        offender_uuid: 'user-b',
        original_uuid: 'user-a',
        disable_status: 'success',
      },
    ]);
  });

  it('preserves a legacy device owner and only disables a provably newer trial user', async () => {
    const device = { hwid: 'hwid-legacy' };
    db.prepare('INSERT INTO trial_hwids(hwid, user_uuid, first_seen_at) VALUES (?, ?, ?)').run(
      device.hwid,
      'old-owner-uuid',
      Date.parse('2026-10-01T11:00:00.000Z'),
    );

    const returningUser = {
      id: '101',
      username: 'alice',
      tag: 'trial',
      createdAt: '2026-10-01T10:59:00.000Z',
    };
    const unknownUser = { id: '102', username: 'bob', tag: 'trial' };
    await recordDevice(guard, returningUser, device);
    await recordDevice(guard, unknownUser, device);
    expect(client.disableUser).not.toHaveBeenCalled();

    const newerUser = {
      id: '103',
      username: 'carol',
      tag: 'trial',
      createdAt: '2026-10-01T11:01:00.000Z',
    };
    await recordDevice(guard, newerUser, device);

    expect(client.disableUser).toHaveBeenCalledOnce();
    expect(client.disableUser).toHaveBeenCalledWith('103');
    expect(db.prepare('SELECT user_uuid FROM trial_hwids WHERE hwid = ?').get(device.hwid))
      .toEqual({ user_uuid: 'old-owner-uuid' });
  });

  it('does not disable when the offender has a non-trial tag', async () => {
    guard.onUserCreated({ id: 'user-a', username: 'alice', tag: 'trial' });
    await recordDevice(guard,
      { id: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await recordDevice(guard,
      { id: 'user-paid', username: 'paid', tag: 'paid' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
  });

  it('logs abuse but does not call API when dryRun is true', async () => {
    const dryGuard = new TrialGuard({
      db,
      logger,
      trialTags: ['trial'],
      dryRun: true,
    });
    await recordDevice(dryGuard,
      { id: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await recordDevice(dryGuard,
      { id: 'user-b', username: 'bob', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
    const status = db
      .prepare<[], { disable_status: string }>('SELECT disable_status FROM abuse_log')
      .get();
    expect(status?.disable_status).toBe('skipped_dry_run');
  });

  it('records an unexpected error for review', async () => {
    client.disableUser = vi.fn().mockRejectedValue(new Error('boom'));
    await recordDevice(guard,
      { id: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await recordDevice(guard,
      { id: 'user-b', username: 'bob', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    const status = db
      .prepare<[], { disable_status: string }>('SELECT disable_status FROM abuse_log')
      .get();
    expect(status?.disable_status).toBe('review');
  });
});
