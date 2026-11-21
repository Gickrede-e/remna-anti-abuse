import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Database as DB } from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { RemnawaveApiError, type PanelUser } from '../src/remnawave-client.js';
import { TrialGuard } from '../src/service/trial-guard.js';
import { DisableWorker } from '../src/service/disable-worker.js';

const logger = pino({ level: 'silent' });
const owner = { id: '10', tag: 'TRIAL', username: 'first' };
const second = { id: '11', tag: 'TRIAL', username: 'second', createdAt: '2026-01-02T00:00:00Z' };
const device = { hwid: 'test-device' };
const current: PanelUser = { ...second, deviceUserId: '11', status: 'ACTIVE' };
const association = { ...device, userId: '11', createdAt: '2026-01-03T00:00:00Z' };

describe('durable disable actions', () => {
  let dir: string;
  let db: DB;
  const client = {
    getUser: vi.fn(async () => ({ ...current })),
    getUserDevices: vi.fn(async () => [{ ...association }]),
    disableUser: vi.fn(async (_id: string) => {}),
  };
  const options = () => ({ db, logger, trialTags: ['TRIAL'], dryRun: false });
  const worker = () => new DisableWorker({ ...options(), client });
  const action = () => db.prepare('SELECT state,attempts,last_error FROM disable_jobs').get() as
    { state: string; attempts: number; last_error: string | null };
  async function enqueue() {
    const guard = new TrialGuard(options());
    await guard.onHwidAdded(owner, device, 'webhook:first');
    await guard.onHwidAdded(second, device, 'webhook:collision');
  }
  beforeEach(() => {
    vi.clearAllMocks();
    client.getUser.mockResolvedValue({ ...current });
    client.getUserDevices.mockResolvedValue([{ ...association }]);
    client.disableUser.mockResolvedValue(undefined);
    dir = mkdtempSync(join(tmpdir(), 'remna-disables-'));
    db = openDatabase(join(dir, 'test.sqlite'));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('recovers the queued action after a restart and deduplicates signed redelivery', async () => {
    await enqueue();
    expect(client.disableUser).not.toHaveBeenCalled();
    db.close();
    db = openDatabase(join(dir, 'test.sqlite'));
    await Promise.all([worker().runOne(), worker().runOne()]);
    await enqueue();
    await worker().runOne();
    expect(client.disableUser).toHaveBeenCalledExactlyOnceWith('11');
    expect(action()).toMatchObject({ state: 'success', attempts: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM disable_jobs').get()).toEqual({ n: 1 });
  });

  it('backs off on transient errors and checks a paid conversion before retrying', async () => {
    await enqueue();
    client.disableUser.mockRejectedValueOnce(new RemnawaveApiError('unavailable', 503, ''));
    await worker().runOne();
    expect(action()).toMatchObject({ state: 'retry', attempts: 1 });
    expect(await worker().runOne()).toBe(false);
    db.prepare('UPDATE disable_jobs SET next_attempt_at=0').run();
    client.getUser.mockResolvedValueOnce({ ...current, tag: 'PAID' });
    await worker().runOne();
    expect(action().state).toBe('skipped');
    expect(client.disableUser).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost response without issuing a second disable to an already disabled account', async () => {
    await enqueue();
    client.disableUser.mockRejectedValueOnce(new TypeError('network failure'));
    await worker().runOne();
    db.prepare('UPDATE disable_jobs SET next_attempt_at=0').run();
    client.getUser.mockResolvedValueOnce({ ...current, status: 'DISABLED' });
    await worker().runOne();
    expect(action().state).toBe('already_disabled');
    expect(client.disableUser).toHaveBeenCalledTimes(1);
  });

  it('skips removed devices and a new device association created after detection', async () => {
    await enqueue();
    client.getUserDevices.mockResolvedValueOnce([]);
    await worker().runOne();
    expect(action().state).toBe('skipped');
    db.prepare("UPDATE disable_jobs SET state='pending', next_attempt_at=0").run();
    client.getUserDevices.mockResolvedValueOnce([{ ...association, createdAt: '2099-01-01T00:00:00Z' }]);
    await worker().runOne();
    expect(action().state).toBe('skipped');
    expect(client.disableUser).not.toHaveBeenCalled();
  });

  it('sends authentication failures to review and leaves dry-run jobs untouched', async () => {
    await enqueue();
    expect(await new DisableWorker({ ...options(), dryRun: true, client }).runOne()).toBe(false);
    expect(action().attempts).toBe(0);
    client.getUserDevices.mockRejectedValueOnce(new RemnawaveApiError('forbidden', 403, ''));
    await worker().runOne();
    expect(action()).toMatchObject({ state: 'review', last_error: 'http_403' });
    expect(client.disableUser).not.toHaveBeenCalled();
  });

  it('honors a rate-limit delay and moves exhausted transient retries to review', async () => {
    await enqueue();
    const before = Date.now();
    client.getUserDevices.mockRejectedValueOnce(new RemnawaveApiError('limited', 429, '', 120_000));
    await worker().runOne();
    expect((db.prepare('SELECT next_attempt_at FROM disable_jobs').pluck().get() as number))
      .toBeGreaterThanOrEqual(before + 120_000);
    db.prepare('UPDATE disable_jobs SET attempts=4, next_attempt_at=0').run();
    client.getUser.mockRejectedValueOnce(new RemnawaveApiError('down', 503, ''));
    await worker().runOne();
    expect(action()).toMatchObject({ state: 'review', attempts: 5 });
  });

  it('rechecks first ownership and fails closed if ownership changed', async () => {
    await enqueue();
    db.prepare('UPDATE trial_hwids SET user_uuid=?').run('11');
    await worker().runOne();
    expect(action().state).toMatch(/skipped|review/);
    expect(client.disableUser).not.toHaveBeenCalled();
  });

  it('treats only the documented already-disabled response as settled', async () => {
    await enqueue();
    client.disableUser.mockRejectedValueOnce(new RemnawaveApiError('disabled', 400, '{"errorCode":"A029"}'));
    await worker().runOne();
    expect(action().state).toBe('already_disabled');
  });

  it('recovers an expired lease and ignores the result of a worker that lost its claim', async () => {
    await enqueue();
    db.prepare("UPDATE disable_jobs SET state='running', attempts=1, next_attempt_at=0").run();
    client.getUser.mockImplementationOnce(async () => {
      db.prepare("UPDATE disable_jobs SET attempts=3, next_attempt_at=?").run(Date.now() + 60_000);
      return { ...current };
    });
    await worker().runOne();
    expect(client.disableUser).not.toHaveBeenCalled();
    expect(action()).toMatchObject({ state: 'running', attempts: 3 });
    expect(db.prepare('SELECT count(*) AS n FROM abuse_log').get()).toEqual({ n: 0 });

    db.prepare('UPDATE disable_jobs SET next_attempt_at=0').run();
    await worker().runOne();
    expect(client.disableUser).toHaveBeenCalledExactlyOnceWith('11');
    expect(action().state).toBe('success');
  });

  it('imports one unresolved historical action once and preserves the original audit rows', () => {
    const audit = db.prepare('INSERT INTO abuse_log(detected_at,hwid,offender_uuid,offender_tag,original_uuid,disable_status) VALUES (1,?,?,?, ?,?)');
    for (const status of ['failed','failed']) audit.run('d1','old-id','TRIAL','old-owner',status);
    for (const status of ['failed','success']) audit.run('d2','recovered','TRIAL','old-owner',status);
    for (let i = 0; i < 2; i++) {
      db.close();
      db = openDatabase(join(dir, 'test.sqlite'));
    }
    expect(db.prepare('SELECT event_key,user_id FROM disable_jobs').all())
      .toEqual([{ event_key: 'audit:2', user_id: 'old-id' }]);
    expect(db.prepare('SELECT count(*) AS n FROM abuse_log').get()).toEqual({ n: 4 });
  });
});
