#!/usr/bin/env bash
set -e

echo "=== Free Ollama API Gateway: Docker Run Script ==="

# 1. Проверка и удаление старых образов проекта
echo "Checking for old Docker images..."
OLD_IMAGES=$(docker images -q free-ollama-api-gateway 2>/dev/null || true)
if [ -n "$OLD_IMAGES" ]; then
  echo "Found old images of free-ollama-api-gateway. Removing..."
  docker rmi -f $OLD_IMAGES || true
else
  echo "No old free-ollama-api-gateway images found."
fi

# Очистка dangling и композитных образов проекта
docker image prune -f --filter label=com.docker.compose.project=free-ollama-api-gateway 2>/dev/null || true

# 2. Сборка без использования кэша (--no-cache)
echo "Building Docker containers without cache (--no-cache)..."
docker compose build --no-cache

# 3. Запуск контейнеров в фоне
echo "Starting containers with docker compose up -d..."
docker compose up -d

echo "=== Gateway is running successfully! ==="
docker compose ps
