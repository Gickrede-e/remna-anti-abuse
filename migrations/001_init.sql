CREATE TABLE IF NOT EXISTS trial_users (
  user_uuid   TEXT PRIMARY KEY,
  tag         TEXT NOT NULL,
  username    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_hwids (
  hwid          TEXT PRIMARY KEY,
  user_uuid     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_hwids_user ON trial_hwids(user_uuid);

CREATE TABLE IF NOT EXISTS abuse_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at     INTEGER NOT NULL,
  hwid            TEXT NOT NULL,
  offender_uuid   TEXT NOT NULL,
  offender_tag    TEXT NOT NULL,
  original_uuid   TEXT NOT NULL,
  disable_status  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_log_offender ON abuse_log(offender_uuid);
