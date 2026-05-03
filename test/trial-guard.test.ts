import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import type { RemnawaveClient } from '../src/remnawave-client.js';
import { TrialGuard } from '../src/service/trial-guard.js';

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
  let client: { disableUser: ReturnType<typeof vi.fn> } & RemnawaveClient;
  let guard: TrialGuard;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trial-guard-'));
    db = openDatabase(join(dir, 'test.sqlite'));
    client = { disableUser: vi.fn().mockResolvedValue(undefined) };
    guard = new TrialGuard({
      db,
      client,
      logger,
      trialTags: ['trial', 'trial7d'],
      dryRun: false,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records trial users on user.created', () => {
    guard.onUserCreated({ uuid: 'user-a', username: 'alice', tag: 'trial' });
    const row = db
      .prepare<[string], { tag: string; username: string }>(
        'SELECT tag, username FROM trial_users WHERE user_uuid = ?',
      )
      .get('user-a');
    expect(row).toEqual({ tag: 'trial', username: 'alice' });
  });

  it('ignores users without a trial tag', () => {
    guard.onUserCreated({ uuid: 'user-paid', username: 'paid', tag: 'paid' });
    guard.onUserCreated({ uuid: 'user-null', username: 'nolan', tag: null });
    const count = db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM trial_users')
      .get();
    expect(count?.c).toBe(0);
  });

  it('records first hwid for a trial user without disabling anyone', async () => {
    guard.onUserCreated({ uuid: 'user-a', username: 'alice', tag: 'trial' });
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
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
    guard.onUserCreated({ uuid: 'user-a', username: 'alice', tag: 'trial' });
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
    const count = db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM abuse_log')
      .get();
    expect(count?.c).toBe(0);
  });

  it('disables a second trial user reusing the same hwid', async () => {
    guard.onUserCreated({ uuid: 'user-a', username: 'alice', tag: 'trial' });
    guard.onUserCreated({ uuid: 'user-b', username: 'bob', tag: 'trial' });
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await guard.onHwidAdded(
      { uuid: 'user-b', username: 'bob', tag: 'trial' },
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

  it('does not disable when the offender has a non-trial tag', async () => {
    guard.onUserCreated({ uuid: 'user-a', username: 'alice', tag: 'trial' });
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await guard.onHwidAdded(
      { uuid: 'user-paid', username: 'paid', tag: 'paid' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
  });

  it('logs abuse but does not call API when dryRun is true', async () => {
    const dryGuard = new TrialGuard({
      db,
      client,
      logger,
      trialTags: ['trial'],
      dryRun: true,
    });
    await dryGuard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await dryGuard.onHwidAdded(
      { uuid: 'user-b', username: 'bob', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    expect(client.disableUser).not.toHaveBeenCalled();
    const status = db
      .prepare<[], { disable_status: string }>('SELECT disable_status FROM abuse_log')
      .get();
    expect(status?.disable_status).toBe('skipped_dry_run');
  });

  it('records abuse with failed status when API rejects', async () => {
    client.disableUser = vi.fn().mockRejectedValue(new Error('boom'));
    await guard.onHwidAdded(
      { uuid: 'user-a', username: 'alice', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    await guard.onHwidAdded(
      { uuid: 'user-b', username: 'bob', tag: 'trial' },
      { hwid: 'hwid-aaa' },
    );
    const status = db
      .prepare<[], { disable_status: string }>('SELECT disable_status FROM abuse_log')
      .get();
    expect(status?.disable_status).toBe('failed');
  });
});
