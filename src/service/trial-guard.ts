import type { Database as DB } from 'better-sqlite3';
import type { Logger } from '../logger.js';
import type { RemnawaveClient } from '../remnawave-client.js';

export interface TrialUser {
  uuid: string;
  username: string;
  tag: string | null;
}

export interface HwidDevice {
  hwid: string;
}

export interface TrialGuardOptions {
  db: DB;
  client: RemnawaveClient;
  logger: Logger;
  trialTags: readonly string[];
  dryRun: boolean;
}

interface TrialHwidRow {
  user_uuid: string;
}

export class TrialGuard {
  private readonly trialTags: ReadonlySet<string>;
  private readonly upsertTrialUser;
  private readonly deleteTrialUser;
  private readonly selectHwidOwner;
  private readonly insertHwid;
  private readonly insertAbuseLog;

  constructor(private readonly opts: TrialGuardOptions) {
    this.trialTags = new Set(opts.trialTags);
    const db = opts.db;
    this.upsertTrialUser = db.prepare<[string, string, string, number]>(
      `INSERT INTO trial_users(user_uuid, tag, username, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_uuid) DO UPDATE SET
         tag = excluded.tag,
         username = excluded.username`,
    );
    this.deleteTrialUser = db.prepare<[string]>(
      `DELETE FROM trial_users WHERE user_uuid = ?`,
    );
    this.selectHwidOwner = db.prepare<[string], TrialHwidRow>(
      `SELECT user_uuid FROM trial_hwids WHERE hwid = ?`,
    );
    this.insertHwid = db.prepare<[string, string, number]>(
      `INSERT INTO trial_hwids(hwid, user_uuid, first_seen_at) VALUES (?, ?, ?)`,
    );
    this.insertAbuseLog = db.prepare<[number, string, string, string, string, string]>(
      `INSERT INTO abuse_log(detected_at, hwid, offender_uuid, offender_tag, original_uuid, disable_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  isTrial(tag: string | null | undefined): boolean {
    return typeof tag === 'string' && this.trialTags.has(tag);
  }

  onUserCreated(user: TrialUser): void {
    if (!this.isTrial(user.tag)) return;
    this.upsertTrialUser.run(user.uuid, user.tag as string, user.username, Date.now());
    this.opts.logger.info({ uuid: user.uuid, tag: user.tag }, 'trial user registered');
  }

  onUserDeleted(userUuid: string): void {
    const result = this.deleteTrialUser.run(userUuid);
    if (result.changes > 0) {
      this.opts.logger.info({ uuid: userUuid }, 'trial user record removed');
    }
  }

  async onHwidAdded(user: TrialUser, device: HwidDevice): Promise<void> {
    if (!this.isTrial(user.tag)) return;

    const decision = this.opts.db.transaction(() => {
      const existing = this.selectHwidOwner.get(device.hwid);
      if (!existing) {
        this.insertHwid.run(device.hwid, user.uuid, Date.now());
        return { kind: 'first' as const };
      }
      if (existing.user_uuid === user.uuid) {
        return { kind: 'same-user' as const };
      }
      return { kind: 'abuse' as const, originalUuid: existing.user_uuid };
    })();

    if (decision.kind === 'first') {
      this.opts.logger.info(
        { uuid: user.uuid, hwid: device.hwid },
        'trial hwid recorded as first owner',
      );
      return;
    }
    if (decision.kind === 'same-user') {
      this.opts.logger.debug(
        { uuid: user.uuid, hwid: device.hwid },
        'trial hwid already owned by same user',
      );
      return;
    }

    const tag = user.tag as string;
    if (this.opts.dryRun) {
      this.insertAbuseLog.run(
        Date.now(),
        device.hwid,
        user.uuid,
        tag,
        decision.originalUuid,
        'skipped_dry_run',
      );
      this.opts.logger.warn(
        {
          offender: user.uuid,
          original: decision.originalUuid,
          hwid: device.hwid,
        },
        'abuse detected (DRY_RUN — disable skipped)',
      );
      return;
    }

    let status = 'success';
    try {
      await this.opts.client.disableUser(user.uuid);
    } catch (err) {
      status = 'failed';
      this.opts.logger.error(
        { err, offender: user.uuid, hwid: device.hwid },
        'failed to disable abusive trial user',
      );
    }
    this.insertAbuseLog.run(
      Date.now(),
      device.hwid,
      user.uuid,
      tag,
      decision.originalUuid,
      status,
    );
    if (status === 'success') {
      this.opts.logger.warn(
        {
          offender: user.uuid,
          original: decision.originalUuid,
          hwid: device.hwid,
        },
        'abuse detected — offender disabled',
      );
    }
  }
}
