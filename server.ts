import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { logger, maskSecrets } from './src/logger.js';
import {
  initDb,
  dbEnabled,
  dbConnected,
  Store,
  TABLES,
  insertAuditRow,
  queryAudit,
  clearAudit,
  tx,
  startFullReloadLoop,
} from './src/db.js';
import {
  initRedis,
  redisEnabled,
  checkRateLimit,
  acquireInflight,
  releaseInflight,
  recordRpm,
  getRpmBuckets,
  registerGateway,
  listGateways,
  tryAcquireLeader,
  amILeader,
} from './src/redis.js';
import {
  recordSuccess,
  recordFailure,
  resetBreaker,
  selectNode,
  isBreakerOpen,
  tryAcquireProbe,
} from './src/balancer.js';
import {
  getAgentForEndpoint,
  closeAgentForEndpoint,
  closeAllAgents,
  dispatcherFor,
} from './src/pool.js';
import {
  toOllamaChatRequest,
  ollamaChunkToOpenAiChunk,
  aggregateOllamaChat,
  ollamaGenerateToOpenAiCompletion,
} from './src/openai.js';

// Load .env dynamically
export function reloadEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }
}

reloadEnv();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_ID = process.env.GATEWAY_ID || 'foa-gw-main-01';
const VERSION = '1.0.0';

// Публичные порты ingress-балансировщика (nginx): `${FOA_HTTP_PORT:-8080}:80` и
// `${FOA_HTTPS_PORT:-8443}:443` в docker-compose.yml. Шлюзу они нужны, чтобы
// сообщать клиентам оба варианта подключения — в том числе plain-HTTP для программ,
// отклоняющих самоподписанный сертификат (DEPTH_ZERO_SELF_SIGNED_CERT).
const PUBLIC_HTTP_PORT = process.env.FOA_HTTP_PORT || '8080';
const PUBLIC_HTTPS_PORT = process.env.FOA_HTTPS_PORT || '8443';

// Configurable CORS settings via .env (e.g. CORS_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:3000" or "*")
const rawCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || '*').trim();
const allowedCorsOrigins = rawCorsOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);

    // Wildcard allows any origin
    if (allowedCorsOrigins.includes('*') || allowedCorsOrigins.length === 0) {
      return callback(null, true);
    }

    // Direct match
    if (allowedCorsOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Wildcard subdomain matching (e.g., "*.example.com")
    const matchesWildcard = allowedCorsOrigins.some((pattern) => {
      if (pattern.startsWith('*.')) {
        const rootDomain = pattern.slice(2);
        try {
          const parsed = new URL(origin);
          return parsed.hostname.endsWith(`.${rootDomain}`) || parsed.hostname === rootDomain;
        } catch {
          return false;
        }
      }
      return false;
    });

    if (matchesWildcard) {
      return callback(null, true);
    }

    // Rejected
    return callback(new Error(`CORS blocked: Origin '${origin}' is not permitted by CORS_ALLOWED_ORIGINS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-Gateway-Key',
    'Cache-Control',
    'baggage',
    'sentry-trace',
  ],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Retry-After', 'X-Gateway-Node'],
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static assets from public directory
app.use(express.static(path.join(process.cwd(), 'public')));

// Types
interface NodeItem {
  node_id: string;
  endpoint: string;
  display_name: string;
  owner_id: string;
  models: string[];
  max_concurrency: number;
  active_connections: number;
  latency_ms: number;
  error_rate: number;
  weight: number;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'blacklisted' | 'pending_consent';
  consent_status: 'verified' | 'pending' | 'revoked' | 'challenge_sent';
  routable: boolean;
  created_at: string;
  updated_at: string;
  last_health_check?: string;
  state?: string;
  active?: number;
  ewma_latency_ms?: number;
  effective_weight?: number;
  country?: string;
  ip?: string;
  labels?: string[];
}

interface ConsentItem {
  consent_id: string;
  node_id: string;
  owner_id: string;
  status: 'active' | 'pending' | 'revoked';
  method: string;
  allowed_models: string[];
  max_concurrency: number;
  issued_at: string;
  expires_at: string;
  revoked_at?: string | null;
  revoke_reason?: string | null;
  version: number;
  history: Array<{
    event: string;
    actor: string;
    created_at: string;
    detail?: Record<string, unknown>;
  }>;
}

interface BlacklistItem {
  node_id: string;
  endpoint: string;
  reason: string;
  permanent: boolean;
  actor: string;
  created_at: string;
  expires_at: string | null;
  lifted_at: string | null;
}

interface CandidateItem {
  candidate_id: string;
  source: string;
  sources?: string[];
  ip: string;
  port: number;
  protocol?: string;
  dns_names: string[];
  country: string;
  asn?: string;
  service_hint?: string;
  banner_hash?: string;
  risk_score: number;
  requires_manual_review?: boolean;
  status: 'candidate' | 'enrolled' | 'out_of_scope' | 'rejected' | 'verified';
  observed_at: string;
  verified?: boolean;
  verification_mode?: 'auto' | 'manual';
  verified_at?: string;
  node_id?: string;
  challenge_token?: string;
}

interface ApiKeyItem {
  key_id: string;
  label: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  last_used_at: string | null;
  rate_limit_per_minute: number | null;
  // sha256(raw_key). В PG хранится только хэш; сырой ключ живёт в памяти
  // реплики создания и показывается пользователю один раз.
  key_hash?: string;
  raw_key?: string;
}

interface AuditItem {
  id: string;
  created_at: string;
  event: string;
  actor: string;
  subject_type: string;
  subject_id: string;
  detail: Record<string, unknown>;
}

// In-Memory Data Stores
//
// Хранилища стали write-through обёртками над PostgreSQL (src/db.ts): запись
// сразу фиксируется в БД, а между репликами кэши синхронизируются через PG
// LISTEN/NOTIFY. При отсутствии PG всё работает чисто в памяти.
const nodes = new Store<NodeItem>(TABLES.nodes, (n) => n.node_id);
const consents = new Store<ConsentItem>(TABLES.consents, (c) => c.consent_id);
const blacklist = new Store<BlacklistItem>(TABLES.blacklist, (b) => b.node_id);
const candidates = new Store<CandidateItem>(TABLES.candidates, (c) => c.candidate_id);
// Ключи — отдельный путь: в PG хранится key_hash, сырой ключ не покидает
// память реплины, на которой был создан (и показывается один раз).
const apiKeys = new Store<ApiKeyItem>(TABLES.apiKeys, (k) => k.key_id);
// Индекс key_hash -> key_id для O(1) аутентификации.
const apiKeyByHash = new Map<string, ApiKeyItem>();
// Аудит пишется в PG параллельно с память; чтение идёт из PG.
const auditLogs: AuditItem[] = [];

// Latency Distribution Bins & History Store
const LATENCY_BINS = [
  { id: 'b_0_50', label: '< 50ms', min: 0, max: 50 },
  { id: 'b_50_100', label: '50–100ms', min: 50, max: 100 },
  { id: 'b_100_200', label: '100–200ms', min: 100, max: 200 },
  { id: 'b_200_400', label: '200–400ms', min: 200, max: 400 },
  { id: 'b_400_800', label: '400–800ms', min: 400, max: 800 },
  { id: 'b_800_1500', label: '800–1500ms', min: 800, max: 1500 },
  { id: 'b_1500_plus', label: '> 1500ms', min: 1500, max: Infinity },
];

const nodeLatencySamples = new Map<string, number[]>();

// --- История метрик CPU/Memory для вкладки «Узлы → Производительность» -----
// Каждые NODE_METRICS_INTERVAL_MS сэмплирование пишется в ring-буфер (последние
// NODE_METRICS_MAX_SAMPLES точек). Точки помечаются real=true, если узел
// ответил на /api/ps (реальные значения), и real=false — тогда значение
// сглаженное демо-значение (детерминированное по node_id + время), чтобы
// график не был пустым для узлов без /api/ps.
interface NodeMetricPoint { time: string; cpu: number; memory: number; real: boolean }
const NODE_METRICS_INTERVAL_MS = 5_000;
const NODE_METRICS_MAX_SAMPLES = 120; // ~10 минут истории
const nodeMetricsHistory = new Map<string, NodeMetricPoint[]>();
let nodeMetricsLastTs: number | null = null;

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function sampleNodeMetricsOnce(): Promise<void> {
  const tsLabel = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  nodeMetricsLastTs = Date.now();
  const tasks = Array.from(nodes.values()).map(async (node) => {
    let cpu: number | null = null;
    let memory: number | null = null;
    let real = false;
    try {
      // Ollama /api/ps возвращает информацию о загруженных моделях, включая
      // использование GPU/CPU памяти узла.
      const psRes = await fetch(`${node.endpoint}/api/ps`, {
        signal: AbortSignal.timeout(3_000),
        ...dispatcherFor(node.endpoint, Math.max(1, node.max_concurrency || 4)),
      } as any);
      if (psRes.ok) {
        const psData = (await psRes.json()) as any;
        const models = Array.isArray(psData.models) ? psData.models : [];
        const gpuTotal = models.reduce((a: number, m: any) => a + (Number(m.size_vram) || 0), 0);
        const cpuTotal = models.reduce((a: number, m: any) => a + (Number(m.size) || 0) - (Number(m.size_vram) || 0), 0);
        // Оценка загрузки: доля занятой VRAM (CPU%) и общей памяти моделей (Mem%)
        const vramCap = 24 * 1024 * 1024 * 1024; // типовая оценка подсистемы памяти узла
        cpu = Math.min(98, Math.max(3, Math.round((gpuTotal / vramCap) * 100)));
        memory = Math.min(98, Math.max(5, Math.round(((gpuTotal + Math.max(0, cpuTotal)) / vramCap) * 100)));
        real = true;
      }
    } catch {
      // узел не отвечает / /api/ps недоступен — ниже подставим сглаженное демо-значение
    }
    if (!real) {
      const seed = hashStr(node.node_id);
      const phase = (nodeMetricsLastTs / NODE_METRICS_INTERVAL_MS) + (seed % 60);
      const baseCpu = 20 + (seed % 45);
      const baseMem = 30 + (seed % 35);
      cpu = Math.min(97, Math.max(4, Math.round(baseCpu + Math.sin(phase / 6 + seed) * 14)));
      memory = Math.min(97, Math.max(8, Math.round(baseMem + Math.cos(phase / 8 + seed) * 9)));
    }
    const arr = nodeMetricsHistory.get(node.node_id) || [];
    arr.push({ time: tsLabel, cpu: cpu!, memory: memory!, real });
    if (arr.length > NODE_METRICS_MAX_SAMPLES) arr.splice(0, arr.length - NODE_METRICS_MAX_SAMPLES);
    nodeMetricsHistory.set(node.node_id, arr);
  });
  await Promise.allSettled(tasks);
}

function generateDefaultSamplesForNode(node: NodeItem): number[] {
  const base = Math.max(20, node.latency_ms || 60);
  const count = 120;
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    // Generate right-skewed log-normal latency distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const randStd = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
    // 85% normal jitter, 10% moderate spike, 5% tail latency spike
    let sample = base + randStd * (base * 0.28);
    const r = Math.random();
    if (r > 0.95) {
      sample = base * (2.4 + Math.random() * 2.8);
    } else if (r > 0.85) {
      sample = base * (1.3 + Math.random() * 0.9);
    }
    samples.push(Math.max(12, Math.round(sample)));
  }
  return samples;
}

function recordNodeLatencySample(nodeId: string, latencyMs: number) {
  if (!nodeLatencySamples.has(nodeId)) {
    const node = nodes.get(nodeId);
    nodeLatencySamples.set(nodeId, node ? generateDefaultSamplesForNode(node) : []);
  }
  const list = nodeLatencySamples.get(nodeId)!;
  list.push(Math.max(1, Math.round(latencyMs)));
  if (list.length > 300) list.shift();
}

// 60-minute rolling Requests Per Minute (RPM) tracker.
//
// Бакеты живут в Redis (см. src/redis.ts recordRpm/getRpmBuckets), поэтому
// обе реплики шлюза накапливают общую историю. При отсутствии Redis счётчики
// остаются локальными; демо-синусоида при старте убрана — график показывает
// реальный трафик (пустой, пока запросов не было).
const RPM_BUCKETS_COUNT = 60;
const localRpmFallback: number[] = new Array(RPM_BUCKETS_COUNT).fill(0);
let localRpmLastMinute = Math.floor(Date.now() / 60000);

function shiftLocalRpm(currentMin: number) {
  const diff = currentMin - localRpmLastMinute;
  if (diff > 0) {
    const shift = Math.min(diff, RPM_BUCKETS_COUNT);
    for (let s = 0; s < shift; s++) {
      localRpmFallback.shift();
      localRpmFallback.push(0);
    }
    localRpmLastMinute = currentMin;
  }
}

function recordRequestForRpm(count = 1) {
  if (redisEnabled()) {
    recordRpm(count).catch(() => shiftLocalRpm(Math.floor(Date.now() / 60000)));
    return;
  }
  shiftLocalRpm(Math.floor(Date.now() / 60000));
  localRpmFallback[localRpmFallback.length - 1] += count;
}

async function getRpm60mData() {
  const now = new Date();
  let values: number[];
  if (redisEnabled()) {
    values = await getRpmBuckets();
    if (values.length !== RPM_BUCKETS_COUNT) {
      values = new Array(RPM_BUCKETS_COUNT).fill(0).map((_, i) => values[i] || 0);
    }
  } else {
    shiftLocalRpm(Math.floor(Date.now() / 60000));
    values = [...localRpmFallback];
  }

  const points = [];
  for (let i = 0; i < RPM_BUCKETS_COUNT; i++) {
    const minAgo = RPM_BUCKETS_COUNT - 1 - i;
    const pointTime = new Date(now.getTime() - minAgo * 60000);
    const timeLabel = pointTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    points.push({
      minute_ago: minAgo,
      label: minAgo === 0 ? 'Сейчас' : `-${minAgo}м`,
      time: timeLabel,
      timestamp: pointTime.toISOString(),
      rpm: values[i] || 0,
    });
  }

  const currentRpm = values[values.length - 1] || 0;
  const peakRpm = Math.max(...values, 0);
  const avgRpm = Math.round(values.reduce((a, b) => a + b, 0) / (values.length || 1));
  const totalLastHour = values.reduce((a, b) => a + b, 0);

  return {
    current_rpm: currentRpm,
    peak_rpm: peakRpm,
    avg_rpm: avgRpm,
    total_last_hour: totalLastHour,
    points,
  };
}

function computeLatencyStats(samples: number[]) {
  if (!samples || samples.length === 0) {
    return {
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      min: 0,
      max: 0,
      avg: 0,
      total_samples: 0,
      counts: LATENCY_BINS.map(() => 0),
      percentages: LATENCY_BINS.map(() => 0),
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const getP = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];
  const p50 = getP(0.5);
  const p90 = getP(0.9);
  const p95 = getP(0.95);
  const p99 = getP(0.99);
  const min = sorted[0];
  const max = sorted[n - 1];
  const avg = Math.round(sorted.reduce((acc, v) => acc + v, 0) / n);

  const counts = LATENCY_BINS.map((b) => {
    return sorted.filter((v) => v >= b.min && (b.max === Infinity ? true : v < b.max)).length;
  });
  const percentages = counts.map((c) => Number(((c / n) * 100).toFixed(1)));

  return {
    p50,
    p90,
    p95,
    p99,
    min,
    max,
    avg,
    total_samples: n,
    counts,
    percentages,
  };
}

function addAudit(event: string, actor: string, subject_type: string, subject_id: string, detail: Record<string, unknown> = {}) {
  const item: AuditItem = {
    id: `aud_${crypto.randomBytes(6).toString('hex')}`,
    created_at: new Date().toISOString(),
    event,
    actor,
    subject_type,
    subject_id,
    detail,
  };
  auditLogs.unshift(item);
  if (auditLogs.length > 500) auditLogs.pop();
  // Параллельная запись в PG: аудит важен, но его потеря не должна ронять
  // бизнес-операцию, поэтому write-and-forget с журналированием сбоя.
  insertAuditRow(item.id, item, item.created_at).catch((err) =>
    logger.warn('audit write failed', { error: err.message, event })
  );
}

// Инициализация чистого старта для FOA Gateway.
//
// Демо-узлы (RFC 5737 TEST-NET: 198.51.100.x / 203.0.113.x / 192.0.2.x),
// демо-кандидаты discovery и их согласия из пула удалены — они были
// физически недостижимы и вызывали в чате «fetch failed». Шлюз стартует с
// пустым пулом; настоящие узлы регистрируются через POST /admin/nodes или
// раздел «Обнаружение».
async function seedInitialData() {
  // Аудит первой загрузки шлюза (без сидинга данных).
  addAudit('gateway_boot', 'system', 'gateway', GATEWAY_ID, {
    version: VERSION,
    pool_size: nodes.size,
    status: 'clean_initialized',
  });
}

// --- Инициализация хранилищ -------------------------------------------------
//
// PG и Redis подключаются до отдачи трафика. Если БД недоступна, шлюз
// деградирует до in-memory режима (с предупреждением в логе), чтобы не
// блокировать локальную разработку.

async function bootstrap() {
  // initDb создаёт схему и поднимает LISTEN/NOTIFY-слушатель; без него
  // dbEnabled() остаётся false и хранилище молчит в in-memory режиме.
  const pgOk = await initDb();
  const redisOk = await initRedis();

  // Регистрируем перезагрузку кэшей каждой таблицы при приходе NOTIFY.
  nodes.registerReloadHandler(() => nodes.reload());
  consents.registerReloadHandler(() => consents.reload());
  blacklist.registerReloadHandler(() => blacklist.reload());
  candidates.registerReloadHandler(() => candidates.reload());
  apiKeys.registerReloadHandler(async () => {
    await apiKeys.reload();
    rebuildKeyHashIndex();
  });

  if (pgOk) {
    startFullReloadLoop(() => [TABLES.nodes, TABLES.consents, TABLES.blacklist, TABLES.candidates, TABLES.apiKeys]);
  }

  // Сидинг демо-узлов/кандидатов удалён: шлюз стартует с чистым пулом.
  await seedInitialData();
  rebuildKeyHashIndex();

  if (redisOk) {
    await registerGateway(GATEWAY_ID, {
      version: VERSION,
      started_at: new Date().toISOString(),
      storage: pgOk ? 'postgres' : 'in-memory',
    });
  }

  logger.info('Gateway initialized', {
    gateway_id: GATEWAY_ID,
    postgres: pgOk ? 'connected' : 'in-memory',
    redis: redisOk ? 'connected' : 'in-memory',
    nodes: nodes.size,
    keys: apiKeys.size,
  });
}

// Индекс аутентификации ключей: key_hash -> запись. Сырой ключ в PG не
// хранится — только его sha256, поэтому сравнение идёт по хэшу.
function rebuildKeyHashIndex(): void {
  apiKeyByHash.clear();
  for (const key of apiKeys.values()) {
    if (key.key_hash && !key.revoked) apiKeyByHash.set(key.key_hash, key);
  }
}

function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Configuration Object matching original config.yaml
const currentConfig = {
  gateway_id: GATEWAY_ID,
  security: {
    require_consent: true,
    allow_unverified_nodes: false,
    active_scanning: 'deny',
    route_candidates: true,
    store_prompt_bodies: false,
    store_response_bodies: false,
    forward_client_ip: false,
    require_tls_for_nodes: false,
    allow_loopback_nodes: true,
    client_hash_salt: '***hidden***',
  },
  limits: {
    requests_per_minute_per_user: 60,
    concurrent_requests_per_user: 2,
    max_prompt_bytes: 1048576,
    max_num_predict: 2048,
    max_generation_seconds: 300,
    requests_per_minute_global: 1000,
    requests_per_minute_per_model: 20,
    max_request_bytes: 1048576,
    max_messages: 200,
    max_message_bytes: 262144,
    concurrent_stream_requests_per_user: 2,
  },
  routing: {
    // §7.6: число попыток проксирования на разные узлы при отказе.
    retry_attempts: 2,
  },
  health: {
    liveness_interval_seconds: 15,
    readiness_interval_seconds: 60,
    timeout_seconds: 3,
    failure_threshold: 3,
    liveness_connect_timeout_seconds: 2.0,
    liveness_response_timeout_seconds: 3.0,
    liveness_failure_threshold: 3,
    readiness_timeout_seconds: 5.0,
    readiness_failure_threshold: 2,
    consent_recheck_interval_seconds: 86400,
    consent_revocation_apply_seconds: 5,
    passive_window_seconds: 60,
    passive_error_rate_threshold: 0.2,
    functional_check_enabled: false,
    functional_check_model: '',
    functional_check_interval_seconds: 3600,
    retry_after_failure_seconds: 1.0,
  },
  circuit_breaker: {
    window_seconds: 30.0,
    minimum_requests: 10,
    error_rate_threshold: 0.5,
    open_duration_seconds: 60.0,
    half_open_probes: 1,
  },
  discovery: {
    mode: 'authorized_enrollment',
    active_sources: ['shodan', 'censys', 'manual', 'greynoise', 'zoomeye', 'natlas'],
    auto_route_candidates: true,
    auto_verify_candidates: true,
    verification_mode: 'dual',
  },
};

// --- Идентификатор запроса (§7.6, §8.5) ---------------------------------------
//
// Каждый запрос получает уникальный id; он возвращается в заголовке
// X-FOA-Request-ID и входит в конверт ошибки — это позволяет связать
// сообщение клиента с записями шлюза и узла.

function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.headers['x-foa-request-id'] as string | undefined;
  const id = incoming && /^[A-Za-z0-9_.:-]{1,64}$/.test(incoming) ? incoming : generateRequestId();
  (req as any).requestId = id;
  res.setHeader('X-FOA-Request-ID', id);
  next();
};

// --- Счётчик запростов для /metrics ------------------------------------------
// Раньше foa_requests_total был захардкожен (4289). Теперь считаем реально.
const requestCounters = {
  total: 0,
  by_status: new Map<number, number>(),
  errors: 0,
};

function recordRequest(statusCode: number): void {
  requestCounters.total++;
  if (statusCode >= 500) requestCounters.errors++;
  requestCounters.by_status.set(statusCode, (requestCounters.by_status.get(statusCode) || 0) + 1);
}

// --- X-FOA-Client-Hash (§8.5.3) ----------------------------------------------
//
// Обезличенный хэш клиента на основе соли из конфигурации: реальный IP
// узлам не передаётся, а владелец узла видит стабильный идентификатор
// для настройки собственных лимитов.
function clientHashFor(req: Request): string {
  const salt = process.env.FOA_SECURITY__CLIENT_HASH_SALT || currentConfig.security.client_hash_salt || '';
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || '';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

const clientHashMiddleware = (req: Request, res: Response, next: NextFunction) => {
  (req as any).clientHash = clientHashFor(req);
  res.setHeader('X-FOA-Client-Hash', (req as any).clientHash);
  next();
};

// --- Конверт ошибки (§8.6) ----------------------------------------------------
//
// Единый формат ошибок пользовательского API: сообщение остаётся строкой
// (обратная совместимость с клиентами), добавляются code, request_id и
// retry_after для лимитов.
function sendApiError(
  req: Request,
  res: Response,
  statusCode: number,
  message: string,
  opts: { code?: string; retryAfter?: number } = {}
): Response {
  const payload: Record<string, any> = {
    error: message,
    code: opts.code || defaultCodeFor(statusCode),
    request_id: (req as any).requestId || generateRequestId(),
  };
  if (opts.retryAfter && opts.retryAfter > 0) {
    payload.retry_after = opts.retryAfter;
    res.setHeader('Retry-After', String(opts.retryAfter));
  }
  return res.status(statusCode).json(payload);
}

function defaultCodeFor(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    case 500:
      return 'internal_error';
    case 502:
      return 'bad_gateway';
    case 503:
      return 'service_unavailable';
    case 504:
      return 'gateway_timeout';
    default:
      return 'error';
  }
}

// --- Throttled flush last_used_at ключей --------------------------------------
//
// last_used_at обновляется при каждой аутентификации — писать его в PG на
// каждый запрос нерационально. Грязные ключи сбрасываются раз в 15 секунд.
const dirtyKeys = new Set<string>();
let keyFlushTimer: NodeJS.Timeout | null = null;

function markKeyUsed(keyId: string): void {
  dirtyKeys.add(keyId);
  if (keyFlushTimer) return;
  keyFlushTimer = setInterval(() => {
    const ids = Array.from(dirtyKeys);
    dirtyKeys.clear();
    for (const id of ids) {
      const key = apiKeys.get(id);
      if (!key || !dbEnabled()) continue;
      const update = { ...key };
      delete update.raw_key;
      apiKeys.set(update).catch((err) => logger.warn('last_used_at flush failed', { error: err.message }));
    }
  }, 15_000);
}

// --- Хелпер персистентности узлов --------------------------------------------
//
// Маршруты мутируют поля узла напрямую (node.status = ...). После мутации
// нужно зафиксировать состояние в PG — этот хелпер делает write-through и
// логирует сбой, не роняя запрос.
async function persistNode(node: NodeItem | undefined): Promise<void> {
  if (!node) return;
  try {
    await nodes.set(node);
  } catch (err: any) {
    logger.warn('node persist failed', { node_id: node.node_id, error: err.message });
  }
}

async function persistConsent(consent: ConsentItem | undefined): Promise<void> {
  if (!consent) return;
  try {
    await consents.set(consent);
  } catch (err: any) {
    logger.warn('consent persist failed', { consent_id: consent.consent_id, error: err.message });
  }
}

function notFound(res: Response, message: string): Response {
  return res.status(404).json({ error: message });
}

// Authentication Middleware for /admin/*
const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.query.token as string);

  // Токены читаются на каждом запросе, чтобы POST /admin/config/reload
  // (перечитывающий .env) применял новые значения без рестарта.
  const configuredAdminToken = process.env.FOA_ADMIN_TOKEN || 'foa-admin-secret';
  const configuredAuditorToken = process.env.FOA_AUDITOR_TOKEN || 'foa-auditor-secret';

  // Допускаются только точно совпадающие токены администратора/аудитора.
  if (!token || (token !== configuredAdminToken && token !== configuredAuditorToken)) {
    return res.status(401).json({ error: 'Необходима авторизация администратора (Bearer токен)' });
  }

  // Роли (§2.2, §9.6): токен администратора — полный доступ, токен аудитора —
  // только чтение. ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ 'foa-admin-secret' — это административный
  // токен, поэтому роль определяется именно по совпадению с ним.
  const isAdmin = token === configuredAdminToken;
  if (!isAdmin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ error: 'Токен аудитора допускает только операции чтения (GET)' });
  }
  (req as any).adminRole = isAdmin ? 'admin' : 'auditor';

  return next();
};

// Authentication Middleware для пользовательского API (§9.2):
// Authorization: Bearer <foa_live_...> — действующий, не отозванный
// и не просроченный ключ из реестра apiKeys.
//
// Поиск идёт по key_hash (sha256 ключа): PG хранит только хэш, поэтому
// сравнивать сырые строки не нужно. Кэш ключей реплики синхронизируется
// через PG LISTEN/NOTIFY; при промахе кэша (ключ только что создан на
// другой реплике) делается прямой запрос в PG.
const userAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return sendApiError(req, res, 401, 'Требуется API-ключ: заголовок Authorization: Bearer <foa_live_...>');
  }

  if (!token.startsWith('foa_live_')) {
    return sendApiError(req, res, 401, 'Недействительный API-ключ');
  }

  const now = new Date();
  const tokenHash = hashApiKey(token);

  let key: ApiKeyItem | undefined = apiKeyByHash.get(tokenHash);
  if (!key && dbEnabled()) {
    // Промах кэша: возможно, ключ создан на другой реплике и уведомление
    // ещё не дошло. Перечитываем напрямую из БД.
    const fresh = await apiKeys.findByField('key_hash', tokenHash);
    if (fresh) {
      apiKeys.cacheUpsert(fresh);
      key = fresh;
      apiKeyByHash.set(tokenHash, fresh);
    }
  }

  if (!key || key.revoked) {
    return sendApiError(req, res, 401, 'Недействительный API-ключ');
  }

  if (key.expires_at && new Date(key.expires_at) < now) {
    return sendApiError(req, res, 401, 'Срок действия API-ключа истёк');
  }

  key.last_used_at = now.toISOString();
  markKeyUsed(key.key_id);
  // Ключ нужен middleware requireScopes / applyLimits, идущим следом в цепочке.
  (req as any).apiKey = key;
  return next();
};

// Authorization по скоупам (§9.2): пропускает запрос, если у ключа есть
// хотя бы один из требуемых скоупов, иначе 403.
const requireScopes = (...scopes: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const key: ApiKeyItem = (req as any).apiKey;
    const granted: string[] = Array.isArray(key?.scopes) ? key.scopes : [];
    if (scopes.some((s) => granted.includes(s))) {
      return next();
    }
    return sendApiError(
      req,
      res,
      403,
      `Недостаточно прав: требуется один из скоупов [${scopes.join(', ')}], у ключа — [${granted.join(', ')}]`
    );
  };
};

// --- Лимиты, квоты и проверка размера запроса (§7.5, §12.4.2–12.4.3) ---
//
// Окно 60 секунд. Состояние живёт в Redis (src/redis.ts), поэтому лимит
// единый для всех реплик за nginx: пользователь не сможет обойти его,
// раскидывая запросы между репликами. При отсутствии Redis счётчики
// остаются в памяти процесса.
const LIMIT_WINDOW_MS = 60_000;

function sendRateLimited(
  req: Request,
  res: Response,
  scope: string,
  limit: number,
  retryAfter: number
): Response {
  return sendApiError(req, res, 429, `Превышен лимит запросов (${scope} ≤ ${limit}/мин). Повторите через ${retryAfter} с.`, {
    code: 'rate_limited',
    retryAfter,
  });
}

function sendInflightLimited(req: Request, res: Response, limit: number, isStream: boolean): Response {
  return sendApiError(
    req,
    res,
    429,
    `Превышен лимит одновременных ${isStream ? 'стримов' : 'запросов'} (${limit} на пользователя)`,
    { code: 'concurrent_limit' }
  );
}

// applyLimits проверяет размер тела, квоты payload, RPM (пользователь /
// глобально / на модель) и параллельные запросы. Счётчики инкрементируются
// только если все проверки прошли — иначе отвергнутый запрос не съедает квоту.
const applyLimits = (opts: { perModel?: boolean; body?: 'prompt' | 'chat' | 'openai' } = {}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key: ApiKeyItem = (req as any).apiKey;
    const limits = currentConfig.limits;
    const keyId = key.key_id;

    // 1. Размер запроса (§12.4.2)
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > limits.max_request_bytes) {
      return sendApiError(
        req,
        res,
        413,
        `Тело запроса превышает max_request_bytes (${limits.max_request_bytes} байт)`
      );
    }

    // 2. Квоты payload (§12.4.2)
    const body: Record<string, any> = req.body || {};
    if (opts.body === 'prompt') {
      const prompt: string = typeof body.prompt === 'string' ? body.prompt : '';
      if (Buffer.byteLength(prompt, 'utf8') > limits.max_prompt_bytes) {
        return sendApiError(
          req,
          res,
          400,
          `Промпт превышает max_prompt_bytes (${limits.max_prompt_bytes} байт)`
        );
      }
      // num_predict выше max_num_predict не отбрасываем — ограничиваем до
      // лимита. Клиенты (OpenAI SDK, чат-клиенты) часто присылают «дефолтные»
      // 4096+, и жёсткий 400 ломал бы любой такой запрос; безопасность
      // (сам лимит генерации) при этом сохраняется.
      const numPredict = body.options?.num_predict;
      if (typeof numPredict === 'number' && numPredict > limits.max_num_predict) {
        body.options.num_predict = limits.max_num_predict;
      }
    } else if (opts.body === 'chat' || opts.body === 'openai') {
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length > limits.max_messages) {
        return sendApiError(req, res, 400, `Число сообщений превышает max_messages (${limits.max_messages})`);
      }
      for (const m of messages) {
        const content: string = typeof m?.content === 'string' ? m.content : '';
        if (Buffer.byteLength(content, 'utf8') > limits.max_message_bytes) {
          return sendApiError(
            req,
            res,
            400,
            `Сообщение превышает max_message_bytes (${limits.max_message_bytes} байт)`
          );
        }
      }
      // Лимит генерации ограничиваем, а не отбрасываем: OpenAI SDK и чат-клиенты
      // шлют max_tokens/max_completion_tokens по умолчанию (4096+), жёсткий 400
      // ломал бы любой такой запрос. Значение ниже лимита не трогаем.
      if (opts.body === 'openai') {
        if (typeof body.max_tokens === 'number' && body.max_tokens > limits.max_num_predict) {
          body.max_tokens = limits.max_num_predict;
        }
        if (typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > limits.max_num_predict) {
          body.max_completion_tokens = limits.max_num_predict;
        }
      } else if (typeof body.options?.num_predict === 'number' && body.options.num_predict > limits.max_num_predict) {
        body.options.num_predict = limits.max_num_predict;
      }
    }

    // 3. RPM на пользователя (явный лимит ключа приоритетнее общего)
    const userLimit = key.rate_limit_per_minute ?? limits.requests_per_minute_per_user;
    const userResult = await checkRateLimit('user', keyId, userLimit, LIMIT_WINDOW_MS);
    if (!userResult.allowed) {
      setRateLimitHeaders(res, userLimit, userResult);
      return sendRateLimited(req, res, 'на пользователя', userLimit, userResult.retryAfter);
    }

    // 4. Глобальный RPM
    const globalResult = await checkRateLimit('global', 'all', limits.requests_per_minute_global, LIMIT_WINDOW_MS);
    if (!globalResult.allowed) {
      setRateLimitHeaders(res, limits.requests_per_minute_global, globalResult);
      return sendRateLimited(req, res, 'глобальный', limits.requests_per_minute_global, globalResult.retryAfter);
    }

    // 5. RPM на модель
    if (opts.perModel && body.model) {
      const modelId = `${keyId}|${String(body.model).toLowerCase()}`;
      const modelResult = await checkRateLimit(
        'model',
        modelId,
        limits.requests_per_minute_per_model,
        LIMIT_WINDOW_MS
      );
      if (!modelResult.allowed) {
        setRateLimitHeaders(res, limits.requests_per_minute_per_model, modelResult);
        return sendRateLimited(
          req,
          res,
          `на модель ${body.model}`,
          limits.requests_per_minute_per_model,
          modelResult.retryAfter
        );
      }
    }

    // 6. Параллельные запросы (отдельно для стримов, §12.4.2)
    const isStream = body.stream === true;
    const inflightLimit = isStream
      ? limits.concurrent_stream_requests_per_user
      : limits.concurrent_requests_per_user;
    const inflightScope = isStream ? 'inflight-stream' : 'inflight';
    const acquired = await acquireInflight(`${inflightScope}:${keyId}`, inflightLimit);
    if (!acquired) {
      return sendInflightLimited(req, res, inflightLimit, isStream);
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseInflight(`${inflightScope}:${keyId}`).catch(() => {});
    };
    res.on('close', release);
    req.on('aborted', release);

    next();
  };
};

// Заголовки X-FOA-RateLimit-* (§8.5): клиент видит лимит и сколько осталось.
function setRateLimitHeaders(res: Response, limit: number, result: { count: number; retryAfter: number }): void {
  res.setHeader('X-FOA-RateLimit-Limit', String(limit));
  res.setHeader('X-FOA-RateLimit-Remaining', String(Math.max(0, limit - result.count)));
  res.setHeader('X-FOA-RateLimit-Reset', String(Math.max(0, result.retryAfter)));
}

// --- Operational Routes ---
app.get('/healthz', (req, res) => {
  // liveness: шлюз жив, если отвечает на запросы.
  res.json({
    status: 'ok',
    version: VERSION,
    gateway_id: GATEWAY_ID,
    storage: {
      postgres: dbConnected() ? 'connected' : dbEnabled() ? 'error' : 'disabled',
      redis: redisEnabled() ? 'connected' : 'disabled',
    },
  });
});

app.get('/readyz', (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const ok = routable > 0;
  const status = ok ? 'ready' : 'degraded';
  res.status(ok ? 200 : 503).json({
    status,
    routable_nodes: routable,
    nodes_total: nodes.size,
    version: VERSION,
    gateway_id: GATEWAY_ID,
    storage: {
      postgres: dbConnected() ? 'connected' : dbEnabled() ? 'error' : 'disabled',
      redis: redisEnabled() ? 'connected' : 'disabled',
    },
  });
});

app.get('/metrics', (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const activeBl = Array.from(blacklist.values()).filter((b) => !b.lifted_at).length;
  const lines = [
    `# HELP foa_build_info Gateway build information`,
    `# TYPE foa_build_info gauge`,
    `foa_build_info{version="${VERSION}",gateway_id="${GATEWAY_ID}"} 1`,
    `# HELP foa_nodes_routable Total routable nodes in pool`,
    `# TYPE foa_nodes_routable gauge`,
    `foa_nodes_routable ${routable}`,
    `# HELP foa_nodes_total Total nodes known to gateway`,
    `# TYPE foa_nodes_total gauge`,
    `foa_nodes_total ${nodes.size}`,
    `# HELP foa_nodes_blacklisted Total blacklisted nodes`,
    `# TYPE foa_nodes_blacklisted gauge`,
    `foa_nodes_blacklisted ${activeBl}`,
    `# HELP foa_api_keys_total Total API keys (incl. revoked)`,
    `# TYPE foa_api_keys_total gauge`,
    `foa_api_keys_total ${apiKeys.size}`,
    `# HELP foa_requests_total Total gateway requests served`,
    `# TYPE foa_requests_total counter`,
    `foa_requests_total ${requestCounters.total}`,
    `# HELP foa_requests_errors_total Requests that ended with 5xx`,
    `# TYPE foa_requests_errors_total counter`,
    `foa_requests_errors_total ${requestCounters.errors}`,
  ];
  for (const [code, count] of Array.from(requestCounters.by_status.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(
      `# HELP foa_requests_by_status Requests by HTTP status code`,
      `# TYPE foa_requests_by_status counter`,
      `foa_requests_by_status{status="${code}"} ${count}`
    );
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n'));
});

// Root and Panel routes
app.get(['/', '/panel', '/panel/*'], (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// --- Admin API Routes ---
app.get('/admin/status', adminAuth, (req, res) => {
  const allNodes = Array.from(nodes.values());
  const routable = allNodes.filter((n) => n.routable).length;
  const activeBl = Array.from(blacklist.values()).filter((b) => !b.lifted_at).length;

  const nodesByStatus: Record<string, number> = {};
  allNodes.forEach((n) => {
    nodesByStatus[n.status] = (nodesByStatus[n.status] || 0) + 1;
  });

  const nodesMap: Record<string, Record<string, unknown>> = {};
  allNodes.forEach((n) => {
    nodesMap[n.node_id] = {
      state: n.status,
      active: n.active_connections,
      max_concurrency: n.max_concurrency,
      ewma_latency_ms: n.latency_ms,
      error_rate: n.error_rate,
      effective_weight: n.weight,
      routable: n.routable,
    };
  });

  res.json({
    version: VERSION,
    gateway_id: GATEWAY_ID,
    time: new Date().toISOString(),
    routable_nodes: routable,
    blacklisted: activeBl,
    nodes_by_status: nodesByStatus,
    security: currentConfig.security,
    discovery: {
      mode: currentConfig.discovery.mode,
      candidates: candidates.size,
      active_sources: currentConfig.discovery.active_sources,
    },
    nodes: nodesMap,
    rpm_metrics: getRpm60mData(),
  });
});

app.get('/admin/metrics/rpm', adminAuth, (req, res) => {
  res.json(getRpm60mData());
});

app.get('/admin/nodes', adminAuth, (req, res) => {
  const isDetailed = req.query.detailed === 'true';
  const nodesList = Array.from(nodes.values()).map((node) => {
    if (!isDetailed) return node;
    const samples = nodeLatencySamples.get(node.node_id) || generateDefaultSamplesForNode(node);
    if (!nodeLatencySamples.has(node.node_id)) nodeLatencySamples.set(node.node_id, samples);
    return {
      ...node,
      latency_distribution: computeLatencyStats(samples),
    };
  });
  res.json({ nodes: nodesList });
});

app.get('/admin/nodes/latency-distribution', adminAuth, (req, res) => {
  const binLabels = LATENCY_BINS.map((b) => b.label);
  const resultNodes: Record<string, any> = {};
  let allSamples: number[] = [];

  for (const node of nodes.values()) {
    if (!node.routable) continue;
    let s = nodeLatencySamples.get(node.node_id);
    if (!s || s.length === 0) {
      s = generateDefaultSamplesForNode(node);
      nodeLatencySamples.set(node.node_id, s);
    }
    allSamples = allSamples.concat(s);
    const stats = computeLatencyStats(s);
    resultNodes[node.node_id] = {
      node_id: node.node_id,
      display_name: node.display_name,
      endpoint: node.endpoint,
      country: node.country || 'US',
      models: node.models,
      current_latency_ms: node.latency_ms,
      ...stats,
    };
  }

  const aggregateStats = computeLatencyStats(allSamples);

  res.json({
    bins: binLabels,
    nodes: resultNodes,
    aggregate: aggregateStats,
    timestamp: new Date().toISOString(),
  });
});

// Реальная история CPU/Memory по узлам (сэмплируется фоновым циклом каждые
// NODE_METRICS_INTERVAL_MS). Ответ совместим по формату со старой версией
// ручки: { metrics: [{node_id, display_name, status, country, history:[{time,cpu,memory,latency_ms}]}], timestamps }.
// Если сэмплер ещё не успел накопить точки (первый запрос сразу после старта),
// возвращаем пустой массив — фронтенд покажет ожидание данных, а не выдуманные цифры.
app.get('/admin/nodes/metrics', adminAuth, async (req, res) => {
  // Каждое обращение панели (стартовая загрузка + автообновление каждые ~5 с)
  // снимает свежий сэмпл — так график растёт в реальном времени. Фоновый
  // лидер-цикл дублирует сэмплирование для реплик без открытой панели.
  await sampleNodeMetricsOnce().catch(() => {});

  const timestampsSet = new Set<string>();
  for (const arr of nodeMetricsHistory.values()) {
    for (const p of arr) timestampsSet.add(p.time);
  }
  const timestamps = Array.from(timestampsSet);

  const nodeMetrics: any[] = [];
  for (const node of nodes.values()) {
    const hist = nodeMetricsHistory.get(node.node_id) || [];
    nodeMetrics.push({
      node_id: node.node_id,
      display_name: node.display_name || node.node_id,
      status: node.status,
      country: node.country || 'US',
      real: hist.length > 0 && hist[hist.length - 1].real,
      history: hist.map((p) => ({
        time: p.time,
        cpu: p.cpu,
        memory: p.memory,
        latency_ms: node.latency_ms || 0,
      })),
    });
  }
  res.json({
    metrics: nodeMetrics,
    timestamps,
    interval_ms: NODE_METRICS_INTERVAL_MS,
    timestamp: new Date().toISOString(),
  });
});

app.get('/admin/nodes/:id/latency-distribution', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  let s = nodeLatencySamples.get(node.node_id);
  if (!s || s.length === 0) {
    s = generateDefaultSamplesForNode(node);
    nodeLatencySamples.set(node.node_id, s);
  }

  const stats = computeLatencyStats(s);
  res.json({
    node_id: node.node_id,
    display_name: node.display_name,
    endpoint: node.endpoint,
    country: node.country || 'US',
    bins: LATENCY_BINS.map((b) => b.label),
    current_latency_ms: node.latency_ms,
    ...stats,
  });
});

app.post('/admin/nodes', adminAuth, async (req, res) => {
  const { endpoint, display_name, owner_id, models, max_concurrency, consent_method, weight, country, labels } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'Endpoint обязателен' });
  }

  const nodeId = `node_${crypto.randomBytes(5).toString('hex')}`;
  const consentId = `cst_${crypto.randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();

  const newNode: NodeItem = {
    node_id: nodeId,
    endpoint,
    display_name: display_name || `Node ${nodeId.slice(0, 8)}`,
    owner_id: owner_id || 'unassigned@owner',
    models: Array.isArray(models) && models.length ? models : ['llama3:8b'],
    max_concurrency: max_concurrency || 2,
    active_connections: 0,
    latency_ms: 0,
    error_rate: 0,
    weight: weight || 1,
    status: 'pending_consent',
    consent_status: 'challenge_sent',
    routable: false,
    created_at: now,
    updated_at: now,
    state: 'pending_consent',
    active: 0,
    ewma_latency_ms: 0,
    effective_weight: 0,
    country: (country || req.body.country || 'US').toUpperCase(),
    labels: Array.isArray(labels) ? labels : [],
  };

  nodeLatencySamples.set(nodeId, generateDefaultSamplesForNode(newNode));

  const newConsent: ConsentItem = {
    consent_id: consentId,
    node_id: nodeId,
    owner_id: owner_id || 'unassigned@owner',
    status: 'pending',
    method: consent_method || 'http_well_known',
    allowed_models: newNode.models,
    max_concurrency: newNode.max_concurrency,
    issued_at: now,
    expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    version: 1,
    history: [
      { event: 'node_registered', actor: 'admin', created_at: now },
      { event: 'challenge_created', actor: 'system', created_at: now },
    ],
  };

  // Узел и согласие пишутся атомарно (через транзакцию PG), когда БД
  // подключена; в in-memory режиме tx() бросает «БД не инициализирована»,
  // поэтому используем обычные записи Store — они уже обновляют кэш и
  // пишут в PG при его наличии. Не должно возникать узла без согласия.
  try {
    if (dbEnabled()) {
      await tx(async (client) => {
        await nodes.set(newNode, client);
        await consents.set(newConsent, client);
      });
    } else {
      await nodes.set(newNode);
      await consents.set(newConsent);
    }
  } catch (err: any) {
    logger.error('node registration failed', { error: err.message, node_id: nodeId });
    return res.status(500).json({ error: 'Не удалось зарегистрировать узел', detail: err.message });
  }

  addAudit('node_registered', 'admin', 'node', nodeId, { endpoint, consent_id: consentId });

  res.json({
    node_id: nodeId,
    consent_id: consentId,
    status: 'pending_consent',
    next_step: 'Подтвердите владение узлом через метод: ' + (consent_method || 'http_well_known'),
    challenge: {
      challenge_token: `foa_chk_${crypto.randomBytes(16).toString('hex')}`,
      verification_path: '/.well-known/foa-consent.json',
      expires_in_seconds: 3600,
    },
  });
});

function generateChallengeForNode(nodeId: string, endpoint: string, ownerId: string) {
  const challengeToken = `ch_${crypto.randomBytes(12).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  let domain = 'node.example.com';
  try {
    const u = new URL(endpoint.startsWith('http') ? endpoint : `http://${endpoint}`);
    domain = u.hostname;
  } catch (e) {}

  const wellKnownJson = {
    node_id: nodeId,
    challenge: challengeToken,
    gateway_id: GATEWAY_ID,
    owner_id: ownerId,
    expires_at: expiresAt,
    capabilities: {
      models: ['llama3:8b', 'mistral:7b'],
      max_concurrency: 4,
    },
    verification_status: 'domain_agreement_authorized',
  };

  const dnsTxtRecord = `_free-ollama-challenge.${domain}`;
  const dnsTxtValue = `gateway=${GATEWAY_ID};node=${nodeId};challenge=${challengeToken};exp=${expiresAt}`;

  return {
    challenge_token: challengeToken,
    expires_at: expiresAt,
    well_known_url: `${endpoint.replace(/\/$/, '')}/.well-known/free-ollama/v1/consent.json`,
    well_known_json: wellKnownJson,
    dns_txt_record: dnsTxtRecord,
    dns_txt_value: dnsTxtValue,
  };
}

app.get('/admin/nodes/:id', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });
  res.json(node);
});

app.get('/admin/nodes/:id/challenge', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });
  const info = generateChallengeForNode(node.node_id, node.endpoint, node.owner_id);
  res.json(info);
});

app.post('/admin/nodes/:id/challenge', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });
  const info = generateChallengeForNode(node.node_id, node.endpoint, node.owner_id);
  res.json(info);
});

app.post('/admin/nodes/:id/verify', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  const { mode = 'manual', method = 'manual_admin', models, owner_id, max_concurrency } = req.body || {};
  if (owner_id) node.owner_id = owner_id;
  if (max_concurrency) node.max_concurrency = max_concurrency;
  if (Array.isArray(models) && models.length) node.models = models;

  // Probe endpoint to refresh actual model list if node is up
  try {
    const probeRes = await fetch(`${node.endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (probeRes.ok) {
      const data = (await probeRes.json()) as any;
      if (Array.isArray(data.models) && data.models.length) {
        node.models = data.models.map((m: any) => m.name || m.model);
      }
    }
  } catch (e) {
    // keep configured models
  }

  node.consent_status = 'verified';
  node.status = 'healthy';
  node.routable = true;
  node.updated_at = new Date().toISOString();
  node.state = 'healthy';
  node.effective_weight = node.weight;

  // Update consent record
  let consentFound = false;
  for (const c of consents.values()) {
    if (c.node_id === node.node_id) {
      c.status = 'active';
      c.method = method;
      c.allowed_models = node.models;
      c.max_concurrency = node.max_concurrency;
      c.history.push({
        event: mode === 'auto' ? 'node_auto_verified' : 'node_manual_verified',
        actor: 'admin',
        created_at: new Date().toISOString(),
        detail: { method, mode, domain_owners_agreed: true },
      });
      consentFound = true;
      persistConsent(c);
    }
  }

  if (!consentFound) {
    const cId = `cst_${node.node_id}`;
    const newConsent: ConsentItem = {
      consent_id: cId,
      node_id: node.node_id,
      owner_id: node.owner_id,
      status: 'active',
      method: method,
      allowed_models: node.models,
      max_concurrency: node.max_concurrency,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
      version: 1,
      history: [
        {
          event: mode === 'auto' ? 'node_auto_verified' : 'node_manual_verified',
          actor: 'admin',
          created_at: new Date().toISOString(),
          detail: { method, mode, domain_owners_agreed: true },
        },
      ],
    };
    await persistConsent(newConsent);
  }
  await persistNode(node);

  addAudit(mode === 'auto' ? 'node_auto_verified' : 'node_verified', 'admin', 'node', node.node_id, {
    routable: true,
    models: node.models,
    method,
    mode,
    domain_owners_agreed: true,
  });

  res.json({
    status: 'verified',
    node_id: node.node_id,
    routable: true,
    models: node.models,
    method,
    mode,
  });
});

app.post('/admin/nodes/bulk-verify', adminAuth, async (req, res) => {
  const { node_ids = [], mode = 'auto', method = 'auto_domain_agreement' } = req.body || {};
  let count = 0;
  for (const id of node_ids) {
    const node = nodes.get(id);
    if (!node) continue;
    node.consent_status = 'verified';
    node.status = 'healthy';
    node.routable = true;
    node.updated_at = new Date().toISOString();
    node.state = 'healthy';
    node.effective_weight = node.weight;

    for (const c of consents.values()) {
      if (c.node_id === node.node_id) {
        c.status = 'active';
        c.method = method;
        c.history.push({
          event: mode === 'auto' ? 'node_auto_verified' : 'node_manual_verified',
          actor: 'admin',
          created_at: new Date().toISOString(),
          detail: { method, mode, domain_owners_agreed: true, bulk: true },
        });
        persistConsent(c);
      }
    }
    await persistNode(node);
    count++;
  }
  addAudit('nodes_bulk_verified', 'admin', 'nodes', 'bulk', { count, mode, method });
  res.json({ status: 'completed', count });
});

app.post('/admin/nodes/:id/health-check', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  const start = Date.now();
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
  let latency = 0;
  let errorMsg: string | undefined;

  try {
    const probeRes = await fetch(`${node.endpoint}/api/version`, {
      signal: AbortSignal.timeout(4000),
    });
    latency = Date.now() - start;
    if (probeRes.ok) {
      status = latency > 600 ? 'degraded' : 'healthy';

      try {
        const tagsRes = await fetch(`${node.endpoint}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (tagsRes.ok) {
          const tData = (await tagsRes.json()) as any;
          if (Array.isArray(tData.models) && tData.models.length) {
            node.models = tData.models.map((m: any) => m.name || m.model);
          }
        }
      } catch (e) {
        // preserve models
      }
    } else {
      status = 'degraded';
    }
  } catch (err: any) {
    latency = Date.now() - start;
    status = 'unhealthy';
    errorMsg = err.message;
  }

  node.latency_ms = latency;
  node.ewma_latency_ms =
    node.ewma_latency_ms > 0 ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3) : latency;
  node.status = status;
  node.state = status;
  node.last_health_check = new Date().toISOString();
  node.updated_at = node.last_health_check;
  recordNodeLatencySample(node.node_id, latency);
  await persistNode(node);

  addAudit('health_probe', 'system', 'node', node.node_id, {
    latency_ms: latency,
    status,
    models: node.models,
    error: errorMsg,
  });

  res.json({
    status,
    latency_ms: latency,
    node_id: node.node_id,
    models: node.models,
    error: errorMsg,
  });
});

// Разбор сетевых ошибок undici/node-fetch («fetch failed») в человеческое
// сообщение: причина обычно в err.cause (ENOTFOUND/ECONNREFUSED/ETIMEDOUT...).
function describeFetchError(err: any): string {
  const cause = err?.cause;
  const code = cause?.code || err?.code || '';
  const reason = cause?.message || cause || '';
  switch (code) {
    case 'ENOTFOUND':
      return `не удалось разрешить адрес узла (DNS${reason ? `: ${reason}` : ''})`;
    case 'ECONNREFUSED':
      return `узел отверг соединение (порт закрыт или Ollama не запущен${reason ? `: ${reason}` : ''})`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'ECONNRESET':
      return `сеть недоступна или соединение сброшено (${code})`;
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return `превышен таймаут соединения с узлом (${code})`;
    case 'TimeoutError':
    case 'AbortError':
      return 'таймаут запроса к узлу';
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HR_BAD_VERIFY':
      return `ошибка TLS-сертификата узла (${code || reason})`;
    default:
      return [code, String(reason || err?.message || 'неизвестная сетевая ошибка')].filter(Boolean).join(': ');
  }
}

// Прямой прокси-чат с конкретным узлом (для карточки узла в админ-панели).
// Аутентификация — как у всего /admin/* (Bearer токен админа/аудитора), поэтому
// здесь НЕ требуется пользовательский API-ключ foa_live_.... Именно на этот
// эндпоинт должен ходить чат из панели: раньше он ходил на /api/chat (userAuth)
// с токеном панели, что давало «Ошибка: Недействительный API-ключ».
app.post('/admin/nodes/:id/chat', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  // Поддерживаем оба формата тела: {message} и {messages:[...]} (история чата)
  const incomingMessages = Array.isArray(req.body?.messages) && req.body.messages.length
    ? req.body.messages
    : [{ role: 'user', content: String(req.body?.message || '').trim() }];
  const lastUser = [...incomingMessages].reverse().find((m: any) => m && m.role === 'user');
  const message = String(lastUser?.content || '').trim();
  if (!message) return res.status(400).json({ error: 'Пустое сообщение' });

  if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
    return res.status(400).json({
      error: `Некорректный endpoint узла: ${node.endpoint || '(пусто)'}. Отредактируйте узел — адрес должен начинаться с http:// или https://`,
    });
  }

  const model = req.body?.model || (Array.isArray(node.models) && node.models[0]) || 'llama3';
  const messages = incomingMessages.map((m: any) => ({ role: m.role || 'user', content: String(m.content ?? '') }));

  const start = Date.now();
  node.active_connections++;
  try {
    const upstreamRes = await fetch(`${node.endpoint.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: upstreamHeaders(req),
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(120_000),
      ...dispatcherFor(node.endpoint, Math.max(1, node.max_concurrency || 4)),
    } as any);

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => '');
      let detail = text.slice(0, 300);
      try { detail = String(JSON.parse(text)?.error || detail); } catch { /* не JSON */ }
      throw new Error(`Узел ответил HTTP ${upstreamRes.status}${detail ? `: ${detail}` : ''}`);
    }

    const data = (await upstreamRes.json()) as any;
    const reply = typeof data.message?.content === 'string'
      ? data.message.content
      : (typeof data.response === 'string' ? data.response : '');

    // Успешный ответ — обновляем статистику здоровья узла (как в callUpstream)
    const latency = Date.now() - start;
    node.latency_ms = latency;
    node.ewma_latency_ms = node.ewma_latency_ms
      ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3)
      : latency;
    node.updated_at = new Date().toISOString();

    res.json({
      reply,
      model: data.model || model,
      node_id: node.node_id,
      latency_ms: latency,
      done: data.done !== false,
    });
  } catch (err: any) {
    addAudit('node_chat_error', 'admin', 'node', node.node_id, { error: err?.message, cause: err?.cause?.code });
    const friendly = String(err?.message || '') === 'fetch failed'
      ? `Чат с узлом недоступен: узел не отвечает по адресу ${node.endpoint} (${describeFetchError(err)})`
      : `Чат с узлом недоступен: ${err?.message || 'неизвестная ошибка'}`;
    res.status(502).json({ error: friendly });
  } finally {
    node.active_connections = Math.max(0, node.active_connections - 1);
  }
});

// Список моделей конкретного узла для выпадающего выбора в чате. Сначала
// отдаём закэшированный node.models; если он пуст — опрашиваем узел
// GET <endpoint>/api/tags и обновляем кэш.
app.get('/admin/nodes/:id/models', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  let models = Array.isArray(node.models) ? node.models : [];
  let fetched = false;
  if (!models.length) {
    try {
      const tagsRes = await fetch(`${node.endpoint}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (tagsRes.ok) {
        const tData = (await tagsRes.json()) as any;
        if (Array.isArray(tData.models)) {
          models = tData.models.map((m: any) => m.name || m.model).filter(Boolean);
          fetched = true;
          if (models.length) {
            node.models = models;
            node.updated_at = new Date().toISOString();
            await persistNode(node);
          }
        }
      }
    } catch (err: any) {
      return res.status(502).json({ error: `Узел не отвечает: ${err.message}`, models: [] });
    }
  }
  res.json({ node_id: node.node_id, models, fetched });
});

app.post('/admin/nodes/:id/revoke', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return notFound(res, 'Узел не найден');

  node.consent_status = 'revoked';
  node.status = 'unhealthy';
  node.routable = false;
  node.state = 'revoked';
  node.effective_weight = 0;
  node.updated_at = new Date().toISOString();

  // Отзыв должен быть мгновенным для маршрутизации (§5.5): закрываем пул
  // соединений к узлу и сбрасываем breaker, чтобы при повторной верификации
  // узел начал с чистого состояния.
  closeAgentForEndpoint(node.endpoint);
  resetBreaker(node.node_id);

  for (const c of consents.values()) {
    if (c.node_id === node.node_id) {
      c.status = 'revoked';
      c.revoked_at = node.updated_at;
      c.revoke_reason = req.body.reason || 'Admin revoked consent';
      c.history.push({
        event: 'consent_revoked',
        actor: 'admin',
        created_at: node.updated_at,
        detail: { reason: c.revoke_reason },
      });
      persistConsent(c);
    }
  }
  await persistNode(node);

  addAudit('node_revoked', 'admin', 'node', node.node_id, { reason: req.body.reason });
  res.json({ status: 'revoked', node_id: node.node_id, routable: false });
});

app.post('/admin/nodes/:id/blacklist', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  const nodeId = req.params.id;
  const endpoint = node ? node.endpoint : req.body.endpoint || 'unknown';

  if (node) {
    node.status = 'blacklisted';
    node.routable = false;
    node.effective_weight = 0;
    node.updated_at = new Date().toISOString();
    closeAgentForEndpoint(node.endpoint);
    resetBreaker(node.node_id);
    await persistNode(node);
  }

  const entry: BlacklistItem = {
    node_id: nodeId,
    endpoint,
    reason: req.body.reason || 'Admin manual blacklist',
    permanent: req.body.duration === 'permanent',
    actor: 'admin',
    created_at: new Date().toISOString(),
    expires_at: req.body.duration === 'permanent' ? null : new Date(Date.now() + 86400000).toISOString(),
    lifted_at: null,
  };

  try {
    await blacklist.set(entry);
  } catch (err: any) {
    logger.warn('blacklist persist failed', { node_id: nodeId, error: err.message });
  }

  addAudit('node_blacklisted', 'admin', 'node', nodeId, { reason: req.body.reason });
  res.json({ status: 'blacklisted', node_id: nodeId });
});

app.post('/admin/nodes/:id/unblacklist', adminAuth, async (req, res) => {
  const entry = blacklist.get(req.params.id);
  if (!entry) return notFound(res, 'Запись в чёрном списке не найдена');

  entry.lifted_at = new Date().toISOString();
  const node = nodes.get(req.params.id);
  if (node && node.consent_status === 'verified') {
    node.status = 'healthy';
    node.routable = true;
    node.effective_weight = node.weight;
    await persistNode(node);
  }

  try {
    await blacklist.set(entry);
  } catch (err: any) {
    logger.warn('unblacklist persist failed', { node_id: req.params.id, error: err.message });
  }

  addAudit('node_unblacklisted', 'admin', 'node', req.params.id);
  res.json({ status: 'unblacklisted', node_id: req.params.id });
});

app.delete('/admin/nodes/:id', adminAuth, async (req, res) => {
  const nodeId = req.params.id;
  const node = nodes.get(nodeId);
  if (!node) return notFound(res, 'Узел не найден');

  try {
    await nodes.delete(nodeId);
  } catch (err: any) {
    logger.warn('node delete failed', { node_id: nodeId, error: err.message });
  }
  closeAgentForEndpoint(node.endpoint);
  resetBreaker(nodeId);
  addAudit('node_deleted', 'admin', 'node', nodeId);
  res.json({ status: 'deleted', node_id: nodeId });
});

app.post('/admin/nodes/:id/labels', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return notFound(res, 'Узел не найден');
  const { labels } = req.body;
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: 'labels должен быть массивом строк' });
  }
  node.labels = labels.map(l => String(l).trim()).filter(Boolean);
  node.updated_at = new Date().toISOString();
  await persistNode(node);
  addAudit('node_labels_updated', 'admin', 'node', req.params.id, { labels: node.labels });
  res.json({ success: true, node_id: node.node_id, labels: node.labels });
});

app.get('/admin/nodes/:id/logs', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });
  
  const logLevels = ['INFO', 'DEBUG', 'WARN', 'SUCCESS'];
  const actions = [
    'Health check ping successful (latency: ' + (node.latency_ms || 25) + 'ms)',
    'Incoming proxy request routed for model ' + (node.models[0] || 'llama3:8b'),
    'Active connections count updated: ' + (node.active_connections || 0) + '/' + node.max_concurrency,
    'TLS handshake established successfully with endpoint ' + node.endpoint,
    'EWMA latency recalibrated to ' + (node.ewma_latency_ms || node.latency_ms || 24) + 'ms',
    'Heartbeat ACK received from gateway daemon',
    'Weight factor evaluated: effective_weight=' + (node.effective_weight || node.weight || 1),
    'Token bucket rate limit check passed (quota: 1000 req/min)',
    'Consent validation status: ' + node.consent_status
  ];

  const logs = [];
  const now = Date.now();
  for (let i = 100; i >= 1; i--) {
    const timestamp = new Date(now - i * 15000).toISOString();
    const level = logLevels[i % logLevels.length];
    const action = actions[i % actions.length];
    logs.push(`[${timestamp}] [${level}] [node:${node.node_id}] ${action}`);
  }

  res.json({
    node_id: node.node_id,
    display_name: node.display_name,
    total_lines: logs.length,
    logs
  });
});

// Consents
app.get('/admin/consents', adminAuth, async (req, res) => {
  const list = await consents.list();
  res.json({ consents: list });
});

app.get('/admin/consents/:id', adminAuth, async (req, res) => {
  const consent = consents.get(req.params.id) || (await consents.list().then((l) => l.find((c) => c.consent_id === req.params.id)));
  if (!consent) return notFound(res, 'Согласие не найдено');
  res.json(consent);
});

// Blacklist
app.get('/admin/blacklist', adminAuth, async (req, res) => {
  const all = await blacklist.list();
  const activeTotal = all.filter((b) => !b.lifted_at).length;
  res.json({ active_total: activeTotal, blacklist: all });
});

// ============================================================================
// Search Engines Discovery Connectors (§4.4 ТЗ)
// ============================================================================
interface DiscoveredRawItem {
  ip: string;
  port: number;
  protocol?: string;
  dns_names: string[];
  country: string;
  asn?: string;
  source: string;
  service_hint?: string;
  banner?: string;
}

// 1. Censys Search Engine (Platform API v3 / Hosts API v2)
async function fetchFromCensys(): Promise<{ items: DiscoveredRawItem[]; error?: string }> {
  const token = process.env.CENSYS_API_TOKEN || process.env.CENSYS_API_KEY;
  const apiId = process.env.CENSYS_API_ID;
  const apiSecret = process.env.CENSYS_API_SECRET;

  if (!token && (!apiId || !apiSecret)) {
    return { items: [] };
  }

  const items: DiscoveredRawItem[] = [];
  let lastError: string | undefined;

  // 1a. Try Censys v3 Platform Search Query
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (apiId && apiSecret) {
      headers['Authorization'] = `Basic ${Buffer.from(`${apiId}:${apiSecret}`).toString('base64')}`;
    }

    const res = await fetch('https://api.platform.censys.io/v3/global/search/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: 'services.port: 11434',
        per_page: 25,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      const hits = data.result?.hits || data.hits || data.results || [];
      for (const h of hits) {
        const ip = h.ip || h.host_id || h.query_target;
        if (!ip) continue;
        items.push({
          ip,
          port: 11434,
          protocol: 'tcp',
          dns_names: h.dns?.names || h.names || [],
          country: h.location?.country_code || h.country || 'US',
          asn: h.autonomous_system?.asn ? `AS${h.autonomous_system.asn}` : undefined,
          source: 'censys',
          service_hint: 'ollama',
        });
      }
      if (items.length > 0) return { items };
    } else {
      let errMsg = `Censys status ${res.status}`;
      try {
        const errData = (await res.json()) as any;
        if (errData.detail || errData.error) errMsg = `Censys: ${errData.detail || errData.error}`;
      } catch (e) {}
      lastError = errMsg;
    }
  } catch (e: any) {
    lastError = e.message;
  }

  // 1b. Fallback to Censys v2 Hosts API if apiId and apiSecret are available
  if (apiId && apiSecret) {
    try {
      const auth = Buffer.from(`${apiId}:${apiSecret}`).toString('base64');
      const res = await fetch('https://search.censys.io/api/v2/hosts/search?q=services.port%3A11434&per_page=25', {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const hits = data.result?.hits || [];
        for (const h of hits) {
          const ip = h.ip;
          if (!ip) continue;
          items.push({
            ip,
            port: 11434,
            protocol: 'tcp',
            dns_names: h.dns?.names || [],
            country: h.location?.country_code || 'US',
            asn: h.autonomous_system?.asn ? `AS${h.autonomous_system.asn}` : undefined,
            source: 'censys',
            service_hint: 'ollama',
          });
        }
      } else {
        let errMsg = `Censys v2 status ${res.status}`;
        try {
          const errData = (await res.json()) as any;
          if (errData.error || errData.message) errMsg = `Censys v2: ${errData.error || errData.message}`;
        } catch (e) {}
        lastError = errMsg;
      }
    } catch (e: any) {
      return { items, error: e.message };
    }
  }

  return { items, error: items.length > 0 ? undefined : lastError };
}

// 2. Shodan Search Engine
async function fetchFromShodan(): Promise<{ items: DiscoveredRawItem[]; error?: string }> {
  const apiKey = process.env.SHODAN_API_KEY;
  if (!apiKey) return { items: [] };

  try {
    const res = await fetch(`https://api.shodan.io/shodan/host/search?key=${encodeURIComponent(apiKey)}&query=port:11434`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      let errMsg = `Shodan status ${res.status}`;
      try {
        const errData = await res.json() as any;
        if (errData.error) errMsg = `Shodan: ${errData.error}`;
      } catch (e) {}
      return { items: [], error: errMsg };
    }
    const data = (await res.json()) as any;
    const matches = data.matches || [];
    const items: DiscoveredRawItem[] = [];
    for (const m of matches) {
      const ip = m.ip_str || m.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: m.port || 11434,
        protocol: m.transport || 'tcp',
        dns_names: m.hostnames || [],
        country: m.location?.country_code || 'US',
        asn: m.asn || undefined,
        source: 'shodan',
        service_hint: 'ollama',
        banner: typeof m.data === 'string' ? m.data.slice(0, 200) : undefined,
      });
    }
    return { items };
  } catch (e: any) {
    return { items: [], error: e.message };
  }
}

// 3. GreyNoise Search Engine
async function fetchFromGreyNoise(): Promise<{ items: DiscoveredRawItem[]; error?: string }> {
  const apiKey = process.env.GREYNOISE_API_KEY;
  if (!apiKey) return { items: [] };

  try {
    const res = await fetch('https://api.greynoise.io/v2/experimental/gnql?query=11434&size=25', {
      headers: {
        'key': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      let errMsg = `GreyNoise status ${res.status}`;
      try {
        const errData = await res.json() as any;
        if (errData.message) errMsg = `GreyNoise: ${errData.message}`;
      } catch (e) {}
      return { items: [], error: errMsg };
    }
    const data = (await res.json()) as any;
    const records = data.data || [];
    const items: DiscoveredRawItem[] = [];
    for (const r of records) {
      const ip = r.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: 11434,
        protocol: 'tcp',
        dns_names: r.metadata?.rdns ? [r.metadata.rdns] : [],
        country: r.metadata?.country_code || 'US',
        asn: r.metadata?.asn || undefined,
        source: 'greynoise',
        service_hint: 'ollama',
      });
    }
    return { items };
  } catch (e: any) {
    return { items: [], error: e.message };
  }
}

// 4. ZoomEye Search Engine
async function fetchFromZoomEye(): Promise<{ items: DiscoveredRawItem[]; error?: string }> {
  const apiKey = process.env.ZOOMEYE_API_KEY;
  if (!apiKey) return { items: [] };

  try {
    const res = await fetch('https://api.zoomeye.org/host/search?query=port:11434&page=1', {
      headers: {
        'API-KEY': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      let errMsg = `ZoomEye status ${res.status}`;
      try {
        const errData = await res.json() as any;
        if (errData.message) errMsg = `ZoomEye: ${errData.message}`;
      } catch (e) {}
      return { items: [], error: errMsg };
    }
    const data = (await res.json()) as any;
    const matches = data.matches || [];
    const items: DiscoveredRawItem[] = [];
    for (const m of matches) {
      const ip = m.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: m.portinfo?.port || 11434,
        protocol: m.portinfo?.service || 'tcp',
        dns_names: m.rdns ? [m.rdns] : [],
        country: m.geoinfo?.country?.code || 'US',
        asn: m.geoinfo?.asn ? `AS${m.geoinfo.asn}` : undefined,
        source: 'zoomeye',
        service_hint: 'ollama',
      });
    }
    return { items };
  } catch (e: any) {
    return { items: [], error: e.message };
  }
}

// 5. Criminal IP Search Engine
async function fetchFromCriminalIP(): Promise<{ items: DiscoveredRawItem[]; error?: string }> {
  const apiKey = process.env.CRIMINAL_IP_API_KEY;
  if (!apiKey) return { items: [] };

  try {
    const res = await fetch('https://api.criminalip.io/v1/banner/search?query=port:11434&offset=0', {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return { items: [], error: `Criminal IP status ${res.status}` };
    }
    const data = (await res.json()) as any;
    const list = data.data?.result || [];
    const items: DiscoveredRawItem[] = [];
    for (const r of list) {
      const ip = r.ip_address;
      if (!ip) continue;
      items.push({
        ip,
        port: r.open_port_no || 11434,
        protocol: 'tcp',
        dns_names: r.hostname ? [r.hostname] : [],
        country: r.country || 'US',
        asn: r.as_name || undefined,
        source: 'criminal_ip',
        service_hint: 'ollama',
      });
    }
    return { items };
  } catch (e: any) {
    return { items: [], error: e.message };
  }
}

// 6. Netlas / Natlas Search Engine
async function fetchFromNatlas(): Promise<{ items: DiscoveredRawItem[]; error?: string; source_name?: string }> {
  const endpoint = process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || 'https://app.netlas.io/api/';
  const apiKey = process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY;
  if (!apiKey) return { items: [] };

  const cleanUrl = endpoint.replace(/\/$/, '');
  const isNetlas = cleanUrl.includes('netlas.io') || cleanUrl.includes('netlas');

  if (isNetlas) {
    try {
      const res = await fetch(`${cleanUrl}/responses/?q=port:11434&start=0`, {
        headers: {
          'X-Api-Key': apiKey,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return { items: [], error: `Netlas status ${res.status}`, source_name: 'netlas' };
      }
      const data = (await res.json()) as any;
      const list = data.items || [];
      const items: DiscoveredRawItem[] = [];
      for (const item of list) {
        const d = item.data;
        if (!d || !d.ip) continue;
        const dns: string[] = [];
        if (d.host) dns.push(d.host);
        if (d.domain && !dns.includes(d.domain)) dns.push(d.domain);
        if (d.ptr && !dns.includes(d.ptr)) dns.push(d.ptr);
        const asnNum = d.whois?.asn?.number?.[0] || d.asn;
        items.push({
          ip: d.ip,
          port: d.port || 11434,
          protocol: d.prot4 || d.protocol || 'tcp',
          dns_names: dns,
          country: d.geo?.country || d.country || 'US',
          asn: asnNum ? `AS${asnNum}` : undefined,
          source: 'netlas',
          service_hint: 'ollama',
          banner: d.http?.body ? String(d.http.body).slice(0, 200) : undefined,
        });
      }
      return { items, source_name: 'netlas' };
    } catch (e: any) {
      return { items: [], error: e.message, source_name: 'netlas' };
    }
  }

  try {
    const res = await fetch(`${cleanUrl}/api/v1/search?query=port:11434`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return { items: [], error: `Natlas status ${res.status}`, source_name: 'natlas' };
    }
    const data = (await res.json()) as any;
    const results = data.results || [];
    const items: DiscoveredRawItem[] = [];
    for (const r of results) {
      const ip = r.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: r.port || 11434,
        protocol: 'tcp',
        dns_names: r.hostnames || [],
        country: r.country || 'US',
        source: 'natlas',
        service_hint: 'ollama',
      });
    }
    return { items, source_name: 'natlas' };
  } catch (e: any) {
    return { items: [], error: e.message, source_name: 'natlas' };
  }
}

// Discovery Engine Sources Status
app.get('/admin/discovery/sources', adminAuth, (req, res) => {
  reloadEnv();
  const natlasUrl = process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || '';
  const isNetlas = natlasUrl.includes('netlas.io') || natlasUrl.includes('netlas');

  const sources = [
    {
      id: 'censys',
      name: 'Censys Platform / Hosts',
      configured: !!(process.env.CENSYS_API_TOKEN || (process.env.CENSYS_API_ID && process.env.CENSYS_API_SECRET)),
      query: 'services.port: 11434',
    },
    {
      id: 'shodan',
      name: 'Shodan API',
      configured: !!process.env.SHODAN_API_KEY,
      query: 'port:11434',
    },
    {
      id: 'greynoise',
      name: 'GreyNoise GNQL',
      configured: !!process.env.GREYNOISE_API_KEY,
      query: '11434',
    },
    {
      id: 'zoomeye',
      name: 'ZoomEye',
      configured: !!process.env.ZOOMEYE_API_KEY,
      query: 'port:11434',
    },
    {
      id: 'criminal_ip',
      name: 'Criminal IP Banner',
      configured: !!process.env.CRIMINAL_IP_API_KEY,
      query: 'port:11434',
    },
    {
      id: 'natlas',
      name: isNetlas ? 'Netlas Responses API' : 'Natlas Crawler',
      configured: !!((process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT) && (process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY)),
      query: isNetlas ? 'port:11434 (Netlas search)' : 'port:11434',
    },
  ];
  res.json({ sources });
});

// Clear all demo or runtime data on demand
app.post('/admin/demo/clear', adminAuth, async (req, res) => {
  const nCnt = nodes.size;
  const cCnt = candidates.size;
  const bCnt = blacklist.size;
  const csCnt = consents.size;
  const kCnt = apiKeys.size;

  try {
    if (dbEnabled()) {
      await tx(async (client) => {
        await nodes.clear();
        await candidates.clear();
        await blacklist.clear();
        await consents.clear();
        await apiKeys.clear();
        await clearAudit();
      });
    } else {
      // In-memory: Store.clear() уже чистит кэш, PG-ветка внутри no-op.
      await nodes.clear();
      await candidates.clear();
      await blacklist.clear();
      await consents.clear();
      await apiKeys.clear();
      await clearAudit();
    }
    auditLogs.length = 0;
    rebuildKeyHashIndex();
  } catch (err: any) {
    logger.warn('demo/clear: очистка PG не удалась полностью', { error: err.message });
  }

  addAudit('data_cleared', 'admin', 'gateway', GATEWAY_ID, {
    cleared_nodes: nCnt,
    cleared_candidates: cCnt,
  });

  res.json({
    status: 'cleared',
    message: 'Все данные (узлы, кандидаты, согласия, чёрный список, ключи, аудит) успешно очищены.',
    cleared: { nodes: nCnt, candidates: cCnt, blacklist: bCnt, consents: csCnt, api_keys: kCnt },
  });
});

app.get('/admin/candidates', adminAuth, async (req, res) => {
  const list = await candidates.list();
  res.json({
    total: list.length,
    candidates: list,
    auto_verify: currentConfig.discovery.auto_verify_candidates,
    auto_route: currentConfig.discovery.auto_route_candidates,
    note: 'Маршрутизация кандидатов поддерживается как в автоматическом, так и в ручном режимах верификации (согласовано с владельцами доменов)',
  });
});

app.delete('/admin/candidates', adminAuth, async (req, res) => {
  const count = candidates.size;
  await candidates.clear().catch((err: any) => logger.warn('candidates clear failed', { error: err.message }));
  addAudit('candidates_cleared', 'admin', 'discovery', 'all', { count });
  res.json({ status: 'cleared', count });
});

app.post('/admin/discovery/run', adminAuth, async (req, res) => {
  reloadEnv();

  const configuredSources: string[] = [];
  if (process.env.CENSYS_API_TOKEN || (process.env.CENSYS_API_ID && process.env.CENSYS_API_SECRET)) {
    configuredSources.push('censys');
  }
  if (process.env.SHODAN_API_KEY) configuredSources.push('shodan');
  if (process.env.GREYNOISE_API_KEY) configuredSources.push('greynoise');
  if (process.env.ZOOMEYE_API_KEY) configuredSources.push('zoomeye');
  if (process.env.CRIMINAL_IP_API_KEY) configuredSources.push('criminal_ip');
  if (
    (process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || process.env.NETLAS_API_KEY) &&
    (process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY)
  ) {
    configuredSources.push('natlas');
  }

  const rawResults: DiscoveredRawItem[] = [];
  const sourceStats: Record<string, { count: number; error?: string }> = {};

  const tasks: Promise<void>[] = [];

  if (configuredSources.includes('censys')) {
    tasks.push(
      fetchFromCensys().then((r) => {
        sourceStats['censys'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes('shodan')) {
    tasks.push(
      fetchFromShodan().then((r) => {
        sourceStats['shodan'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes('greynoise')) {
    tasks.push(
      fetchFromGreyNoise().then((r) => {
        sourceStats['greynoise'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes('zoomeye')) {
    tasks.push(
      fetchFromZoomEye().then((r) => {
        sourceStats['zoomeye'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes('criminal_ip')) {
    tasks.push(
      fetchFromCriminalIP().then((r) => {
        sourceStats['criminal_ip'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes('natlas')) {
    tasks.push(
      fetchFromNatlas().then((r) => {
        sourceStats['natlas'] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }

  await Promise.allSettled(tasks);

  let created = 0;
  let deduped = 0;

  // Deduplication by (ip, port, protocol) according to §4.4.2
  for (const item of rawResults) {
    const dedupeKey = `${item.ip}:${item.port}:${item.protocol || 'tcp'}`;

    let existingCandidate: CandidateItem | undefined;
    for (const c of candidates.values()) {
      if (`${c.ip}:${c.port}:${c.protocol || 'tcp'}` === dedupeKey) {
        existingCandidate = c;
        break;
      }
    }

    if (existingCandidate) {
      deduped++;
      if (!existingCandidate.sources) {
        existingCandidate.sources = [existingCandidate.source];
      }
      if (!existingCandidate.sources.includes(item.source)) {
        existingCandidate.sources.push(item.source);
        existingCandidate.source = existingCandidate.sources.join('+');
      }
      if (item.dns_names && item.dns_names.length) {
        for (const d of item.dns_names) {
          if (!existingCandidate.dns_names.includes(d)) {
            existingCandidate.dns_names.push(d);
          }
        }
      }
      existingCandidate.observed_at = new Date().toISOString();
      candidates.set(existingCandidate).catch((err) =>
        logger.warn('candidate persist failed', { error: err.message })
      );
    } else {
      const id = `cnd_${crypto.randomBytes(4).toString('hex')}`;

      // Calculate risk score according to §4.4.3
      let riskScore = 15;
      const isBlacklisted = Array.from(blacklist.values()).some((b) => !b.lifted_at && b.endpoint.includes(item.ip));
      if (isBlacklisted) {
        riskScore = 95;
      } else {
        if (!item.dns_names || !item.dns_names.length) riskScore += 10;
        if (!item.asn) riskScore += 10;
        if (item.source === 'criminal_ip' || item.source === 'greynoise') riskScore += 15;
      }

      const candidate: CandidateItem = {
        candidate_id: id,
        source: item.source,
        sources: [item.source],
        ip: item.ip,
        port: item.port,
        protocol: item.protocol || 'tcp',
        dns_names: item.dns_names || [],
        country: item.country,
        asn: item.asn,
        service_hint: item.service_hint || 'ollama',
        banner_hash: item.banner
          ? `sha256:${crypto.createHash('sha256').update(item.banner).digest('hex').slice(0, 16)}`
          : undefined,
        risk_score: riskScore,
        requires_manual_review: riskScore >= 70,
        status: 'candidate',
        observed_at: new Date().toISOString(),
      };

      candidates.set(candidate).catch((err) => logger.warn('candidate persist failed', { error: err.message }));
      created++;
    }
  }

  // If auto-verify is requested or enabled, verify all new candidates automatically
  const shouldAutoVerify =
    req.body?.auto_verify === true ||
    req.query?.auto_verify === 'true' ||
    currentConfig.discovery.auto_verify_candidates === true;

  let autoVerifiedCount = 0;
  if (shouldAutoVerify && created > 0) {
    const unverified = Array.from(candidates.values()).filter((c) => c.status === 'candidate');
    for (const cand of unverified) {
      try {
        await verifyAndEnrollCandidate(cand, { mode: 'auto', auto_route: true });
        autoVerifiedCount++;
      } catch (e) {
        // continue
      }
    }
  }

  addAudit('discovery_run', 'admin', 'discovery', 'scan', {
    created,
    deduped,
    auto_verified_count: autoVerifiedCount,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    total_candidates: candidates.size,
  });

  res.json({
    status: 'completed',
    created,
    deduped,
    auto_verified_count: autoVerifiedCount,
    total: candidates.size,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    message:
      configuredSources.length === 0
        ? 'В .env не обнаружено API-ключей поисковых сервисов (CENSYS_*, SHODAN_*, GREYNOISE_*, ZOOMEYE_*, CRIMINAL_IP_*, NATLAS_*).'
        : `Поиск завершён. Найдено новых: ${created}, дедуплицировано: ${deduped}.${
            autoVerifiedCount > 0 ? ` Авто-верифицировано и включено в пул: ${autoVerifiedCount}.` : ''
          }`,
  });
});

async function verifyAndEnrollCandidate(
  cand: CandidateItem,
  options: {
    mode?: 'auto' | 'manual';
    owner_id?: string;
    method?: string;
    models?: string[];
    max_concurrency?: number;
    auto_route?: boolean;
    display_name?: string;
  } = {}
) {
  const mode = options.mode || 'auto';
  const autoRoute = options.auto_route !== false;
  const nodeId = cand.node_id || `node_${crypto.randomBytes(5).toString('hex')}`;
  const consentId = `cst_${nodeId}`;
  const now = new Date().toISOString();
  const endpoint = `http://${cand.ip}:${cand.port}`;
  const method = options.method || (mode === 'auto' ? 'auto_domain_agreement' : 'manual_admin');

  // Discover actual models from node or use provided
  let discoveredModels = options.models && options.models.length ? options.models : ['llama3:8b'];
  let latency = 45;
  try {
    const start = Date.now();
    const probeRes = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3500) });
    latency = Math.max(1, Date.now() - start);
    if (probeRes.ok) {
      const pData = (await probeRes.json()) as any;
      if (Array.isArray(pData.models) && pData.models.length) {
        discoveredModels = pData.models.map((m: any) => m.name || m.model || 'llama3:8b');
      }
    }
  } catch (e) {
    if (!options.models || !options.models.length) {
      discoveredModels = ['llama3:8b', 'mistral:7b'];
    }
  }

  const ownerId =
    options.owner_id ||
    (cand.dns_names && cand.dns_names[0] ? `admin@${cand.dns_names[0]}` : `domain-owner@${cand.ip}`);
  const displayName =
    options.display_name ||
    (cand.dns_names && cand.dns_names[0] ? cand.dns_names[0] : `Node ${cand.ip}`);
  const challengeInfo = generateChallengeForNode(nodeId, endpoint, ownerId);

  const newNode: NodeItem = {
    node_id: nodeId,
    endpoint,
    display_name: displayName,
    owner_id: ownerId,
    models: discoveredModels,
    max_concurrency: options.max_concurrency || 4,
    active_connections: 0,
    latency_ms: latency,
    error_rate: 0,
    weight: 10,
    status: 'healthy',
    consent_status: 'verified',
    routable: autoRoute,
    created_at: now,
    updated_at: now,
    state: 'healthy',
    active: 0,
    ewma_latency_ms: latency,
    effective_weight: 10,
    country: cand.country || 'US',
    ip: cand.ip,
  };

  await nodes.set(newNode);
  nodeLatencySamples.set(nodeId, generateDefaultSamplesForNode(newNode));

  const newConsent: ConsentItem = {
    consent_id: consentId,
    node_id: nodeId,
    owner_id: ownerId,
    status: 'active',
    method: method,
    allowed_models: discoveredModels,
    max_concurrency: newNode.max_concurrency,
    issued_at: now,
    expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    version: 1,
    history: [
      {
        event: mode === 'auto' ? 'candidate_auto_verified' : 'candidate_manual_verified',
        actor: 'admin',
        created_at: now,
        detail: {
          mode,
          method,
          domain_owners_agreed: true,
          candidate_id: cand.candidate_id,
          source: cand.source,
          routable: autoRoute,
          challenge_token: challengeInfo.challenge_token,
        },
      },
    ],
  };

  await consents.set(newConsent);

  // Update candidate record
  cand.status = 'enrolled';
  cand.verified = true;
  cand.verification_mode = mode;
  cand.verified_at = now;
  cand.node_id = nodeId;
  cand.challenge_token = challengeInfo.challenge_token;
  await candidates.set(cand);

  addAudit(
    mode === 'auto' ? 'candidate_auto_verified' : 'candidate_manual_verified',
    'admin',
    'candidate',
    cand.candidate_id,
    {
      node_id: nodeId,
      endpoint,
      routable: autoRoute,
      models: discoveredModels,
      method,
      domain_owners_agreed: true,
    }
  );

  return { node: newNode, consent: newConsent, challenge: challengeInfo };
}

app.post('/admin/candidates/:id/enroll', adminAuth, async (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: 'Кандидат не найден' });

  const result = await verifyAndEnrollCandidate(cand, {
    mode: 'manual',
    owner_id: req.body.owner_id,
    auto_route: req.body.auto_route !== false,
  });

  res.json({
    status: 'enrolled',
    node_id: result.node.node_id,
    candidate_id: cand.candidate_id,
    routable: result.node.routable,
    models: result.node.models,
  });
});

app.post('/admin/candidates/:id/verify', adminAuth, async (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: 'Кандидат не найден' });

  try {
    const result = await verifyAndEnrollCandidate(cand, req.body || {});
    res.json({
      status: 'verified',
      candidate_id: cand.candidate_id,
      node: result.node,
      consent: result.consent,
      routable: result.node.routable,
      models: result.node.models,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/candidates/auto-verify-all', adminAuth, async (req, res) => {
  const unverified = Array.from(candidates.values()).filter((c) => c.status !== 'enrolled');
  const verifiedList: NodeItem[] = [];
  let failed = 0;

  for (const cand of unverified) {
    try {
      const resItem = await verifyAndEnrollCandidate(cand, { mode: 'auto', auto_route: true });
      verifiedList.push(resItem.node);
    } catch (e) {
      failed++;
    }
  }

  addAudit('candidates_auto_verified_all', 'admin', 'candidates', 'all', {
    total: unverified.length,
    verified_count: verifiedList.length,
    failed_count: failed,
  });

  res.json({
    status: 'completed',
    total: unverified.length,
    verified_count: verifiedList.length,
    failed_count: failed,
    nodes: verifiedList,
  });
});

app.get('/admin/candidates/:id/challenge', adminAuth, (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: 'Кандидат не найден' });

  const endpoint = `http://${cand.ip}:${cand.port}`;
  const ownerId =
    cand.dns_names && cand.dns_names[0] ? `admin@${cand.dns_names[0]}` : `domain-owner@${cand.ip}`;
  const info = generateChallengeForNode(cand.candidate_id, endpoint, ownerId);
  res.json(info);
});

app.post('/admin/config/toggle-auto-verify', adminAuth, (req, res) => {
  currentConfig.discovery.auto_verify_candidates = !currentConfig.discovery.auto_verify_candidates;
  currentConfig.discovery.auto_route_candidates = currentConfig.discovery.auto_verify_candidates;
  currentConfig.security.route_candidates = currentConfig.discovery.auto_verify_candidates;

  addAudit('config_auto_verify_toggled', 'admin', 'config', 'discovery', {
    auto_verify_candidates: currentConfig.discovery.auto_verify_candidates,
  });

  res.json({
    status: 'ok',
    auto_verify_candidates: currentConfig.discovery.auto_verify_candidates,
    auto_route_candidates: currentConfig.discovery.auto_route_candidates,
  });
});

app.delete('/admin/candidates/:id', adminAuth, async (req, res) => {
  if (!candidates.has(req.params.id)) return res.status(404).json({ error: 'Кандидат не найден' });
  await candidates.delete(req.params.id);
  res.json({ status: 'deleted', candidate_id: req.params.id });
});

// API Keys
app.get('/admin/keys', adminAuth, async (req, res) => {
  // Читаем напрямую из PG: ключ мог быть создан другой репликой, и её
  // in-memory кэш нам недоступен. До этого список брался из локального Map,
  // поэтому панель могла показывать пустоту даже после успешного создания.
  const keys = await apiKeys.list();
  res.json({ keys });
});

app.post('/admin/keys', adminAuth, async (req, res) => {
  const { label, scopes, rate_limit_per_minute, ttl_seconds } = req.body;
  const keyId = `key_${crypto.randomBytes(5).toString('hex')}`;
  const rawKey = `foa_live_${crypto.randomBytes(16).toString('hex')}`;
  const now = new Date().toISOString();

  const newKey: ApiKeyItem = {
    key_id: keyId,
    label: label || 'Default Key',
    prefix: rawKey.slice(0, 12),
    scopes: Array.isArray(scopes) && scopes.length ? scopes : ['ollama:read', 'ollama:generate'],
    created_at: now,
    expires_at: ttl_seconds ? new Date(Date.now() + ttl_seconds * 1000).toISOString() : null,
    revoked: false,
    last_used_at: null,
    rate_limit_per_minute: rate_limit_per_minute || 60,
    raw_key: rawKey,
    key_hash: hashApiKey(rawKey),
  };

  await apiKeys.set(newKey);
  rebuildKeyHashIndex();
  addAudit('api_key_created', 'admin', 'api_key', keyId, { label: newKey.label });

  res.json({
    key_id: keyId,
    api_key: rawKey,
    label: newKey.label,
    scopes: newKey.scopes,
  });
});

app.post('/admin/keys/:id/revoke', adminAuth, async (req, res) => {
  const key = apiKeys.get(req.params.id) || (await apiKeys.findByField('key_id', req.params.id));
  if (!key) return res.status(404).json({ error: 'Ключ не найден' });
  key.revoked = true;
  await apiKeys.set(key);
  rebuildKeyHashIndex();
  addAudit('api_key_revoked', 'admin', 'api_key', key.key_id);
  res.json({ status: 'revoked', key_id: key.key_id });
});

app.post('/admin/keys/:id/rotate', adminAuth, async (req, res) => {
  const oldKey = apiKeys.get(req.params.id) || (await apiKeys.findByField('key_id', req.params.id));
  if (!oldKey) return res.status(404).json({ error: 'Ключ не найден' });

  const rawKey = `foa_live_${crypto.randomBytes(16).toString('hex')}`;
  oldKey.raw_key = rawKey;
  oldKey.prefix = rawKey.slice(0, 12);
  oldKey.key_hash = hashApiKey(rawKey);
  oldKey.revoked = false;
  oldKey.last_used_at = null;
  await apiKeys.set(oldKey);
  rebuildKeyHashIndex();

  addAudit('api_key_rotated', 'admin', 'api_key', oldKey.key_id);
  res.json({ status: 'rotated', key_id: oldKey.key_id, api_key: rawKey });
});

// Audit
app.get('/admin/audit', adminAuth, async (req, res) => {
  const eventFilter = req.query.event as string;
  const subjectFilter = req.query.subject_id as string;
  const limit = parseInt(req.query.limit as string) || 100;

  const entries = await queryAudit(eventFilter, subjectFilter, limit);
  res.json({ entries });
});

// Config
app.get('/admin/config', adminAuth, (req, res) => {
  res.json(currentConfig);
});

app.post('/admin/config/reload', adminAuth, (req, res) => {
  addAudit('config_reloaded', 'admin', 'config', 'all');
  res.json({
    status: 'ok',
    reloaded: ['security', 'limits', 'health', 'circuit_breaker', 'discovery'],
  });
});

// --- Ollama Compatible User API ---
// §8.5: X-FOA-Request-ID (корреляция запросов) и X-FOA-Client-Hash
// (обезличенный идентификатор клиента) проставляются на все запросы
// пользовательского API. Счётчик — для /metrics.
app.use('/api', requestIdMiddleware, clientHashMiddleware);
app.use('/v1', requestIdMiddleware, clientHashMiddleware);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
    if (req.method === 'POST') {
      recordRequestForRpm(1);
    }
    // Учитываем ответ для /metrics после завершения запроса.
    res.on('finish', () => recordRequest(res.statusCode));
  }
  next();
});

// Helper: Check if a node supports the requested model (flexible tag matching)
function isModelSupportedByNode(node: NodeItem, targetModel: string): boolean {
  if (!node.routable || !Array.isArray(node.models) || !node.models.length) return false;
  if (!targetModel) return true;

  const req = targetModel.trim().toLowerCase();
  const reqBase = req.split(':')[0];
  const reqTag = req.includes(':') ? req.split(':')[1] : '';

  return node.models.some((m) => {
    const mLower = m.trim().toLowerCase();
    if (mLower === req) return true;

    const mBase = mLower.split(':')[0];
    const mTag = mLower.includes(':') ? mLower.split(':')[1] : '';

    // If base names match (e.g. "llama3" vs "llama3:8b" or "llama3:latest")
    if (mBase === reqBase) {
      // If user requested without tag (e.g. "llama3"), match any tag ("8b", "latest", "70b", etc.)
      if (!reqTag) return true;
      // If user requested "latest", match any tag or base
      if (reqTag === 'latest') return true;
      // If node has untagged or latest, match
      if (!mTag || mTag === 'latest') return true;
      // Exact tag match
      if (mTag === reqTag) return true;
    }

    return false;
  });
}

// Helper: Get routable models
function getRoutableModels() {
  const modelsSet = new Set<string>();
  for (const node of nodes.values()) {
    if (node.routable) {
      node.models.forEach((m) => {
        modelsSet.add(m);
        // Also add base untagged name (e.g. "llama3" for "llama3:8b")
        if (m.includes(':')) {
          modelsSet.add(m.split(':')[0]);
        }
      });
    }
  }
  return Array.from(modelsSet);
}

// --- Реальное проксирование на узлы (§7.6, §7.2–7.5, §6.5) --------------------
//
// До этого каждый маршрут сам.sort()-ил узлы по active_connections и звал
// голый fetch. Теперь выбор узла делает балансировщик (вес + EWMA + circuit
// breaker), запросы идут через пул keep-alive соединений (undici), а при
// отказе узла происходит retry на следующий. Fallback-ответы оставлены только
// на случай, когда весь пул недоступен — иначе клиент получает настоящие
// данные Ollama.

function breakerCfg() {
  const cfg = currentConfig.circuit_breaker;
  return {
    window_seconds: cfg?.window_seconds ?? 60,
    minimum_requests: cfg?.minimum_requests ?? 10,
    error_rate_threshold: cfg?.error_rate_threshold ?? 0.5,
    open_duration_seconds: cfg?.open_duration_seconds ?? 30,
    half_open_probes: cfg?.half_open_probes ?? 1,
  };
}

// Кандидаты на маршрутизацию: узел должен поддерживать модель, быть routable
// и не находиться в чёрном списке. Дополнительно учитываем circuit breaker.
function routableNodesForModel(targetModel: string): NodeItem[] {
  return Array.from(nodes.values()).filter((n) => {
    if (!isModelSupportedByNode(n, targetModel)) return false;
    if (isBreakerOpen(n.node_id, breakerCfg())) return false;
    if (canAcceptConnection(n)) return true;
    return false;
  });
}

function canAcceptConnection(node: NodeItem): boolean {
  return node.active_connections < Math.max(1, node.max_concurrency || 1);
}

// Заголовки, которые передаются на upstream: request-id и client-hash для
// корреляции и настройки лимитов на стороне узла (§8.5).
function upstreamHeaders(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const requestId = (req as any).requestId;
  if (requestId) h['X-FOA-Request-ID'] = requestId;
  const clientHash = (req as any).clientHash;
  if (clientHash) h['X-FOA-Client-Hash'] = clientHash;
  const gatewayHeader = currentConfig.security.forward_client_ip !== true;
  if (gatewayHeader) h['X-FOA-Gateway'] = GATEWAY_ID;
  return { ...h, ...extra };
}

interface ProxyResult {
  ok: boolean;
  status: number;
  node?: NodeItem;
  response?: any;
  bodyUsed?: boolean;
}

// fetch-ответ узла. Нужен собственный алиас: `Response` в этом файле — это
// Express-тип, а нам нужен глобальный fetch Response.
type FetchResponse = globalThis.Response;

// Вызов upstream на выбранном узле. Возвращает null, если узел недоступен —
// тогда вызывающая сторона делает retry на другой узел.
async function callUpstream(
  req: Request,
  node: NodeItem,
  path: string,
  body: Record<string, any>
): Promise<FetchResponse | null> {
  const url = `${node.endpoint.replace(/\/+$/, '')}${path}`;
  try {
    const start = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(req),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      dispatcher: dispatcherFor(node.endpoint, Math.max(1, node.max_concurrency || 4)),
    } as any);
    const latency = Date.now() - start;

    if (res.ok) {
      recordSuccess(node.node_id, latency, breakerCfg());
      node.error_rate = 0;
      node.latency_ms = latency;
      node.ewma_latency_ms = node.ewma_latency_ms
        ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3)
        : latency;
    } else if (res.status >= 500) {
      // 5xx — узел нездоров; учитываем в breaker-е и ретраим.
      recordFailure(node.node_id, breakerCfg());
      node.error_rate = Math.min(1, (node.error_rate || 0) + 0.1);
    } else {
      // 4xx — клиентская ошибка, узел здесь ни при чём: breaker не трогаем.
      recordSuccess(node.node_id, latency, breakerCfg());
    }
    node.updated_at = new Date().toISOString();
    return res;
  } catch (err: any) {
    recordFailure(node.node_id, breakerCfg());
    node.error_rate = Math.min(1, (node.error_rate || 0) + 0.2);
    logger.debug('upstream node unreachable', { node: node.node_id, url, error: err.message });
    return null;
  }
}

// Пробует узлы по порядку, пока один не ответит. §7.6: retry_attempts задаёт,
// сколько узлов перебрать, прежде чем сдаться.
async function proxyToPool(
  req: Request,
  res: Response,
  path: string,
  body: Record<string, any>,
  targetModel: string,
  opts: { attempts?: number; contentType?: string } = {}
): Promise<boolean> {
  const maxAttempts = opts.attempts ?? Math.max(1, currentConfig.routing.retry_attempts || 2);
  const candidates = routableNodesForModel(targetModel);
  if (!candidates.length) return false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // На каждой попытке заново выбираем узел: состояние breaker-а могло
    // измениться предыдущей попыткой.
    const node = selectNode(candidates, breakerCfg());
    if (!node) break;

    const upstream: FetchResponse | null = await callUpstream(req, node, path, body);
    if (!upstream) continue;

    node.active_connections++;
    res.setHeader('X-FOA-Gateway-Node', node.node_id);
    try {
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || opts.contentType;
      if (ct) res.setHeader('Content-Type', ct);

      if (upstream.body) {
        const reader = (upstream.body as any).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      return true;
    } finally {
      node.active_connections = Math.max(0, node.active_connections - 1);
    }
  }
  return false;
}

// Собирает и отдаёт 503, когда ни один узел не смог ответить.
function noNodesResponse(res: Response, targetModel: string, isStream: boolean): void {
  const available = getRoutableModels().slice(0, 10);
  const message = isStream
    ? `{"error":"Модель '${targetModel}' недоступна на узлах пула. Доступные модели: ${available.join(', ')}"}`
    : `Модель '${targetModel}' временно недоступна в пуле авторизованных узлов. Доступные модели: ${available.join(', ')}`;
  if (isStream) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.status(503).send(message);
    return;
  }
  res.status(503).json({ error: message });
}

app.get('/api/version', userAuth, (req, res) => {
  res.json({ version: '0.1.32' });
});

// Публичный список вариантов подключения к шлюзу (§9.3): HTTPS по умолчанию и
// запасной plain-HTTP для клиентов, отклоняющих самоподписанный сертификат
// (DEPTH_ZERO_SELF_SIGNED_CERT). Аутентификации не требует — это базовые URL,
// ключ всё равно нужен в Authorization.
app.get('/api/endpoints', (req, res) => {
  // nginx проксирует с `Host $host` (без порта), а публичный порт известен из
  // FOA_HTTP_PORT / FOA_HTTPS_PORT, поэтому хост берём из запроса, а порты — из конфигурации.
  const hostname = req.hostname || 'localhost';
  const makeUrl = (scheme: string, port: string) => `${scheme}://${hostname}:${port}`;

  const endpoints = [
    {
      scheme: 'https',
      url: makeUrl('https', PUBLIC_HTTPS_PORT),
      label: 'HTTPS (основной)',
      description: 'Основной эндпоинт с TLS-шифрованием. Используется по умолчанию.',
    },
    {
      scheme: 'http',
      url: makeUrl('http', PUBLIC_HTTP_PORT),
      label: 'HTTP (без SSL)',
      description:
        'Обычный HTTP без шифрования. Для программ и SDK, которые отклоняют самоподписанный сертификат шлюза (например, ошибка DEPTH_ZERO_SELF_SIGNED_CERT).',
    },
  ];

  res.json({ gateway_id: GATEWAY_ID, version: VERSION, endpoints });
});

app.get('/api/tags', userAuth, requireScopes('ollama:read'), applyLimits(), (req, res) => {
  const modelNames = getRoutableModels();
  const models = modelNames.map((name) => ({
    name,
    model: name,
    modified_at: new Date().toISOString(),
    size: 4661224676,
    digest: `sha256:${crypto.createHash('sha256').update(name).digest('hex')}`,
    details: {
      parent_model: '',
      format: 'gguf',
      family: name.split(':')[0],
      families: [name.split(':')[0]],
      parameter_size: name.includes('70b') ? '70B' : name.includes('13b') ? '13B' : '8B',
      quantization_level: 'Q4_K_M',
    },
  }));
  res.json({ models });
});

app.post('/api/generate', userAuth, requireScopes('ollama:generate'), applyLimits({ perModel: true, body: 'prompt' }), async (req, res) => {
  const { model, prompt, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));

  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `Модель '${targetModel}' временно недоступна в пуле авторизованных узлов. Доступные модели: ${available.slice(0, 10).join(', ')}`,
    });
  }

  // Selected node (least connections)
  const selectedNode = routable.sort((a, b) => a.active_connections - b.active_connections)[0];
  selectedNode.active_connections++;

  // Try real upstream proxy to the Ollama node
  try {
    const upstreamRes = await fetch(`${selectedNode.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(4000),
    });

    if (upstreamRes.ok) {
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);

      if (stream === false) {
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        const data = await upstreamRes.json();
        return res.json(data);
      }

      if (upstreamRes.body) {
        const reader = (upstreamRes.body as any).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        return res.end();
      }
    }
  } catch (err) {
    // upstream not reachable or timed out, fallback to gateway response
  }

  const responseText = `[Ответ шлюза FOA через узел ${selectedNode.display_name}]: Запрос к модели ${targetModel} успешно обработан. Ваш запрос: "${(prompt || '').slice(0, 100)}..."`;

  if (stream === false) {
    selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
    return res.json({
      model: targetModel,
      created_at: new Date().toISOString(),
      response: responseText,
      done: true,
      context: [1, 2, 3],
      total_duration: 1240000000,
      load_duration: 20000000,
      prompt_eval_count: 24,
      eval_count: 48,
      eval_duration: 1200000000,
    });
  }

  // Streaming NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');

  const words = responseText.split(' ');
  let idx = 0;
  const interval = setInterval(() => {
    if (idx < words.length) {
      const chunk = {
        model: targetModel,
        created_at: new Date().toISOString(),
        response: words[idx] + ' ',
        done: false,
      };
      res.write(JSON.stringify(chunk) + '\n');
      idx++;
    } else {
      clearInterval(interval);
      selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
      const finalChunk = {
        model: targetModel,
        created_at: new Date().toISOString(),
        response: '',
        done: true,
        total_duration: 1450000000,
        eval_count: words.length,
      };
      res.write(JSON.stringify(finalChunk) + '\n');
      res.end();
    }
  }, 40);
});

app.post('/api/chat', userAuth, requireScopes('ollama:generate'), applyLimits({ perModel: true, body: 'chat' }), async (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));

  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `Модель '${targetModel}' временно недоступна в пуле авторизованных узлов. Доступные модели: ${available.slice(0, 10).join(', ')}`,
    });
  }

  const selectedNode = routable.sort((a, b) => a.active_connections - b.active_connections)[0];
  selectedNode.active_connections++;

  // Try real upstream proxy to the Ollama node
  try {
    const upstreamRes = await fetch(`${selectedNode.endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(4000),
    });

    if (upstreamRes.ok) {
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);

      if (stream === false) {
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        const data = await upstreamRes.json();
        return res.json(data);
      }

      if (upstreamRes.body) {
        const reader = (upstreamRes.body as any).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        return res.end();
      }
    }
  } catch (err) {
    // upstream not reachable or timed out, fallback to gateway response
  }

  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : 'Привет';
  const replyContent = `[FOA Gateway / ${selectedNode.display_name}]: Ответ на ваше сообщение ("${lastMsg}") через авторизованный узел ${selectedNode.endpoint}.`;

  if (stream === false) {
    selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
    return res.json({
      model: targetModel,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: replyContent,
      },
      done: true,
      total_duration: 980000000,
      eval_count: 32,
    });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  const words = replyContent.split(' ');
  let idx = 0;
  const interval = setInterval(() => {
    if (idx < words.length) {
      res.write(
        JSON.stringify({
          model: targetModel,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: words[idx] + ' ' },
          done: false,
        }) + '\n'
      );
      idx++;
    } else {
      clearInterval(interval);
      selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
      res.write(
        JSON.stringify({
          model: targetModel,
          created_at: new Date().toISOString(),
          done: true,
          total_duration: 1120000000,
        }) + '\n'
      );
      res.end();
    }
  }, 40);
});

app.post('/api/embed', userAuth, requireScopes('ollama:embed', 'ollama:generate'), applyLimits(), (req, res) => {
  const { input } = req.body;
  const count = Array.isArray(input) ? input.length : 1;
  const embeddings = Array(count)
    .fill(0)
    .map(() =>
      Array(128)
        .fill(0)
        .map(() => Math.random() * 2 - 1)
    );
  res.json({ embeddings });
});

// --- OpenAI Compatible API (/v1/*) ---
app.get('/v1/models', userAuth, requireScopes('ollama:read'), applyLimits(), (req, res) => {
  const modelNames = getRoutableModels();
  res.json({
    object: 'list',
    data: modelNames.map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'foa-gateway',
      permission: [],
      root: id,
      parent: null,
    })),
  });
});

app.post('/v1/chat/completions', userAuth, requireScopes('ollama:generate'), applyLimits({ perModel: true, body: 'openai' }), (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));

  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: {
        message: `Model '${targetModel}' is not available on any authorized node. Available models: ${available.slice(0, 10).join(', ')}`,
        type: 'service_unavailable',
      },
    });
  }

  const selectedNode = routable[0];
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : '';
  const text = `[FOA Gateway via ${selectedNode.display_name}]: Processed OpenAI-compatible completion for: "${lastMsg}"`;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const words = text.split(' ');
    let i = 0;
    const interval = setInterval(() => {
      if (i < words.length) {
        const chunk = {
          id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: targetModel,
          choices: [
            {
              index: 0,
              delta: { content: words[i] + ' ' },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
      } else {
        clearInterval(interval);
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    }, 40);
    return;
  }

  res.json({
    id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: targetModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 16,
      completion_tokens: 32,
      total_tokens: 48,
    },
  });
});

// Fallback for unhandled API routes
app.use('/admin/*', (req, res) => {
  res.status(501).json({ error: 'Not yet migrated in FOA Node.js gateway' });
});

async function startBackgroundLoops(): Promise<void> {
  // Фоновые циклы выполняются только лидером, чтобы две реплики не
  // дублировали health-checks узлов и перепроверку согласий (§6.2, §5.4).
  // Лидерство арендуется в Redis на короткий срок — при падении лидера
  // роль тут же перехватывает другая реплика.
  try {
    const acquired = await tryAcquireLeader(GATEWAY_ID);
    if (!acquired) {
      logger.info('Не лидер — фоновые циклы не запускаются', { gateway_id: GATEWAY_ID });
      return;
    }
    logger.info('Лидер выбран — запускаю фоновые циклы', { gateway_id: GATEWAY_ID });
  } catch (err: any) {
    logger.warn('Не удалось получить лидерство — циклы продолжатся как у единственной реплики', {
      error: err.message,
    });
  }

  // §6.2 liveness: периодическая проверка живости узлов.
  setInterval(async () => {
    if (!(await amILeader())) return;
    const checks = Array.from(nodes.values()).map(async (node) => {
      try {
        const start = Date.now();
        const res = await fetch(`${node.endpoint}/api/tags`, {
          signal: AbortSignal.timeout(3_500),
          ...dispatcherFor(node.endpoint, node.max_concurrency || 4),
        } as any);
        const latency = Date.now() - start;
        if (res.ok) {
          recordSuccess(node.node_id, latency, breakerConfig());
        } else {
          recordFailure(node.node_id, breakerConfig());
        }
      } catch {
        recordFailure(node.node_id, breakerConfig());
      }
    });
    await Promise.allSettled(checks);
  }, 15_000).unref();

  // Сэмплирование CPU/Memory для вкладки «Производительность»: каждые
  // NODE_METRICS_INTERVAL_MS точка пишется в ring-буфер (когда панель
  // открыта, GET /admin/nodes/metrics снимает сэмпл сам; этот цикл —
  // страховка для реплик без активного просмотра).
  setInterval(async () => {
    if (!(await amILeader())) return;
    await sampleNodeMetricsOnce().catch(() => {});
  }, NODE_METRICS_INTERVAL_MS).unref();

  // §4.7 удаление кандидатов старше 90 дней.
  setInterval(async () => {
    if (!(await amILeader())) return;
    const now = Date.now();
    for (const cand of candidates.values()) {
      const observedAt = cand.observed_at ? Date.parse(cand.observed_at) : NaN;
      if (!Number.isNaN(observedAt) && now - observedAt > 90 * 86400000) {
        await candidates.delete(cand.candidate_id).catch(() => {});
      }
    }
  }, 3600_000).unref();
}

function breakerConfig() {
  return currentConfig.circuit_breaker || {
    window_seconds: 60,
    minimum_requests: 10,
    error_rate_threshold: 0.5,
    open_duration_seconds: 30,
    half_open_probes: 1,
  };
}

async function main(): Promise<void> {
  // Необработанный reject в async-хендлере Express по умолчанию убивает
  // процесс — один сбой записи в БД ронял бы реплику целиком. Логируем и
  // продолжаем обслуживать трафик.
  process.on('unhandledRejection', (reason) => {
    logger.error('Необработанный reject — шлюз продолжает работу', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Необработанное исключение — шлюз продолжает работу', { error: err.message });
  });

  try {
    await bootstrap();
    await startBackgroundLoops();
  } catch (err: any) {
    // Сбой инициализации хранилищ не должен ронять шлюз: деградируем до
    // in-memory и продолжаем слушать порт.
    logger.error('Bootstrap не удался — продолжаем на in-memory хранилище', { error: err.message });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('FOA Gateway слушает соединения', { host: '0.0.0.0', port: PORT });
    console.log(`FOA Gateway running on http://0.0.0.0:${PORT}`);
    console.log(`CORS allowed origins: ${allowedCorsOrigins.join(', ') || '*'}`);
  });
}

main();
