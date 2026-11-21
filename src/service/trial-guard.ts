import type { Database as DB } from 'better-sqlite3';
import type { Logger } from '../logger.js';

const NUMERIC_USER_ID = /^[1-9][0-9]*$/;

export interface TrialUser {
  id: string;
  createdAt?: string;
  username: string;
  tag: string | null;
}
export interface HwidDevice { hwid: string }

export interface TrialGuardOptions {
  db: DB;
  logger: Logger;
  trialTags: readonly string[];
  dryRun: boolean;
}

export interface TrialHwidRow {
  user_uuid: string;
  first_seen_at: number;
}

export function assessOwner(user: Pick<TrialUser, 'id' | 'createdAt'>, owner: TrialHwidRow) {
  if (owner.user_uuid === user.id) return 'same-user';
  if (NUMERIC_USER_ID.test(user.id) !== NUMERIC_USER_ID.test(owner.user_uuid)) {
    const createdAfterFirstUse = user.createdAt !== undefined && Date.parse(user.createdAt) > owner.first_seen_at;
    if (!createdAfterFirstUse) return 'unverified-owner';
  }
  return 'abuse';
}

export class TrialGuard {
  private readonly trialTags: ReadonlySet<string>;
  private readonly upsertTrialUser;
  private readonly deleteTrialUser;
  private readonly selectHwidOwner;
  private readonly insertHwid;
  private readonly enqueue;
  private readonly insertDryRunLog;

  constructor(private readonly opts: TrialGuardOptions) {
    this.trialTags = new Set(opts.trialTags);
    const db = opts.db;
    this.upsertTrialUser = db.prepare<[string, string, string, number]>(
      `INSERT INTO trial_users(user_uuid, tag, username, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_uuid) DO UPDATE SET tag = excluded.tag, username = excluded.username`,
    );
    this.deleteTrialUser = db.prepare<[string]>('DELETE FROM trial_users WHERE user_uuid = ?');
    this.selectHwidOwner = db.prepare<[string], TrialHwidRow>(
      'SELECT user_uuid, first_seen_at FROM trial_hwids WHERE hwid = ?',
    );
    this.insertHwid = db.prepare<[string, string, number]>(
      'INSERT INTO trial_hwids(hwid, user_uuid, first_seen_at) VALUES (?, ?, ?)',
    );
    this.enqueue = db.prepare(
      `INSERT INTO disable_jobs(event_key,hwid,user_id,owner_id,tag,detected_at,state,last_error)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`,
    );
    this.insertDryRunLog = db.prepare(
      `INSERT INTO abuse_log(detected_at,hwid,offender_uuid,offender_tag,original_uuid,disable_status)
       VALUES (?,?,?,?,?,'skipped_dry_run')`,
    );
  }

  isTrial(tag: string | null | undefined): tag is string {
    return typeof tag === 'string' && this.trialTags.has(tag);
  }

  onUserCreated(user: TrialUser): void {
    if (!this.isTrial(user.tag)) return;
    this.upsertTrialUser.run(user.id, user.tag, user.username, Date.now());
    this.opts.logger.info({ userId: user.id, tag: user.tag }, 'trial user registered');
  }

  onUserDeleted(userId: string): void {
    if (this.deleteTrialUser.run(userId).changes) {
      this.opts.logger.info({ userId }, 'trial user record removed');
    }
  }

  onHwidAdded(user: TrialUser, device: HwidDevice, deliveryKey: string): void {
    const { id, tag } = user;
    const { hwid } = device;
    if (!this.isTrial(tag)) {
      this.opts.logger.info({ userId: id, tag, hwid }, 'hwid event ignored: user tag is not in TRIAL_TAGS');
      return;
    }
    const now = Date.now();
    const outcome = this.opts.db.transaction(() => {
      const owner = this.selectHwidOwner.get(hwid);
      if (!owner) {
        this.insertHwid.run(hwid, id, now);
        return 'first';
      }
      const decision = assessOwner(user, owner);
      if (decision !== 'abuse') return decision;

      const dry = this.opts.dryRun;
      const result = this.enqueue.run(deliveryKey, hwid, id, owner.user_uuid, tag, now,
        dry ? 'skipped' : 'pending', dry ? 'dry_run' : null);
      if (!result.changes) return 'duplicate';
      if (dry) this.insertDryRunLog.run(now, hwid, id, tag, owner.user_uuid);
      return dry ? 'dry-run' : 'enqueued';
    }).immediate();
    const fields = { userId: id, hwid };
    if (outcome === 'first') this.opts.logger.info(fields, 'trial hwid recorded as first owner');
    else if (outcome === 'unverified-owner') this.opts.logger.warn(fields, 'trial device ownership is unverified');
    else if (outcome === 'enqueued') this.opts.logger.info({ eventKey: deliveryKey }, 'trial disable queued');
    else if (outcome === 'dry-run') this.opts.logger.warn(fields, 'abuse detected in dry run');
    else this.opts.logger.debug({ ...fields, outcome }, 'trial device already processed');
  }
}
