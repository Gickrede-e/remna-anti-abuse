# Установка на отдельный VPS

Сценарий: панель Remnawave работает на одном сервере, anti-abuse — на другом.
Между ними HTTP/HTTPS через публичный домен. Главное отличие от установки
на тот же VPS — нужен **публичный URL с TLS**, потому что вебхуки и Bearer-
токен ходят по интернету.

## Архитектура

```
┌────────────────────┐                ┌──────────────────────────┐
│  VPS A (панель)    │  webhook POST  │   VPS B (anti-abuse)     │
│  panel.example.com │ ─────────────▶ │  abuse.example.com:443   │
│                    │ ◀───────────── │                          │
│  REST API          │   disable user │  Caddy → Fastify :3088   │
└────────────────────┘                │  SQLite в /opt/aa/data   │
                                       └──────────────────────────┘
```

## 0. Предусловия

- Чистый VPS под Ubuntu/Debian с публичным IP.
- Домен/субдомен (`abuse.example.com`), у которого A-запись указывает на этот
  VPS — нужен для TLS.
- На стороне панели:
  - Включён HWID Device Limit (Subscription → Settings).
  - Создан Bearer API Token (Settings → API Tokens). Скопируйте, он понадобится.
  - Известен публичный URL панели (`https://panel.example.com`) — anti-abuse
    будет ходить туда за `POST /api/users/{uuid}/actions/disable`.

## 1. Готовим VPS

```bash
ssh root@abuse.example.com
apt update && apt install -y docker.io docker-compose-plugin git ufw

# минимальный фаервол
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

## 2. Клонируем репозиторий

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/Gickrede-e/remna-anti-abuse.git
cd remna-anti-abuse
```

## 3. Готовим `.env`

```bash
cp .env.example .env
nano .env
```

```env
PORT=3088
HOST=0.0.0.0
DB_PATH=/data/anti-abuse.sqlite

# ПУБЛИЧНЫЙ URL панели — он на другом сервере
REMNAWAVE_BASE_URL=https://panel.example.com
REMNAWAVE_API_TOKEN=eyJhbGciOi...

# Сгенерируйте сильный секрет, его же впишем в UI панели
WEBHOOK_SECRET=$(openssl rand -hex 32)

# Защита от replay — оставляем 5 минут
WEBHOOK_TIMESTAMP_TOLERANCE_SEC=300

TRIAL_TAGS=trial
DRY_RUN=true
LOG_LEVEL=info
```

## 4. Поднимаем reverse proxy с TLS (Caddy)

Caddy сам получит и обновит сертификат от Let's Encrypt. Создайте
`/opt/remna-anti-abuse/Caddyfile`:

```caddyfile
abuse.example.com {
    encode gzip
    reverse_proxy anti-abuse:3088
}
```

И обновите `docker-compose.yml`, добавив сервис `caddy`:

```yaml
services:
  anti-abuse:
    build: .
    image: remna-anti-abuse:latest
    container_name: remna-anti-abuse
    restart: unless-stopped
    env_file:
      - .env
    expose:
      - "3088"            # только внутри docker-сети
    volumes:
      - anti-abuse-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3088/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:2-alpine
    container_name: remna-anti-abuse-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - anti-abuse

volumes:
  anti-abuse-data:
  caddy-data:
  caddy-config:
```

> SQLite живёт в named volume `anti-abuse-data`, а не в bind-mount `./data` —
> так контейнерный пользователь `node` получает корректные права. Если
> заменить на `./data:/data`, на старте получите
> `EACCES: permission denied, mkdir '/data'`.

> Если у вас уже есть nginx/traefik на этом VPS — поднимайте только
> сервис `anti-abuse` (без `ports:`) и проксируйте на него своим
> существующим reverse proxy. Главное, чтобы наружу был именно HTTPS.

## 5. Запускаем

```bash
cd /opt/remna-anti-abuse
docker compose up -d --build
docker compose logs -f
```

Дождитесь, пока Caddy получит сертификат (`certificate obtained successfully`).
Проверьте с любой машины:

```bash
curl https://abuse.example.com/health
# {"status":"ok"}
```

## 6. Прописываем вебхук в панели

На VPS A в UI панели → **Settings → Webhooks → Add webhook**:

- **URL:** `https://abuse.example.com/webhook`
- **Secret:** значение `WEBHOOK_SECRET` из `.env` на VPS B
- **Scopes:** `user` и `user_hwid_devices`

Сохранить → нажать **Test**. На VPS B в логах:
```
incoming request POST /webhook → 200/401
```

> Если приходит 401 «invalid signature» — проверьте, что секреты совпадают
> побайтно (без лишних пробелов/переводов строки).
> Если 401 «stale or missing timestamp» — у серверов разъехалось время.
> Сделайте `timedatectl set-ntp true` на обоих.

## 7. Проверяем end-to-end

1. На VPS A создаём trial-юзера → в логах VPS B:
   `trial user registered`.
2. С тестового устройства открываем subscription URL юзера →
   `trial hwid recorded as first owner`.
3. Создаём второго trial-юзера → открываем subscription URL **на том же
   устройстве** → `abuse detected (DRY_RUN — disable skipped)`.
4. Когда убедились, что детект работает: `DRY_RUN=false` в `.env`,
   `docker compose up -d`. Дальше нарушитель будет реально отключаться.

## 8. Что важно для прод-эксплуатации

- **Бэкап БД.** SQLite живёт в named volume `anti-abuse-data`. Бэкап:
  ```bash
  docker run --rm -v remna-anti-abuse_anti-abuse-data:/data alpine \
    tar czf - -C /data . > anti-abuse-$(date +%F).tar.gz
  ```
  И ежедневно сливать архив в S3/rsync.
- **Мониторинг.** `GET https://abuse.example.com/health` дёргайте из
  Uptime Kuma / любого пингера. Тревога — если 200 не отвечает.
- **Ограничение доступа.** Если хочется параноидальной защиты — закройте
  `abuse.example.com` фаерволом или Caddy-директивой `@allowed remote_ip ...`
  только до публичного IP панели. HMAC уже даёт криптостойкость, но это
  лишний слой.
- **Обновление:**
  ```bash
  cd /opt/remna-anti-abuse
  git pull
  docker compose up -d --build
  ```

## Откат

```bash
cd /opt/remna-anti-abuse
docker compose down
# в UI панели на VPS A удалите/выключите вебхук
```
