# Установка на тот же VPS, что и панель Remnawave

Самый простой и безопасный сценарий: anti-abuse работает в той же Docker-сети,
что и `remnawave`. Вебхуки ходят по внутренним именам контейнеров —
наружу публиковать порт **не нужно**, TLS не требуется.

## 0. Предусловия

- Панель Remnawave уже развёрнута через `docker compose`
  (контейнер обычно называется `remnawave`, сеть — `remnawave-network`).
- В панели **включён** HWID Device Limit
  (Subscription → Settings → HWID Device Limit). Без него вебхук
  `user_hwid_devices.added` не эмитится и сервис ничего не увидит.
- В панели создан Bearer API Token (Settings → API Tokens) — нужен для
  вызова `POST /api/users/{uuid}/actions/disable`.

## 1. Клонируем репозиторий

```bash
cd /opt
git clone https://github.com/Gickrede-e/remna-anti-abuse.git
cd remna-anti-abuse
```

## 2. Узнаём имя docker-сети панели

```bash
docker network ls | grep remna
```

Запомните имя сети (обычно `remnawave-network` или `remna_default`). Дальше
оно понадобится в `docker-compose.yml`.

## 3. Готовим `.env`

```bash
cp .env.example .env
nano .env
```

Заполните минимум эти переменные:

```env
# Внутри контейнера слушаем 3000, наружу не публикуем
PORT=3000
HOST=0.0.0.0
DB_PATH=/data/anti-abuse.sqlite

# URL панели по имени её контейнера во внутренней сети
REMNAWAVE_BASE_URL=http://remnawave:3000
REMNAWAVE_API_TOKEN=eyJhbGciOi...   # из Settings → API Tokens

# Любая длинная случайная строка. Совпадает с тем, что введём в UI Webhooks
WEBHOOK_SECRET=$(openssl rand -hex 32)

TRIAL_TAGS=trial            # совпадает с тегом, который вы ставите trial-юзерам
DRY_RUN=true                # рекомендуется для первой обкатки
LOG_LEVEL=info
```

> Если контейнер панели называется иначе — поправьте `REMNAWAVE_BASE_URL`.
> Узнать: `docker inspect <container> | grep -i name`.

## 4. Подключаем к сети панели

Откройте `docker-compose.yml` в корне репо и добавьте раздел `networks`:

```yaml
services:
  anti-abuse:
    build: .
    image: remna-anti-abuse:latest
    container_name: remna-anti-abuse
    restart: unless-stopped
    env_file:
      - .env
    # порт наружу НЕ публикуем — общаемся только через docker-сеть
    volumes:
      - anti-abuse-data:/data
    networks:
      - remnawave-network        # <- замените на имя сети из шага 2
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  anti-abuse-data:

networks:
  remnawave-network:
    external: true
```

> Используем именованный docker-volume, а не bind-mount: так SQLite-файл
> хранится в `/var/lib/docker/volumes/...` с правильными правами
> (UID 1000, как `node` внутри контейнера). Если использовать `./data:/data`,
> Docker создаёт хостовую папку под root, а контейнер не сможет в неё писать —
> увидите `EACCES: permission denied, mkdir '/data'`.

Удалите строки `ports:` целиком (или оставьте, если хотите проверять `/health`
с хоста).

## 5. Запускаем

```bash
docker compose up -d --build
docker compose logs -f anti-abuse
```

Должно появиться:
```
INFO: starting anti-abuse service
INFO: Server listening at http://0.0.0.0:3000
```

Из контейнера панели сервис теперь доступен как `http://remna-anti-abuse:3000`.

## 6. Прописываем вебхук в панели

В UI панели: **Settings → Webhooks → Add webhook**

- **URL:** `http://remna-anti-abuse:3000/webhook`
- **Secret:** значение `WEBHOOK_SECRET` из `.env`
- **Scopes:** включить `user` и `user_hwid_devices` (минимум). Можно подписаться
  только на `user.created`, `user.deleted`, `user_hwid_devices.added`.

Сохранить → нажать **Test** в UI. В логах anti-abuse должно появиться
`incoming request POST /webhook` с ответом 200 (после правильной подписи) или
сообщение о валидации схемы — это нормально, тест-payload в UI не всегда
совпадает с реальным.

## 7. Проверяем end-to-end

1. В панели создайте trial-юзера с `tag=trial`. В логах:
   `trial user registered { uuid: ..., tag: 'trial' }`.
2. На любом устройстве откройте subscription URL этого юзера так, чтобы клиент
   передал заголовок `x-hwid` (Happ, Hiddify, FlClash и т. п.). В логах:
   `trial hwid recorded as first owner`.
3. Создайте второго trial-юзера, откройте subscription URL **на том же
   устройстве**. В логах: `abuse detected (DRY_RUN — disable skipped)`.
   В панели в таблице юзеров второй юзер пока активен (DRY_RUN).
4. Когда убедились, что детект работает — `DRY_RUN=false` в `.env`,
   `docker compose up -d` для перезапуска. Теперь второй trial будет
   автоматически выключаться (`DISABLED` в панели).

## 8. Полезные команды

Запуск sqlite-команд в контейнере (alpine-образ его не содержит) — через одноразовый
контейнер, который монтирует тот же volume:

```bash
# свежий лог инцидентов
docker run --rm -v remna-anti-abuse_anti-abuse-data:/data keinos/sqlite3 \
  sqlite3 /data/anti-abuse.sqlite \
  "SELECT datetime(detected_at/1000,'unixepoch'), hwid, offender_uuid, disable_status
   FROM abuse_log ORDER BY detected_at DESC LIMIT 20;"

# сколько trial-юзеров отслеживается
docker run --rm -v remna-anti-abuse_anti-abuse-data:/data keinos/sqlite3 \
  sqlite3 /data/anti-abuse.sqlite "SELECT COUNT(*) FROM trial_users;"

# забыть HWID (например, на запрос саппорта)
docker run --rm -v remna-anti-abuse_anti-abuse-data:/data keinos/sqlite3 \
  sqlite3 /data/anti-abuse.sqlite "DELETE FROM trial_hwids WHERE hwid='hwid-...';"
```

> Имя volume складывается как `<projectname>_<volumename>`. Уточнить:
> `docker volume ls`.

## Откат

```bash
docker compose down
# вебхук в UI панели можно либо удалить, либо просто отключить

# полное удаление БД (необратимо!)
docker compose down -v
```

База живёт в named volume `anti-abuse-data` — переживает `docker compose down`
без флага `-v` и обновления через `git pull && docker compose up -d --build`.
