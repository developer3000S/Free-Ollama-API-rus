# Free Ollama API Gateway

Управляемый прокси-шлюз с Ollama-совместимым API поверх пула узлов Ollama,
владельцы которых явно подтвердили участие. Реализация технического задания
[`ТЗ.md`](ТЗ.md) (версия 1.0).

> **Статус сборки.** Текущий код — это Node.js/TypeScript-реализация
> (Express, `server.ts` + слои `src/db.ts` / `src/redis.ts`), сменившая
> первоначальный Python-вариант (коммит `4790479 build: migrate from Python to
> Node.js`). Реализованы пользовательский и OpenAI-совместимый контракты,
> административный API, прокси полного набора Ollama-эндпоинтов на выбранный
> узел (`/admin/nodes/:id/api/*`, `/v1/*`, `/proxy/*`), веб-панель и модуль
> discovery; состояние персистентно в **PostgreSQL**, оперативное — в **Redis**
> (оба опциональны: без них шлюз деградирует до in-memory режима с потерей
> данных при рестарте, см. раздел
> [PostgreSQL и Redis](#postgresql-и-redis)). Что именно
> реализовано, а что осталось на этапе прототипа — см. раздел
> [Статус реализации по ТЗ](#статус-реализации-по-тз) и
> [Ограничения](#ограничения-и-что-не-реализовано).
>
> **Ключевое положение (§1.1, §2.1, §19).** Шлюз не является «поисковиком
> бесплатных LLM». Пользовательский трафик уходит только на узлы, прошедшие
> подтверждение владения и активное согласие. Обнаруженные в интернете хосты
> Ollama становятся не узлами, а **кандидатами**: они не получают трафик никогда,
> пока владелец сам не зарегистрирует узел и не подтвердит владение (§4.4.4).

---

## Содержание

- [Что это и зачем](#что-это-и-зачем)
- [Быстрый старт](#быстрый-старт)
- [Варианты запуска сервера и подключения](#варианты-запуска-сервера-и-подключения)
- [Генерация и настройка SSL-сертификатов (SAN)](#генерация-и-настройка-ssl-сертификатов-san)
- [Настройка CORS для веб-разработки](#настройка-cors-для-веб-разработки)
- [Пользовательский API (Ollama-совместимый, `/api/*`)](#пользовательский-api-ollama-совместимый-api)
- [OpenAI-совместимый API (`/v1/*`)](#openai-совместимый-api-v1)
- [Веб-панель администратора](#веб-панель-администратора)
- [Административный API (`/admin/*`)](#административный-api-admin)
- [Discovery (§4)](#discovery-4)
- [Конфигурация](#конфигурация)
- [Наблюдаемость](#наблюдаемость)
- [PostgreSQL и Redis](#postgresql-и-redis)
- [Состояние и хранение данных](#состояние-и-хранение-данных)
- [Безопасность и этика](#безопасность-и-этика)
- [Сборка и качество](#сборка-и-качество)
- [Структура репозитория](#структура-репозитория)
- [Статус реализации по ТЗ](#статус-реализации-по-тз)
- [Ограничения и что не реализовано](#ограничения-и-что-не-реализовано)
- [Скрипт `update.sh`](#скрипт-updatesh)

---

## Что это и зачем

Три контура в одном процессе (§3.2):

| Контур | Кто им пользуется | Где реализован |
|---|---|---|
| Пользовательский Ollama-совместимый API | клиенты с ключами `foa_live_…` (выдаёт администратор) | `server.ts`, маршруты `/api/*` |
| OpenAI-совместимый API | клиенты, использующие SDK OpenAI | `server.ts`, маршруты `/v1/*` |
| Административный API + веб-панель | администратор, аудитор | `server.ts`, маршруты `/admin/*` + `public/index.html` |
| Служебный (health, ready, metrics, discovery) | балансировщики, Prometheus, фоновые задачи | `server.ts` + `deploy/` |

Пользователь шлюза видит обычный Ollama API и не знает (и не должен знать), какой
именно узел обработал запрос. Администратор управляет реестром узлов, согласиями,
блэклистом, ключами и кандидатами discovery через панель или REST API.

> При старте в пустой пул засеиваются узлы Ollama по умолчанию
> (`DEFAULT_OLLAMA_NODES`, переопределяются переменной `FOA_DEFAULT_NODES`).
> Удалить узлы можно запросом `POST /admin/demo/clear` (см.
> [Состояние и хранение](#состояние-и-хранение-данных)).

---

## Быстрый старт

### 1. Запуск в Docker (рекомендуется)

Полный стек: 2 реплики шлюза, Nginx (HTTP + TLS с поддержкой SAN), PostgreSQL,
Redis и Prometheus.

```bash
chmod +x docker-run.sh
./docker-run.sh
```

Скрипт `docker-run.sh`:
1. Создаст `.env` из `.env.example`, если его нет.
2. Проверит TLS-сертификат в `deploy/tls/` и перевыпустит его (с SAN для
   `147.45.125.8` и всех сетевых интерфейсов хоста), если сертификата нет или в
   нём нет нужного IP.
3. Удалит прежние образы `free-ollama-api-gateway` и пересоберёт стек
   (`docker compose build --no-cache`).
4. Поднимет сервисы (`docker compose up -d`) и выведет `docker compose ps`.

Эквивалент вручную:

```bash
cp .env.example .env    # заполните FOA_ADMIN_TOKEN, FOA_AUDITOR_TOKEN, POSTGRES_PASSWORD
npm install
docker compose build --no-cache
docker compose up -d
docker compose logs -f gateway-a
docker compose down
```

### 2. Прямой запуск без Docker (Node.js ≥ 18)

```bash
npm install        # зависимости из package.json (express, cors)
npm run build      # esbuild → dist/server.cjs
npm start          # node dist/server.cjs → http://localhost:3000
```

Для разработки с горячей перезагрузкой:

```bash
npm run dev        # tsx server.ts
```

### 3. Что доступно после запуска

| Адрес | Назначение |
|---|---|
| `GET /` , `/panel` | веб-панель администратора (React + Chart.js, см. [далее](#веб-панель-администратора)) |
| `GET /healthz` | процесс жив: `{"status":"ok","version":"1.0.0"}` |
| `GET /readyz` | готовность обслуживать: `{"status","routable_nodes","version"}`; `503`, если маршрутизируемых узлов 0 |
| `GET /metrics` | выгрузка Prometheus (см. [Наблюдаемость](#наблюдаемость)) |
| `GET /api/endpoints` | публичный список вариантов подключения (HTTPS + запасной HTTP) |
| `GET /api/tags` | агрегатный список моделей маршрутизируемых узлов |

---

## Варианты запуска сервера и подключения

### Таблица портов и сетевых интерфейсов

| Порт | Протокол | Сервис / назначение |
|---|---|---|
| **3000** | HTTP | Прямой доступ к шлюзу FOA (веб-панель + REST API) |
| **8080** | HTTP | Nginx Ingress балансировщик (чистый HTTP без шифрования) |
| **8443** | HTTPS | Nginx Ingress балансировщик с TLS-шифрованием |
| **9090** | HTTP | Метрики Prometheus (внутренняя сеть Docker) |

Порты ingress-балансировщика настраиваются переменными `FOA_HTTP_PORT` и
`FOA_HTTPS_PORT` (по умолчанию 8080 и 8443).

### Варианты выполнения запросов и работы с сертификатами

#### Способ 0: запросы по обычному HTTP (без SSL) — если программа ругается на сертификат
Шлюз принимает трафик не только по HTTPS, но и по обычному HTTP через тот же Nginx
балансировщик (порт 8080). Если ваша программа выдаёт ошибку сертификата при обращении
к `https://147.45.125.8:8443` (например, `DEPTH_ZERO_SELF_SIGNED_CERT`), используйте
`http://147.45.125.8:8080` — те же эндпоинты, тот же API-ключ, но без TLS:

```bash
export FREE_API_KEY="foa_live_xxxxxxxxxxxxxxxxxxxxxxxx"

curl -X POST http://147.45.125.8:8080/api/chat \
  -H "Authorization: Bearer $FREE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

Это рекомендуемый способ для клиентов, которые не дают доверять самоподписанному
сертификату (строгие SDK, Node.js `fetch`, мобильные приложения). Для OpenAI-совместимого
контракта базовый URL будет `http://147.45.125.8:8080/v1`.

#### Способ А: HTTPS с самоподписанным сертификатом (самый быстрый)
Используйте флаг `-k` (или `--insecure`) в `curl`, чтобы игнорировать проверку цепочки доверия самоподписанного сертификата:
```bash
export FREE_API_KEY="foa_live_xxxxxxxxxxxxxxxxxxxxxxxx"

curl -k -X POST https://147.45.125.8:8443/api/chat \
  -H "Authorization: Bearer $FREE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

#### Способ Б: HTTPS с проверкой доверенного сертификата (`--cacert`)
Шлюз генерирует сертификат с расширением Subject Alternative Names (SAN), в который включен IP-адрес сервера (`IP Address: 147.45.125.8`).

Если требуется перевыпустить сертификат для нового IP или домена:
```bash
./deploy/tls/generate-cert.sh 147.45.125.8
docker compose restart nginx
```
Выполнение запроса с указанием корневого сертификата шлюза:
```bash
curl --cacert deploy/tls/fullchain.pem -X POST https://147.45.125.8:8443/api/chat \
  -H "Authorization: Bearer $FREE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'
```

#### Способ В: установка сертификата в системное хранилище ОС
Чтобы утилита `curl`, браузеры и SDK доверяли сертификату по умолчанию без указания дополнительных флагов:

**В Ubuntu / Debian:**
```bash
sudo cp deploy/tls/fullchain.pem /usr/local/share/ca-certificates/foa-gateway.crt
sudo update-ca-certificates
```
После этого стандартный запрос по HTTPS работает без флагов:
```bash
curl -X POST https://147.45.125.8:8443/api/chat \
  -H "Authorization: Bearer $FREE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "Привет!"}]}'
```

**В Node.js (при разработке внешних ботов / бэкендов):**
```bash
export NODE_EXTRA_CA_CERTS="/path/to/deploy/tls/fullchain.pem"
```

**В Python (OpenAI SDK / LangChain / Requests):**
```bash
export REQUESTS_CA_BUNDLE="/path/to/deploy/tls/fullchain.pem"
export SSL_CERT_FILE="/path/to/deploy/tls/fullchain.pem"
```

#### Способ Г: запросы напрямую к порту шлюза (3000)
Если шифрование не требуется (локальная сеть, изолированный контур, разработка):
```bash
curl -X POST http://147.45.125.8:3000/api/chat \
  -H "Authorization: Bearer $FREE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "Привет!"}]}'
```

---

## Генерация и настройка SSL-сертификатов (SAN)

### 1. Причина ошибки `SSL: certificate subject name mismatch`

При обращении к шлюзу по HTTPS через утилиту `curl`, SDK или браузер вы можете столкнуться с ошибкой:
```text
curl: (60) SSL: certificate subject name 'localhost' does not match target hostname '147.45.125.8'
```

**Почему это происходит:**
В соответствии со стандартами безопасности RFC 2818 и RFC 5280, TLS-клиенты проверяют, что хост или IP-адрес, к которому выполняется подключение, строго указан в расширении **Subject Alternative Name (SAN)** сертификата (например, `IP Address: 147.45.125.8` или `DNS: api.example.com`).

Если сертификат был сгенерирован со стандартным `CN=localhost` без расширения SAN, клиент не может подтвердить принадлежность сертификата адресу `147.45.125.8` и прерывает соединение.

### 2. Быстрое устранение: автоматический скрипт перевыпуска

В проект встроен скрипт `deploy/tls/generate-cert.sh`, который автоматически определяет все внешние и локальные IP-адреса хоста и выпускает сертификат с корректными SAN:

```bash
# Выпуск сертификата с указанием вашего внешнего IP или домена:
./deploy/tls/generate-cert.sh 147.45.125.8

# Перезапуск Nginx для применения нового сертификата:
docker compose restart nginx
```

Скрипт выполняет следующие действия:
1. Создает файл конфигурации `deploy/tls/openssl.cnf` с расширением `v3_req` и секцией `[alt_names]`.
2. Добавляет в `subjectAltName` записи:
   - `DNS.1 = localhost`
   - `IP.1 = 127.0.0.1`
   - `IP.2 = 147.45.125.8` (и все сетевые интерфейсы хоста).
3. Генерирует закрытый ключ `deploy/tls/privkey.pem` и сертификат `deploy/tls/fullchain.pem` сроком действия на 365 дней.

### 3. Ручная генерация через OpenSSL (если нужно настроить вручную)

Если вам требуется выпустить сертификат вручную с индивидуальными доменными именами и IP-адресами:

1. **Создайте конфигурационный файл `deploy/tls/openssl.cnf`:**
   ```ini
   [req]
   distinguished_name = req_distinguished_name
   x509_extensions = v3_req
   prompt = no

   [req_distinguished_name]
   CN = 147.45.125.8

   [v3_req]
   keyUsage = keyEncipherment, dataEncipherment, digitalSignature
   extendedKeyUsage = serverAuth
   subjectAltName = @alt_names

   [alt_names]
   DNS.1 = localhost
   DNS.2 = api.ollama-gateway.local
   IP.1 = 127.0.0.1
   IP.2 = 147.45.125.8
   ```

2. **Выполните генерацию ключа и сертификата:**
   ```bash
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -config deploy/tls/openssl.cnf \
     -keyout deploy/tls/privkey.pem \
     -out deploy/tls/fullchain.pem
   ```

3. **Проверьте наличие расширения SAN в сгенерированном сертификате:**
   ```bash
   openssl x509 -in deploy/tls/fullchain.pem -text -noout | grep -A 2 "Subject Alternative Name"
   ```
   *Ожидаемый вывод:*
   ```text
   X509v3 Subject Alternative Name:
       DNS:localhost, DNS:api.ollama-gateway.local, IP Address:127.0.0.1, IP Address:147.45.125.8
   ```

### 4. Настройка доверия клиентов к самоподписанному сертификату

После генерации сертификата с SAN ошибка `subject name mismatch` устранена. Теперь клиент должен доверять самому центру сертификации (так как сертификат самоподписанный) — см. [способы 0/А/Б/В выше](#варианты-выполнения-запросов-и-работы-с-сертификатами).

---

## Настройка CORS для веб-разработки

Для удобной интеграции с фронтенд-приложениями (Vite, Next.js, Nuxt, React, Open WebUI, LibreChat) сервер шлюза поддерживает гибкую настройку разрешенных доменов через переменные окружения.

### 1. Переменная `CORS_ALLOWED_ORIGINS`

В файле `.env` задается список разрешенных адресов через запятую либо знак `*`:

```env
# Разрешить все источники (удобно для локальной разработки и тестов):
CORS_ALLOWED_ORIGINS=*

# Либо перечислить конкретные домены разработки и продакшена:
CORS_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,https://chat.mycompany.com
```

### 2. Возможности и поддерживаемые заголовки:
- **Поддержка wildcard поддоменов**: можно указывать маски вида `*.mycompany.com`.
- **Поддержка cookies и заголовков авторизации**: `credentials: true`.
- **Автоматическая обработка preflight-запросов**: HTTP `OPTIONS` с кодом 204.
- **Разрешенные методы**: `GET, POST, PUT, DELETE, OPTIONS, PATCH`.
- **Разрешенные заголовки**: `Content-Type, Authorization, X-Requested-With, Accept, Origin, X-Gateway-Key, Cache-Control, baggage, sentry-trace`.
- **Экспортируемые заголовки**: `Content-Length, Content-Range, Retry-After, X-Gateway-Node`.
- Запросы от не-браузерных клиентов (`curl`, серверные демоны, Python/Go скрипты без заголовка `Origin`) всегда пропускаются без блокировки.

---

## Пользовательский API (Ollama-совместимый, `/api/*`)

Ollama-совместимый контракт (§9.3). Базовый путь — корень (`/api/*`).

| Метод / путь | Назначение |
|---|---|
| `GET /api/version` | версия upstream-контракта Ollama: `{"version":"0.1.32"}` |
| `GET /api/endpoints` | публичный список вариантов подключения шлюза (HTTPS + запасной HTTP без SSL); аутентификации не требует |
| `GET /api/tags` | **агрегатный** список моделей по всем маршрутизируемым узлам (§9.3.2) |
| `POST /api/generate` | генерация по промпту, `stream: true` → NDJSON |
| `POST /api/chat` | чат, `stream: true` → NDJSON |
| `POST /api/embed` | эмбеддинги (демо-ответ: 128-мерные случайные векторы) |

**Аутентификация (§9.2).** Все эндпоинты, кроме `GET /api/endpoints`, требуют
заголовок `Authorization: Bearer <ключ>` с действующим ключом `foa_live_…`:
без ключа, с отозванным, просроченным или неизвестным ключом — `401`.
Ключ выдаёт администратор:

```bash
export FOA_ADMIN_TOKEN="foa-admin-secret"

KEY=$(curl -s -X POST http://127.0.0.1:3000/admin/keys \
  -H "Authorization: Bearer $FOA_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"demo","scopes":["ollama:read","ollama:generate"],"rate_limit_per_minute":60}' \
  | jq -r .api_key)

curl -s -X POST http://127.0.0.1:3000/api/chat \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"Привет"}],"stream":false}'
```

> Без PostgreSQL реестр ключей живёт в памяти и пустеет после рестарта — создайте
> ключ заново. При подключённом PG (`GATEWAY_DB_URL`) ключи сохраняются между
> перезапусками (в БД хранятся только их SHA-256 хэши).

**Маршрутизация.** Запрос выбирает узел с поддержкой запрошенной модели
(гибкое сопоставление тегов: `llama3` соответствует `llama3:8b`, `llama3:latest` и
т.п.) балансировщиком `selectNode`: least connections с учётом веса узла и
EWMA-задержки, узлы с открытым circuit breaker исключаются из выбора. Если модель
не поддерживает ни один узел — `503` со списком доступных моделей.

**Проксирование и fallback.** Шлюз проксирует запрос реальному узлу через
балансировщик (`selectNode`: вес + EWMA-задержка + least-connections + circuit
breaker) с ретраем на следующий узел (`routing.retry_attempts = 2`, таймаут
обращения к узлу — 120 с; ответ транслируется байт-в-байт, включая
NDJSON/SSE-стримы; заголовок `X-FOA-Gateway-Node` указывает выбранный узел).
Заглушка-ответ шлюза (`[Ответ шлюза FOA …]`) отдаётся только когда ни один
маршрутизируемый узел не ответил. При старте в пустой пул засеиваются узлы по
умолчанию (`DEFAULT_OLLAMA_NODES`); если в БД остались демо-узлы старых версий —
очистите их кнопкой «Очистить все данные» в разделе «Обнаружение»
(`POST /admin/demo/clear`).

> **Скоупы применяются** (§9.2): middleware `requireScopes` требует у ключа
> `ollama:read` для `/api/tags` и `/v1/models`, `ollama:generate` для генерации
> и чата, `ollama:embed` (или `ollama:generate`) для эмбеддингов; при отсутствии
> нужного скоупа шлюз отвечает `403`.

**Потоки.** При `stream: true` ответ отдаётся как NDJSON без буферизации.

---

## OpenAI-совместимый API (`/v1/*`)

Второй контракт поверх того же пула узлов (§18 п.1): для клиентов, использующих
SDK OpenAI / LangChain / Open WebUI.

| Эндпоинт | Назначение |
|---|---|
| `GET /v1/models` | список моделей маршрутизируемых узлов в формате OpenAI |
| `POST /v1/chat/completions` | чат-комплишены; `stream: true` → SSE `chat.completion.chunk` с `data: [DONE]` |

```bash
curl -s https://147.45.125.8:8443/v1/chat/completions \
  -H "Authorization: Bearer $FREE_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"Привет"}],"stream":true}'
```

> `/v1/chat/completions` проксируется OpenAI-совместимому пути выбранного узла
> (`/v1/chat/completions`) с ретраем на следующий узел; ответ транслируется как
> есть (JSON и SSE при `stream: true`). Симулированный ответ отдаётся только
> когда ни один узел не ответил. Формат ошибок — конверт OpenAI
> (`{"error": {"message","type"}}`), код 503 при отсутствии модели в пуле.

---

## Веб-панель администратора

SPA в `public/index.html` (React + Recharts + Chart.js + D3 + карта Leaflet),
раздаётся по адресам `/`, `/panel`, `/panel/*`. Вход — по токену администратора
или аудитора (форма логина, значение по умолчанию `foa-admin-secret`, хранится в
`sessionStorage`).

Разделы панели (`data-page`):

| Раздел | Назначение |
|---|---|
| `dashboard` | сводный статус: узлы по состояниям, маршрутизируемый пул, RPM |
| `nodes` | реестр узлов: добавление, challenge/верификация (auto/manual), блэклист, отзыв, удаление, метки |
| `monitor` | мониторинг: гистограмма распределения задержек по бакетам (`< 50ms` … `> 1500ms`), переключение «количество / проценты», детализация по узлам; интерактивная легенда (клик скрывает датасет, кнопка «Все/Ничего»), средняя задержка по выбранным узлам |
| `discovery` | источники, запуск цикла discovery, список кандидатов, enroll/verify, авто-верификация |
| `blacklist` | чёрный список узлов |
| `keys` | API-ключи: создание, отзыв, ротация |
| `audit` | журнал аудита |
| `config` | действующая конфигурация |
| `apidocs` | документация по эндпоинтам шлюза |
| `help` | руководство и FAQ: подключение, заголовок `Authorization: Bearer …`, готовые примеры (cURL, Python / OpenAI SDK / LangChain) для `/api/*` и `/v1/chat/completions`, разбор ошибок 401 / 503 / 404 / 429 / 504 и CORS |

> `public/panel.html` — устаревшая версия панели из предыдущей итерации проекта.
> Сервером она не раздаётся и оставлена только для истории; актуальная панель —
> `public/index.html`.

---

## Административный API (`/admin/*`)

Все эндпоинты требуют `Authorization: Bearer <FOA_ADMIN_TOKEN>` (или
`?token=…`). Токены аудитора (`FOA_AUDITOR_TOKEN`) и администратора
(`FOA_ADMIN_TOKEN`) равнозначны — разделения прав по скоупам пока нет.
Токен должен **точно совпадать** со значением из `.env`; при несовпадении —
`401`. Новые значения применяются без рестарта через
`POST /admin/config/reload` (он перечитывает `.env`).

> Обязательно задайте собственные `FOA_ADMIN_TOKEN` и `FOA_AUDITOR_TOKEN` в
> `.env` перед публикацией шлюза: значения по умолчанию
> (`foa-admin-secret` / `foa-auditor-secret`) широко известны.

### Узлы

| Метод / путь | Назначение |
|---|---|
| `GET /admin/nodes?detailed=true` | список узлов (+ распределение задержек при `detailed`) |
| `POST /admin/nodes` | регистрация узла (`endpoint` обязательно) → статус `pending_consent`, выдаёт `challenge` |
| `GET /admin/nodes/:id` | карточка узла |
| `GET /admin/nodes/:id/challenge` | данные challenge: well-known JSON + DNS TXT |
| `POST /admin/nodes/:id/challenge` | перевыпуск challenge |
| `POST /admin/nodes/:id/verify` | подтверждение владения (`mode: auto\|manual`): пробует прочитать `/api/tags` узла, переводит в `verified`/`routable` |
| `POST /admin/nodes/bulk-verify` | групповая верификация (`node_ids`, `mode`) |
| `POST /admin/nodes/:id/health-check` | проверка доступности узла (`/api/version` + обновление моделей из `/api/tags`; учитывает per-node флаг `insecure_tls`) |
| `POST /admin/nodes/bulk-health-check` | массовая перепроверка статусов: `{node_ids:[...]}` или `{all:true}`; параллельно (до 5 узлов), ответ `{checked, results:[{node_id,status,latency_ms,models,error}]}`. В панели — кнопка «🔄 Проверить статусы» (выбранные/все) |
| `GET /admin/nodes/:id/models` | список моделей узла (кэш `node.models`, при пустоте опрос `GET <endpoint>/api/tags` с обновлением кэша) — используется выпадающим списком в чате панели |
| `POST /admin/nodes/:id/chat` | чат с конкретным узлом в обход пользовательских ключей: тело `{messages:[...], model}` (или `{message}`), ответ `{reply, model, node_id}`; проксирует на `<endpoint>/api/chat`, таймаут 120 с. Используется панелью (админский Bearer-токен) |
| `POST /admin/nodes/:id/revoke` | отзыв согласия → узел исключается из маршрутизации |
| `POST /admin/nodes/:id/blacklist` | блокировка узла |
| `POST /admin/nodes/:id/unblacklist` | снятие блокировки |
| `DELETE /admin/nodes/:id` | удаление узла |
| `POST /admin/nodes/:id/labels` | управление метками |
| `GET /admin/nodes/:id/logs` | журнал событий узла |
| `GET /admin/nodes/metrics` | метрики по узлам: реальная история CPU/Mem (`metrics[].history[{time,cpu,memory}]`, `timestamps[]`, `interval_ms`, флаг `real` по узлу; источник — Ollama `GET /api/ps`, шаг сэмплинга 5 с, окно ~120 точек) |
| `GET /admin/nodes/latency-distribution` | распределение задержек по всем маршрутизируемым узлам |
| `GET /admin/nodes/:id/latency-distribution` | то же по одному узлу |

### Прокси Ollama API выбранного узла (панель / диагностика)

Полный набор эндпоинтов Ollama
([native API](https://docs.ollama.com/api/introduction),
[OpenAI-совместимость](https://docs.ollama.com/api/openai-compatibility))
доступен как прямой прокси на конкретный узел под админским Bearer-токеном.
Ответ — нативный JSON узла без изменений; заголовки `Content-Type` и тело
передаются как есть. Все маршруты наследуют per-node настройки TLS
(`insecure_tls`), пул соединений и автоматические повторы сетевых ошибок
(ECONNRESET/EPIPE). Таймауты: GET — 30 с, POST — 120 с (pull/push/generate
могут идти долго).

| Метод / путь шлюза | Путь Ollama на узле |
|---|---|
| `GET  /admin/nodes/:id/api/tags` | `/api/tags` — список моделей |
| `GET  /admin/nodes/:id/api/ps` | `/api/ps` — загруженные модели |
| `GET  /admin/nodes/:id/api/version` | `/api/version` |
| `GET  /admin/nodes/:id/api/show?model=…` или `/api/show/:model` | `/api/show` — детали модели |
| `GET  /admin/nodes/:id/api/usage` | `/api/usage` |
| `GET  /admin/nodes/:id/api/balance` | `/api/balance` |
| `POST /admin/nodes/:id/api/generate` | `/api/generate` |
| `POST /admin/nodes/:id/api/chat` | `/api/chat` |
| `POST /admin/nodes/:id/api/embed` | `/api/embed` — эмбеддинги |
| `POST /admin/nodes/:id/api/create` | `/api/create` — создание модели из Modelfile |
| `POST /admin/nodes/:id/api/copy` | `/api/copy` — копирование модели |
| `POST /admin/nodes/:id/api/pull` | `/api/pull` — загрузка модели (долгий запрос) |
| `POST /admin/nodes/:id/api/push` | `/api/push` — публикация модели (долгий запрос) |
| `POST /admin/nodes/:id/api/delete` (и `DELETE`) | `/api/delete` — удаление модели (Ollama ожидает POST; алиас `DELETE` добавлен для удобства UI) |
| `GET  /admin/nodes/:id/v1/models` | `/v1/models` — список моделей в формате OpenAI |
| `GET  /admin/nodes/:id/v1/models/:model` | `/v1/models/{model}` |
| `POST /admin/nodes/:id/v1/chat/completions` | `/v1/chat/completions` |
| `POST /admin/nodes/:id/v1/responses` | `/v1/responses` |
| `GET  /admin/nodes/:id/v1/systemone` | `/v1/systemone` |
| `ALL  /admin/nodes/:id/proxy/<путь>` | любой поддерживаемый путь Ollama (универсальный прокси) |
| `GET  /admin/ollama/endpoints` | машиночитаемая справка по всем маршрутам (для UI/автотестов) |

Примеры:

```bash
export FOA_ADMIN_TOKEN="foa-admin-secret"
NODE=node_5ff733a93d

# какие модели загружены в память узла
curl -s "http://localhost:8080/admin/nodes/$NODE/api/ps" \
  -H "Authorization: Bearer $FOA_ADMIN_TOKEN" | jq

# скачать модель на узел (долгий запрос, до 120 с)
curl -s -X POST "http://localhost:8080/admin/nodes/$NODE/api/pull" \
  -H "Authorization: Bearer $FOA_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"llama3:8b"}' | jq

# эмбеддинги через универсальный прокси
curl -s -X POST "http://localhost:8080/admin/nodes/$NODE/proxy/api/embed" \
  -H "Authorization: Bearer $FOA_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"nomic-embed-text","input":"привет"}' | jq
```

Ошибки сети проксирует расшифрованными: `DEPTH_ZERO_SELF_SIGNED_CERT` →
включите 🔓 «Доверять самоподписанному TLS» на карточке узла; `ECONNREFUSED` →
проверьте `OLLAMA_HOST=0.0.0.0` и файрвол; `ECONNRESET` повторяется
автоматически (разрыв keep-alive).

### Согласия, блэклист, ключи, аудит, конфигурация

| Метод / путь | Назначение |
|---|---|
| `GET /admin/consents`, `GET /admin/consents/:id` | реестр согласий (с историей событий) |
| `GET /admin/blacklist` | чёрный список |
| `GET /admin/keys` | список выпущенных ключей `foa_live_…` |
| `POST /admin/keys` | выпуск ключа (`label`, `scopes`, `rate_limit_per_minute`, `ttl_seconds`); полный ключ показывается один раз |
| `POST /admin/keys/:id/revoke` | отзыв ключа |
| `POST /admin/keys/:id/rotate` | ротация ключа (новый `foa_live_…`) |
| `GET /admin/audit?event=&subject_id=&limit=` | журнал аудита с фильтрами |
| `GET /admin/config` | действующая конфигурация (см. [Конфигурация](#конфигурация)) |
| `POST /admin/config/reload` | перечитать `.env` и зафиксировать событие в аудите |
| `POST /admin/config/toggle-auto-verify` | переключить авто-верификацию кандидатов |
| `POST /admin/demo/clear` | очистить все данные (узлы, кандидаты, согласия, блэклист) |

Пример:

```bash
export FOA_ADMIN_TOKEN="foa-admin-secret"

# Статус шлюза
curl -s -H "Authorization: Bearer $FOA_ADMIN_TOKEN" http://127.0.0.1:3000/admin/status | jq

# Выпуск ключа
curl -s -X POST http://127.0.0.1:3000/admin/keys \
  -H "Authorization: Bearer $FOA_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"demo","scopes":["ollama:read","ollama:generate"],"rate_limit_per_minute":60}' | jq
```

Прочие неизвестные пути под `/admin/*` → `501 {"error":"Not yet migrated in FOA Node.js gateway"}`.

---

## Discovery (§4)

Модуль discovery собирает **кандидатов** — потенциальные узлы Ollama — из внешних
платформ. Назначение модуля — инвентаризация, а не поиск бесплатных серверов:
кандидаты никогда не получают пользовательский трафик (флаг `routable: false`,
§4.4.4) и становятся узлами только после регистрации и подтверждения владения.

Поддерживаемые источники (опрашиваются только при наличии ключей в `.env`):

| Источник | Переменные окружения | Запрос |
|---|---|---|
| Censys | `CENSYS_API_TOKEN` (или `CENSYS_API_ID` + `CENSYS_API_SECRET`) | `services.port: 11434` |
| Shodan | `SHODAN_API_KEY` | `port:11434` |
| GreyNoise | `GREYNOISE_API_KEY` | `11434` (GNQL) |
| ZoomEye | `ZOOMEYE_API_KEY` | `port:11434` |
| Criminal IP | `CRIMINAL_IP_API_KEY` | `port:11434` |
| Natlas / Netlas | `NATLAS_API_ENDPOINT` + `NATLAS_API_KEY` (или `NETLAS_*`) | `port:11434` |

Эндпоинты:

| Метод / путь | Назначение |
|---|---|
| `GET /admin/discovery/sources` | состояние источников: настроен / не настроен |
| `POST /admin/discovery/run` | запустить цикл: опросить настроенные источники параллельно, дедуплицировать по `(ip, port, protocol)` (§4.4.2), сложить кандидатов в память |
| `GET /admin/candidates` | список кандидатов |
| `GET /admin/candidates/:id/challenge` | challenge для кандидата |
| `POST /admin/candidates/:id/enroll` | перевести кандидата в узел (`pending_consent`) |
| `POST /admin/candidates/:id/verify` | подтверждение владения кандидатом |
| `POST /admin/candidates/auto-verify-all` | авто-верификация всех кандидатов |
| `DELETE /admin/candidates` | очистить список кандидатов |
| `DELETE /admin/candidates/:id` | удалить одного кандидата |

Без ключей источников `POST /admin/discovery/run` завершится без ошибок, но и без
результатов — получите и настройте ключи в `.env`, затем перезапустите шлюз
(или `POST /admin/config/reload`).

---

## Конфигурация

Шлюз читает конфигурацию из `.env` (функция `reloadEnv()` в `server.ts`) —
YAML-файлы текущей Node.js-версией **не загружаются**; `config.example.yaml`
используется как справочник целевых параметров §13 и копируется в образ Docker
для документирования.

**Переменные, которые реально используются:**

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `3000` | порт HTTP-сервера шлюза |
| `GATEWAY_ID` | `foa-gw-main-01` | идентификатор инстанса |
| `FOA_ADMIN_TOKEN` | `foa-admin-secret` | токен администратора для `/admin/*` |
| `FOA_AUDITOR_TOKEN` | `foa-auditor-secret` | токен аудитора |
| `FOA_HTTP_PORT` | `8080` | публичный HTTP-порт nginx (для `/api/endpoints`) |
| `FOA_HTTPS_PORT` | `8443` | публичный HTTPS-порт nginx (для `/api/endpoints`) |
| `CORS_ALLOWED_ORIGINS` (или `CORS_ORIGIN`) | `*` | список разрешённых origin |
| `FOA_INSECURE_TLS` | `false` | глобальное доверие самоподписанным сертификатам узлов (`https://`-эндпоинты с просроченным/самоподписанным сертификатом; есть также per-node флаг `insecure_tls`) |
| `FOA_DEFAULT_NODES` | — | переопределение списка узлов Ollama по умолчанию (через запятую), засеиваемых при старте в пустой пул |
| Ключи discovery | — | `CENSYS_*`, `SHODAN_API_KEY`, `GREYNOISE_API_KEY`, `ZOOMEYE_API_KEY`, `CRIMINAL_IP_API_KEY`, `NATLAS_*` / `NETLAS_*` |

**Переменные хранилищ** (подробности — в разделе
[PostgreSQL и Redis](#postgresql-и-redis)): `GATEWAY_DB_URL` /
`FOA_STORAGE__DATABASE_URL` (PostgreSQL), `GATEWAY_REDIS_URL` /
`FOA_STORAGE__REDIS_URL` (Redis), `POSTGRES_PASSWORD` (используется только
docker-compose для контейнера postgres). Без них шлюз работает в in-memory режиме.

**Переменные из `.env.example`, зарезервированные под будущую реализацию**
(сейчас ни на что не влияют): `FOA_SERVER__*`,
`FOA_SECURITY__CLIENT_HASH_SALT`, `FOA_OBSERVABILITY__LOG_LEVEL`,
`FOA_OWNER_TOKEN`, `FOA_OWNER_REF`, `GATEWAY_JWT_SECRET`.

Рабочие параметры `security`, `limits`, `health`, `circuit_breaker` и
`discovery` заданы в объекте `currentConfig` в `server.ts` и отдаются через
`GET /admin/config`. Они соответствуют значениям ТЗ §13 (см.
[`config.example.yaml`](config.example.yaml)) и **применяются принудительно**:
лимиты пользовательского трафика проверяет middleware `applyLimits`, а circuit
breaker и EWMA-задержки участвуют в выборе узла балансировщиком (`selectNode`).
Единственное мягкое ограничение: `num_predict` / `max_tokens` выше
`max_num_predict` (2048) не отклоняются, а клампятся до лимита.

---

## Наблюдаемость

| Средство | Где |
|---|---|
| `GET /metrics` | выгрузка Prometheus: `foa_build_info`, `foa_nodes_routable`, `foa_nodes_blacklisted`, `foa_requests_total` |
| `GET /admin/status` | сводка по шлюзу: узлы по состояниям, размер пула, кандидаты, security/Discovery-параметры |
| `GET /admin/metrics/rpm` | история запросов в минуту за последний час (60 бакетов, агрегаты current/peak/avg/total) |
| Prometheus | [`deploy/prometheus.yml`](deploy/prometheus.yml) — скрейпинг шлюза |
| Grafana-дашборд | [`deploy/grafana-dashboard.json`](deploy/grafana-dashboard.json) |
| Nginx ingress | [`deploy/nginx.conf`](deploy/nginx.conf) — TLS, балансировка на 2 реплики |

Структурированный JSON-журнал из ТЗ (§12.5) реализован через `src/logger.ts`:
каждое событие — одна строка JSON в `stdout` (уровни debug/info/warn/error,
маскирование секретов — API-ключи `foa_live_…`, challenge-токены `foa_chk_…`,
пароли). Уровень задаётся переменными `loglevel` / `LOG_LEVEL` /
`FOA_OBSERVABILITY__LOG_LEVEL` (по умолчанию `info`).

---

## PostgreSQL и Redis

Шлюз использует два внешних хранилища (§14.1): **PostgreSQL** — источник правды
для долговременного состояния (узлы, согласия, блэклист, кандидаты, API-ключи,
аудит), **Redis** — раздельное оперативное состояние hot-path (лимиты, счётчики
параллельных запросов, RPM-история, реестр реплик, лидерские аренды). Оба слоя
**опциональны**: если хранилище не сконфигурировано или недоступно, шлюз
автоматически деградирует до in-memory режима и остаётся функциональным
(о фактическом режиме сообщает `GET /healthz` / `GET /readyz` — поля
`storage.postgres` и `storage.redis`: `connected` / `disabled`).

Код слоёв: [`src/db.ts`](src/db.ts) (драйвер `pg`) и [`src/redis.ts`](src/redis.ts)
(драйвер `ioredis`). Подключение обоих происходит в `bootstrap()` до начала
отдачи трафика.

### Конфигурация

| Хранилище | Переменные окружения (первый непустой выигрывает) | Значение в docker-compose |
|---|---|---|
| PostgreSQL | `FOA_STORAGE__DATABASE_URL`, `GATEWAY_DB_URL`, `DATABASE_URL` | `postgresql://foa:${POSTGRES_PASSWORD}@postgres:5432/foa` |
| Redis | `FOA_STORAGE__REDIS_URL`, `GATEWAY_REDIS_URL`, `REDIS_URL` | `redis://redis:6379/0` |

Схема создаётся автоматически при старте (`CREATE TABLE IF NOT EXISTS`),
отдельных миграций нет. URL в SQLAlchemy-стиле (`postgresql+asyncpg://…`)
нормализуются в `postgresql://`. В direct-режиме (без Docker) можно указать
в `.env` внешние `GATEWAY_DB_URL` / `GATEWAY_REDIS_URL` — тогда persistent-режим
работает и без compose-сервисов.

### PostgreSQL — источник правды с write-through кэшем

- **Модель хранения.** Каждая сущность лежит целиком в JSONB-колонке `data`;
  таблицы `nodes`, `api_keys`, `consents`, `blacklist`, `candidates` имеют
  одинаковую структуру (`id` + `data`) и обслуживаются generic-репозиторием
  `Store<T>` из `src/db.ts`. Отдельные выделенные колонки — только там, где
  нужен индекс или ограничение: `api_keys.key_hash` (UNIQUE),
  `consents.node_id` (NOT NULL + индекс), `audit_logs.created_at` (индекс).
- **Кэш в процессе.** Для быстрого чтения на hot-path (маршрутизация,
  аутентификация) каждый процесс держит `Map`-кэш. Чтение синхронное из кэша;
  запись сквозная (write-through): мутация обновляет кэш и сразу пишет в PG —
  ответ клиенту возвращается только после подтверждения записи.
- **Транзакции.** Многосущностные операции атомарны: регистрация узла вместе
  с согласием и записью аудита выполняется через `tx()` (BEGIN/COMMIT/ROLLBACK).
- **Синхронизация реплик через LISTEN/NOTIFY.** После коммита шлюз рассылает
  уведомление в канал `foa_changes` (`{table, from}`); все реплики подписаны
  выделенным `Client`-соединением и по уведомлению перечитывают изменённую
  таблицу. Уведомления коалесцируются (перезагрузка не чаще, чем раз в 200 мс
  на группу событий), а раз в 30 секунд идёт полная перезагрузка всех кэшей —
  страховка от потерянных NOTIFY и откатов транзакций.
- **Volatile-поля.** При перезагрузке кэша из PG сохраняются локальные поля,
  не имеющие смысла вне процесса: `active_connections` у узлов, `raw_key` и
  `last_used_at` у ключей.
- **Безопасность ключей.** Сырой API-ключ в PG не попадает: хранится только
  его SHA-256 (`key_hash`), аутентификация идёт по хэшу через O(1)-индекс в
  памяти и `findByField('key_hash', …)` при промахе кэша.
- **Аудит.** События пишутся в `audit_logs` best-effort (ошибка записи не
  роняет запрос); выборка — `GET /admin/audit` (фильтры по событию/субъекту).
- **Деградация.** Без URL или при недоступности PG (`initDb()` вернул `false`)
  `Store` молча работает как обычная `Map` — данные живут только в памяти
  процесса и теряются при рестарте.

### Redis — координация и лимиты hot-path

Все операции спроектированы так, что при недоступности Redis каждая из них
откатывается к эквивалентной in-memory реализации (local sliding window,
`Map`-счётчики, кольцевой буфер RPM).

- **Скользящее окно rate-limit (§12.4.1).** Реализовано Lua-скриптом на
  sorted set (`ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` + `PEXPIRE`), ключ
  `foa:rl:<scope>:<id>`. Атомарность скрипта исключает гонку «две реплики
  одновременно пропустили лимит». Применяется middleware `applyLimits` на
  пользовательских маршрутах: лимит на пользователя (60/мин), глобальный
  (1000/мин) и на модель (20/мин); при превышении — `429` с `Retry-After`.
  Скрипт кешируется через `SCRIPT LOAD`/`EVALSHA` с повторным `EVAL` на `NOSCRIPT`.
- **Счётчики параллельных запросов (§12.4.2).** Lua-скрипт `INCR` + `EXPIRE`
  с проверкой лимита (`foa:inflight:<scope>:<key>`), релиз — `DECR` с защитой
  от ухода в минус. TTL (60 с) сам обнуляет счётчик, если реплика упала, не
  отпустив соединение. Лимиты: 2 одновременных запроса и 2 стрима на
  пользователя.
- **RPM-история (60 минут).** Ключ `foa:rpm:<минута>` инкрементируется pipeline-ом
  на каждый запрос с TTL ~70 минут; чтение последних 60 бакетов одним pipeline.
  Питает `GET /admin/metrics/rpm` и график панели. В Redis история общая для
  всех реплик, в in-memory режиме — своя кольцевая на процесс.
- **Реестр живых реплик.** Каждая реплика при старте регистрирует ключ
  `foa:gw:<GATEWAY_ID>` с TTL 30 с (`registerGateway`); `/admin/status` может
  показать состав кластера.
- **Leader election для фоновых задач.** Фоновые циклы (liveness-обход узлов
  каждые 15 с, сэмплирование метрик, удаление кандидатов старше 90 дней)
  выполняются только лидером: аренда `foa:leader:scheduler` берётся через
  `SET NX EX` (TTL 20 с) и продлевается Lua-скриптом сравнением владельца.
  При падении лидера роль перехватывает другая реплика; без Redis единственная
  реплика считается лидером автоматически.

### Совместная работа в стеке Docker

В `docker-compose.yml` подняты сервисы `postgres` (volume для данных) и `redis`,
а обе реплики (`gateway-a`, `gateway-b`) получают `FOA_STORAGE__DATABASE_URL` и
`FOA_STORAGE__REDIS_URL`. В результате:

- реестр узлов, ключей и аудит едины для всех реплик (пишет любая, видят все);
- лимиты считаются глобально — пользователь не обойдёт RPM, раскидывая запросы
  по репликам через nginx;
- health-checks и сборщики метрик не дублируются (их делает только лидер).

При прямом запуске (`npm start` без переменных хранилищ) шлюз работает полностью
в памяти одного процесса: быстро для разработки, но состояние теряется при
рестарте и не разделяется между репликами.

---

## Состояние и хранение данных

- **PostgreSQL (при сконфигурированном `GATEWAY_DB_URL` /
  `FOA_STORAGE__DATABASE_URL`) — источник правды**: узлы, согласия, блэклист,
  кандидаты, API-ключи (только SHA-256 хэши) и аудит хранятся в таблицах с
  JSONB; поверх — write-through кэш процесса и синхронизация реплик через
  LISTEN/NOTIFY (подробности — в разделе [PostgreSQL и Redis](#postgresql-и-redis)).
- **Redis — оперативное состояние**: скользящие лимиты, счётчики параллельных
  запросов, RPM-история, реестр живых реплик и выборы лидера фоновых задач.
- **In-memory деградация**: без PG и Redis всё состояние живёт в `Map` процесса
  и сбрасывается при рестарте; режим виден в ответах `/healthz` и `/readyz`.
- **Сидинг пула**: при старте в пустой пул добавляются узлы Ollama по умолчанию
  (`DEFAULT_OLLAMA_NODES`, переопределяются переменной `FOA_DEFAULT_NODES`);
  повторный сидинг не происходит, если пул уже не пуст (проверяется и в кэше,
  и в PG). Текущий встроенный список (21 узел):

  ```text
  84.46.254.156    37.81.72.225     51.83.68.224     185.252.234.190
  223.166.61.215   62.16.190.89     82.156.119.114   43.136.169.150
  103.78.96.125    144.123.164.190  57.128.252.36    38.247.186.106
  51.222.46.203    81.0.249.47      159.195.53.125   89.58.29.165
  209.145.62.219   190.156.123.17   194.163.180.189  193.112.29.100
  173.224.115.253
  ```

  Каждому узлу сопоставляется эндпоинт `http://<IP>:11434` (порт Ollama; можно
  задать явно через `FOA_DEFAULT_NODES` в форме `ip:port` или полный URL).
- `POST /admin/demo/clear` очищает узлы, кандидаты, согласия и блэклист
  (аудит сохраняется).
- Две реплики `gateway-a` / `gateway-b` за nginx при активном PG+Redis работают
  как единый кластер: разделяемый реестр, общие лимиты, фоновые задачи — только
  на лидере.

---

## Безопасность и этика

Что есть в текущей версии:

- **Согласие как условие маршрутизации.** Узел попадает в пул (`routable: true`)
  только после `POST /admin/nodes/:id/verify` (или enroll + verify кандидата);
  кандидаты discovery принципиально `routable: false` (§4.4.4). Отзыв согласия
  (`POST /admin/nodes/:id/revoke`) исключает узел из маршрутизации.
- **Блэклист** — ручная блокировка узлов администратором.
- **Аудит** — регистрации ключевых операций (регистрация/верификация узлов,
  блокировки, выпуск/отзыв/ротация ключей, перезагрузка конфигурации, очистка
  данных).
- **CORS** — настраиваемый whitelist источников.
- **Лимиты применяются** middleware `applyLimits` на всех пользовательских
  маршрутах `/api/*` и `/v1/*`: размер тела (`413`, `max_request_bytes`), квоты
  payload (`400`), RPM пользователь/глобальный/на модель (`429` + `Retry-After` +
  заголовки `X-FOA-RateLimit-*`), параллельные запросы и стримы (`429`,
  `concurrent_limit`). Лимит генерации `max_num_predict` ограничивает значение в
  теле (клампит), а не отклоняет запрос.
- **Скоупы ключей** (§9.2) проверяются middleware `requireScopes`: `ollama:read`
  для `/api/tags` и `/v1/models`, `ollama:generate` для генерации/чата,
  `ollama:embed` (или `ollama:generate`) для эмбеддингов; при нехватке — `403`.
- **Этика §19.** Обнаруженные хосты не становятся узлами автоматически; трафик
  идёт только на явно подтверждённые узлы.

Чего пока нет (критично для любого публичного использования):

- **Секреты в `.env`** — не коммитятся (см. `.gitignore`); `update.sh` использует
  `git add .`, поэтому проверяйте `git status` перед коммитом.

---

## Сборка и качество

```bash
npm install            # установка зависимостей
npm run dev            # разработка: tsx server.ts
npm run build          # сборка: esbuild → dist/server.cjs
npm start              # запуск собранного бандла
npm run lint           # проверка типов: tsc --noEmit
npm test               # тесты: node:test + tsx (test/test.js)
npm run test:unit      # то же (e2e-набор на фейковом Ollama-узле)
```

Тесты: `npm test` запускает набор `test/test.js` (`node:test` + tsx, фейковый
Ollama-узел, без внешних хранилищ). На момент проверки: 4 из 8 тестов проходят;
4 e2e-теста падают из-за рассогласования формата ответов mock-узла с
passthrough-проксированием (тесты получают fallback-текст шлюза вместо ответа
узла) — требует актуализации моков или логики прокси.

---

## Структура репозитория

```
server.ts             вся логика шлюза (Express): пользовательский API, /v1/*, /admin/*, health/metrics
src/db.ts             слой PostgreSQL: generic write-through Store, LISTEN/NOTIFY, транзакции, аудит
src/redis.ts          слой Redis: Lua rate-limit/inflight, RPM-история, реестр реплик, leader election
src/balancer.ts       балансировщик: веса + EWMA-задержка + least-connections + circuit breaker
src/pool.ts           undici keep-alive пулы к узлам, TLS-fallback (FOA_INSECURE_TLS)
src/openai.ts         OpenAI-совместимые контракты
src/logger.ts         структурированное JSON-логирование, маскирование секретов
test/test.js          e2e-тесты (node:test + tsx, фейковый Ollama-узел)
public/index.html     веб-панель администратора (SPA)
public/panel.html     устаревшая версия панели (не раздаётся)
deploy/nginx.conf     ingress: TLS, балансировка на 2 реплики
deploy/prometheus.yml скрейпинг /metrics
deploy/grafana-dashboard.json  дашборд
deploy/tls/           generate-cert.sh, openssl.cnf, fullchain.pem, privkey.pem
docker-compose.yml    топология стека: 2 реплики шлюза, postgres, redis, prometheus, nginx
docker-run.sh         запуск стека одной командой (.env + TLS + сборка)
Dockerfile            multi-stage, node:20-alpine, non-root пользователь, HEALTHCHECK на /healthz
config.example.yaml   справочник параметров §13 (см. примечание в разделе «Конфигурация»)
.env.example          переменные окружения
update.sh             скрипт отправки изменений на GitHub
ТЗ.md                 техническое задание + статус реализации
```

---

## Статус реализации по ТЗ

Подробная разбивка по разделам ТЗ — в [`ТЗ.md`](ТЗ.md), §1.6
«Статус реализации». Кратко:

| Область ТЗ | Статус |
|---|---|
| Пользовательский Ollama API (§9) | реализовано: эндпоинты, аутентификация по Bearer-ключу, проверка скоупов (`requireScopes`), лимиты (`applyLimits`); запросы проксируются узлам через балансировщик с ретраем. Полный прокси нативного Ollama API на конкретный узел — в админ-контуре (`/admin/nodes/:id/api/*`, `/v1/*`, `/proxy/*`) |
| OpenAI-контракт (§18) | частично: `/v1/chat/completions` проксируется OpenAI-совместимому пути узлов (`/v1/chat/completions`) с passthrough-ответом и SSE; полноценный конвертер Ollama ↔ OpenAI (маппинг параметров, tool calls, `usage`) не реализован — при недоступности пула отдаётся симулированный ответ |
| Административный API (§9.6) | реализован (токен должен точно совпадать с `FOA_ADMIN_TOKEN`/`FOA_AUDITOR_TOKEN`; разделения скоупов админа/аудитора нет) |
| Владелец узла, CLI (§5) | частично: challenge/verify через админ-API; CLI `foa-owner` отсутствует |
| Discovery (§4) | реализован для источников с ключами (кандидаты в памяти) |
| Health-check (§6) | реализован: ручная проверка одного узла (`/admin/nodes/:id/health-check`), массовая перепроверка выбранных/всех узлов (`POST /admin/nodes/bulk-health-check`, кнопка «🔄 Проверить статусы» в панели) и автопериодический фоновый liveness-обход каждые 15 с (только на лидере, `startBackgroundLoops()`) |
| Балансировщик (§7) | реализован: веса, EWMA-штраф за задержку, circuit breaker, retry на следующий узел (§7.2–7.6) |
| Согласие, хранение, журналирование (§5, §12) | реализовано: PostgreSQL (JSONB + write-through кэш, LISTEN/NOTIFY), Redis-координация реплик; JSON-журнал — через `src/logger.ts` |
| Масштабирование, БД, Redis (§14) | реализовано: postgres/redis в compose подключены к шлюзу, общие лимиты и реестр для двух реплик, leader election фоновых задач (см. [PostgreSQL и Redis](#postgresql-и-redis)) |
| Тесты (§15) | частично: e2e-набор `test/test.js` есть (`npm test`); на момент проверки 4 из 8 тестов падают (mock-узлы рассогласованы с passthrough-проксированием) |

---

## Ограничения и что не реализовано

- **Состояние без внешних хранилищ**: при запуске без `GATEWAY_DB_URL` /
  `GATEWAY_REDIS_URL` (direct-режим) всё живёт в памяти процесса — рестарт
  сбрасывает состояние, реплики не разделяют реестр. В docker-compose оба
  хранилища подключены (см. [PostgreSQL и Redis](#postgresql-и-redis)).
- **Ответ `/api/generate` и `/api/chat`** — демо-заглушка, если ни один узел не
  ответил; обычный путь — реальное проксирование выбранному узлу с ретраем
  (пул при старте засеивается узлами по умолчанию). Для диагностики и прямого
  управления узлом используйте прокси `/admin/nodes/:id/...` (см. раздел «Прокси
  Ollama API выбранного узла»).
- **Полноценный конвертер Ollama ↔ OpenAI** (маппинг параметров, tool calls,
  `usage`, SSE из NDJSON) не реализован — `/v1/chat/completions` полагается на
  OpenAI-совместимость самого узла (Ollama ≥ 0.1.x).
- **CLI владельца узла `foa-owner`** отсутствует — все операции доступны через
  `/admin/*` и веб-панель.
- **`config.example.yaml`** не загружается приложением — это справочник целевых
  параметров §13.
- **Тесты неполные**: `npm run lint` ограничивается `tsc --noEmit`; в `npm test`
  4 из 8 e2e-тестов падают (формат ответов mock-узла vs passthrough-прокси).
- **Миграции БД** отсутствуют как отдельный инструмент — схема создаётся
  автоматически при старте (`CREATE TABLE IF NOT EXISTS` в `initDb()`).
- **`public/panel.html`** — устаревшая панель, сервером не раздаётся.
- **Vault/secret-refs**, сквозные трассировки (§11) — не реализованы.

---

## Скрипт `update.sh`

Для быстрой отправки изменений на GitHub:

```bash
chmod +x update.sh
./update.sh "Описание внесенных изменений"
```

Скрипт выполняет `git add .` → `git commit` → `git push origin main --no-thin`.
Перед запуском проверяйте `git status`: `git add .` добавит все новые файлы, а
`.env` исключается только благодаря `.gitignore` — случайно созданный секретный
файл вне правил игнорирования уйдёт в репозиторий.
