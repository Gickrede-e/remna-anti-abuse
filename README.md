# Remnawave anti-abuse service

External webhook receiver that prevents trial-tag users from re-registering on
the same device. The service tracks the first trial user per HWID and disables
any subsequent trial user that connects from a HWID already seen.

The Remnawave panel itself is not modified — this runs as a separate process
that consumes Remnawave webhooks and calls the public REST API.

## How it works

1. Remnawave fires `user.created` (scope `user`) when a user is created. If the
   user's `tag` is in `TRIAL_TAGS`, the service records the user as a tracked
   trial user.
2. Remnawave fires `user_hwid_devices.added` (scope `user_hwid_devices`) when a
   client first sends an `x-hwid` header on a subscription request — *only if
   HWID Device Limit is enabled in the panel*. The service:
   - records the (hwid → user_uuid) mapping the first time the HWID is seen for
     a trial user, or
   - calls `POST /api/users/{uuid}/actions/disable` if the same HWID already
     belongs to a different trial user, and writes a row to `abuse_log`.
3. `user.deleted` removes the record from `trial_users`. The HWID stays
   reserved permanently — that's the whole point of this service.

## Requirements

- Remnawave panel ≥ 2.7 with HWID Device Limit feature **enabled**
  (Subscription → Settings → HWID Device Limit). Without it the panel never
  emits `user_hwid_devices.added` and this service has nothing to act on.
- An API token from the panel (Settings → API Tokens).
- A reachable HTTP endpoint for the panel to post webhooks to.

## Configuration (`.env`)

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP port to listen on |
| `HOST` | no | `0.0.0.0` | Bind address |
| `DB_PATH` | no | `./data/anti-abuse.sqlite` | SQLite file location |
| `REMNAWAVE_BASE_URL` | yes | — | e.g. `https://panel.example.com` |
| `REMNAWAVE_API_TOKEN` | yes | — | Bearer token from the panel |
| `WEBHOOK_SECRET` | yes | — | Must match `WEBHOOK_SECRET_HEADER` in panel |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SEC` | no | `300` | Replay-protection window |
| `TRIAL_TAGS` | yes | — | Comma-separated whitelist of `tag` values |
| `DRY_RUN` | no | `false` | If `true`, abuse is logged but no API call is made |
| `LOG_LEVEL` | no | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` |

Copy `.env.example` to `.env` and fill in the values.

## Running with Docker (recommended)

```bash
cp .env.example .env
# edit .env
docker compose up -d
```

In the Remnawave UI:

1. Settings → Webhooks → add URL `http://anti-abuse:3000/webhook` (if compose
   networks are shared) or your reverse-proxied URL.
2. Set the webhook secret to the same value as `WEBHOOK_SECRET`.
3. Subscribe to scopes **`user`** and **`user_hwid_devices`** at minimum.

### Step-by-step VPS guides

- [Install on the same VPS as the panel](docs/install-same-vps.md) — простейший
  вариант, общая docker-сеть, без публичного порта и TLS.
- [Install on a separate VPS](docs/install-separate-vps.md) — отдельный сервер
  с публичным доменом, TLS через Caddy.

## Running locally

```bash
npm install
npm run build
node dist/main.js
```

Or in dev with auto-reload:

```bash
npm run dev
```

## Tests

```bash
npm test
```

Covers HMAC signature verification (5 cases), timestamp freshness (5 cases),
and the trial-guard state machine (8 cases) on an in-memory SQLite.

## Operational queries

```sql
-- abuse log, newest first
SELECT datetime(detected_at/1000, 'unixepoch') AS at, hwid, offender_uuid,
       original_uuid, disable_status
FROM abuse_log ORDER BY detected_at DESC LIMIT 50;

-- how many trial users per HWID (should be 1; >1 only if a row was orphaned)
SELECT user_uuid, COUNT(*) c FROM trial_hwids GROUP BY user_uuid ORDER BY c DESC;
```

## Troubleshooting

### `EACCES: permission denied, mkdir '/data'` (или `'./data'`)

The container process runs as the unprivileged `node` user (UID 1000). Two
common causes:

1. `DB_PATH` resolves to a relative path like `./data/...`, which lands in
   `/app/data` — `/app` belongs to root. Use the absolute path
   `/data/anti-abuse.sqlite` (default in `.env.example`).
2. The compose file used a bind-mount `./data:/data`. Docker creates the host
   folder owned by root, and the container can't write to it. The shipped
   `docker-compose.yml` uses a **named volume** (`anti-abuse-data:/data`)
   instead, which inherits container ownership.

If you're upgrading from an older version that used the bind-mount, after
`git pull` run:

```bash
docker compose down
docker compose up -d --build
```

To migrate existing data from `./data/` into the new named volume:

```bash
docker run --rm -v "$PWD/data":/from -v remna-anti-abuse_anti-abuse-data:/to \
  alpine sh -c 'cp -a /from/. /to/ && chown -R 1000:1000 /to'
```

## Security notes

- Webhook signature is verified with HMAC-SHA256 in constant time. Requests
  without a fresh `x-remnawave-timestamp` (within `WEBHOOK_TIMESTAMP_TOLERANCE_SEC`)
  are rejected with 401, blocking replay.
- The bearer API token is read from env only; it never leaves the process.
- Run behind a reverse proxy that terminates TLS — webhooks contain user UUIDs
  and HWIDs.
