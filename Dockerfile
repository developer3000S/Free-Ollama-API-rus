# Multi-stage Dockerfile for Free Ollama API Gateway
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./
RUN npm install

# Copy source code and build
COPY tsconfig.json server.ts ./
COPY src ./src
COPY public ./public
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled bundle and static assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY config.example.yaml ./config.yaml

# Create non-root user for security
RUN addgroup -S foa && adduser -S foa -G foa && chown -R foa:foa /app
USER foa

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/healthz || exit 1

CMD ["npm", "start"]
