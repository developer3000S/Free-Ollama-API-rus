#!/usr/bin/env bash
set -e

echo "=== Free Ollama API Gateway: Docker Run Script ==="

# 1. Проверка наличия .env файла
if [ ! -f .env ]; then
  echo "Файл .env не найден. Создаю дефолтный .env из .env.example..."
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    cat << 'EOF' > .env
PORT=3000
GATEWAY_ID=foa-gw-main-01
FOA_ADMIN_TOKEN=foa-admin-secret
FOA_AUDITOR_TOKEN=foa-auditor-secret
FOA_SERVER__PORT=3000
FOA_SERVER__HOST=0.0.0.0
POSTGRES_PASSWORD=postgres_foa_password
GATEWAY_JWT_SECRET=foa-jwt-dev-secret-key
EOF
  fi
fi

# 2. Проверка TLS-сертификатов для Nginx
if [ ! -f deploy/tls/fullchain.pem ] || [ ! -f deploy/tls/privkey.pem ]; then
  echo "Генерация самоподписанного TLS-сертификата для Nginx с Subject Alternative Names (SAN)..."
  mkdir -p deploy/tls
  HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout deploy/tls/privkey.pem \
    -out deploy/tls/fullchain.pem \
    -subj "/CN=${HOST_IP:-localhost}" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${HOST_IP:-127.0.0.1}" 2>/dev/null || \
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout deploy/tls/privkey.pem \
    -out deploy/tls/fullchain.pem \
    -subj "/CN=localhost" 2>/dev/null || true
fi

# 3. Удаление старых зависших образов
echo "Проверка старых Docker образов..."
OLD_IMAGES=$(docker images -q free-ollama-api-gateway 2>/dev/null || true)
if [ -n "$OLD_IMAGES" ]; then
  echo "Удаление старых образов..."
  docker rmi -f $OLD_IMAGES 2>/dev/null || true
fi

# 4. Сборка контейнеров
echo "Сборка Docker-контейнеров..."
docker compose build --no-cache

# 5. Запуск
echo "Запуск сервисов..."
docker compose up -d

echo ""
echo "=== Сервисы успешно запущены! ==="
echo "Панель управления и API доступны по адресам:"
echo " - HTTP:  http://localhost:3000"
echo " - HTTPS: https://localhost:8443 (или порт из FOA_HTTPS_PORT)"
echo ""
docker compose ps
