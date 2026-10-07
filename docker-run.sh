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
REGEN_CERT=false
if [ ! -f deploy/tls/fullchain.pem ] || [ ! -f deploy/tls/privkey.pem ]; then
  REGEN_CERT=true
elif ! openssl x509 -in deploy/tls/fullchain.pem -text -noout 2>/dev/null | grep -q "147.45.125.8"; then
  echo "Текущий сертификат не содержит IP 147.45.125.8 в SAN. Перевыпускаю..."
  REGEN_CERT=true
fi

if [ "$REGEN_CERT" = "true" ]; then
  echo "Запуск генерации TLS-сертификата с SAN для 147.45.125.8..."
  chmod +x deploy/tls/generate-cert.sh 2>/dev/null || true
  ./deploy/tls/generate-cert.sh "147.45.125.8"
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
echo " - HTTP (через Nginx, без SSL):  http://localhost:8080 (или порт из FOA_HTTP_PORT)"
echo " - HTTPS: https://localhost:8443 (или порт из FOA_HTTPS_PORT)"
echo ""
docker compose ps
