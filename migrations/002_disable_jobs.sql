CREATE TABLE IF NOT EXISTS disable_jobs (
  event_key       TEXT PRIMARY KEY,
  hwid            TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  tag             TEXT NOT NULL,
  detected_at     INTEGER NOT NULL,
  state           TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_disable_jobs_due ON disable_jobs(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_disable_jobs_user ON disable_jobs(user_id, state);

-- Older failures have no delivery key. Import the latest unresolved failure for each owner and offender pair once.
INSERT INTO disable_jobs(event_key, hwid, user_id, owner_id, tag, detected_at, state, last_error)
SELECT 'audit:' || a.id, a.hwid, a.offender_uuid, a.original_uuid, a.offender_tag, a.detected_at,
       CASE WHEN a.offender_uuid GLOB '*[^0-9]*' THEN 'review' ELSE 'pending' END,
       CASE WHEN a.offender_uuid GLOB '*[^0-9]*' THEN 'unverified_legacy_identity' END
FROM abuse_log a
JOIN (
  SELECT MAX(id) AS latest FROM abuse_log
  WHERE disable_status IN ('failed', 'success', 'already_disabled')
  GROUP BY hwid, offender_uuid, original_uuid
) latest ON latest.latest = a.id
WHERE a.disable_status = 'failed'
ON CONFLICT(event_key) DO NOTHING;
