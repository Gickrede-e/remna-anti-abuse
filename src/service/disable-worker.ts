import type { Database as DB } from 'better-sqlite3';
import { RemnawaveApiError, type RemnawaveClient } from '../remnawave-client.js';
import { assessOwner, type TrialGuardOptions, type TrialHwidRow } from './trial-guard.js';

const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const LEASE_MS = 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

interface Job {
  event_key: string; user_id: string; owner_id: string; hwid: string; tag: string;
  attempts: number; detected_at: number;
}
type Outcome = { state: 'success' | 'already_disabled' | 'skipped' | 'review' | 'retry'; reason: string | null; retryAfter?: number };
type Client = Pick<RemnawaveClient, 'getUser' | 'getUserDevices' | 'disableUser'>;
interface WorkerOptions extends TrialGuardOptions { client: Client }

function afterError(err: unknown): Outcome {
  if (err instanceof RemnawaveApiError) {
    const reason = 'http_' + err.status;
    if (err.status === 404 && (err.errorCode === 'A025' || err.errorCode === 'A063')) {
      return { state: 'skipped', reason: 'user_missing' };
    }
    if ([408, 429].includes(err.status) || err.status >= 500) {
      return { state: 'retry', reason, retryAfter: err.retryAfterMs };
    }
    return { state: 'review', reason };
  }
  if (err instanceof TypeError || (err instanceof Error && ['AbortError', 'TimeoutError'].includes(err.name))) {
    return { state: 'retry', reason: 'network_error' };
  }
  return { state: 'review', reason: 'unexpected_panel_response' };
}

export class DisableWorker {
  private readonly claim;
  private readonly owner;
  private readonly ownsLease;
  private readonly update;
  private readonly audit;
  private readonly trialTags: ReadonlySet<string>;

  constructor(private readonly opts: WorkerOptions) {
    const db: DB = opts.db;
    this.trialTags = new Set(opts.trialTags);
    // The due time doubles as the lease expiry. A dead worker's next attempt always rechecks the panel.
    this.claim = db.prepare<[number, number, number], Job>(
      `UPDATE disable_jobs SET state='running', attempts=attempts+1, next_attempt_at=?
       WHERE event_key=(
         SELECT j.event_key FROM disable_jobs j
         WHERE j.state IN ('pending','retry','running') AND j.next_attempt_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM disable_jobs active WHERE active.user_id=j.user_id
               AND active.state='running' AND active.next_attempt_at > ?
           )
         ORDER BY j.next_attempt_at,j.detected_at,j.event_key LIMIT 1
       ) RETURNING event_key,user_id,owner_id,hwid,tag,attempts,detected_at`,
    );
    this.owner = db.prepare<[string], TrialHwidRow>('SELECT user_uuid,first_seen_at FROM trial_hwids WHERE hwid=?');
    this.ownsLease = db.prepare(`SELECT 1 FROM disable_jobs WHERE event_key=? AND state='running' AND attempts=? AND next_attempt_at>?`);
    this.update = db.prepare(
      `UPDATE disable_jobs SET state=?,last_error=?,next_attempt_at=?
       WHERE event_key=? AND state='running' AND attempts=?`,
    );
    this.audit = db.prepare(
      `INSERT INTO abuse_log(detected_at,hwid,offender_uuid,offender_tag,original_uuid,disable_status)
       VALUES(?,?,?,?,?,?)`,
    );
  }

  async runOne(): Promise<boolean> {
    if (this.opts.dryRun) return false;
    const now = Date.now();
    const job = this.claim.get(now + LEASE_MS, now, now);
    if (!job) return false;
    let outcome: Outcome;
    try {
      outcome = job.attempts <= MAX_ATTEMPTS ? await this.attempt(job) : { state: 'review', reason: 'attempt_limit' };
    } catch (err) {
      outcome = afterError(err);
    }

    let due = 0;
    if (outcome.state === 'retry') {
      const delay = Math.max(BACKOFF_MS[job.attempts - 1] ?? 0, outcome.retryAfter ?? 0);
      if (job.attempts >= MAX_ATTEMPTS || delay > MAX_RETRY_AFTER_MS) outcome = { ...outcome, state: 'review' };
      else due = Date.now() + delay;
    }
    const changed = this.opts.db.transaction(() => {
      const result = this.update.run(outcome.state, outcome.reason, due, job.event_key, job.attempts);
      if (result.changes) {
        this.audit.run(Date.now(), job.hwid, job.user_id, job.tag, job.owner_id, outcome.state);
      }
      return result.changes;
    }).immediate();
    if (changed) {
      const fields = { eventKey: job.event_key, attempts: job.attempts, state: outcome.state, reason: outcome.reason };
      if (outcome.state === 'review') this.opts.logger.error(fields, 'trial disable needs review');
      else if (outcome.state === 'retry') this.opts.logger.warn({ ...fields, nextAttemptAt: due }, 'trial disable will retry');
      else this.opts.logger.info(fields, 'trial disable settled');
    }
    return true;
  }

  private async attempt(job: Job): Promise<Outcome> {
    const { client } = this.opts;
    const devices = await client.getUserDevices(job.user_id);
    const user = await client.getUser(job.user_id);
    if (user.id !== job.user_id) return { state: 'review', reason: 'user_identity_mismatch' };
    if (user.status === 'DISABLED') return { state: 'already_disabled', reason: null };
    if (user.status !== 'ACTIVE' || !user.tag || !this.trialTags.has(user.tag)) {
      return { state: 'skipped', reason: 'not_an_active_trial' };
    }
    if (Date.parse(user.createdAt) > job.detected_at) return { state: 'skipped', reason: 'account_replaced' };
    const device = devices.find(d => d.hwid === job.hwid && (d.userId === user.deviceUserId || d.userId === user.id));
    if (!device || !(Date.parse(device.createdAt) <= job.detected_at)) {
      return { state: 'skipped', reason: 'device_removed_or_replaced' };
    }
    const owner = this.owner.get(job.hwid);
    if (!owner || owner.user_uuid !== job.owner_id || assessOwner(user, owner) !== 'abuse') {
      return { state: 'review', reason: 'owner_not_verified' };
    }
    if (!this.ownsLease.get(job.event_key, job.attempts, Date.now())) {
      return { state: 'retry', reason: 'lease_expired' };
    }
    try {
      await client.disableUser(job.user_id);
    } catch (err) {
      if (err instanceof RemnawaveApiError && err.status === 400 && err.errorCode === 'A029') {
        return { state: 'already_disabled', reason: null };
      }
      throw err;
    }
    return { state: 'success', reason: null };
  }
}
