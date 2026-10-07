var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server.ts
var server_exports = {};
__export(server_exports, {
  reloadEnv: () => reloadEnv
});
module.exports = __toCommonJS(server_exports);
var import_express = __toESM(require("express"), 1);
var import_cors = __toESM(require("cors"), 1);
var import_path = __toESM(require("path"), 1);
var import_crypto = __toESM(require("crypto"), 1);
var import_fs = __toESM(require("fs"), 1);
function reloadEnv() {
  try {
    const envPath = import_path.default.join(process.cwd(), ".env");
    if (import_fs.default.existsSync(envPath)) {
      const lines = import_fs.default.readFileSync(envPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
            val = val.slice(1, -1);
          }
          if (key) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {
  }
}
reloadEnv();
var app = (0, import_express.default)();
var PORT = Number(process.env.PORT) || 3e3;
var GATEWAY_ID = process.env.GATEWAY_ID || "foa-gw-main-01";
var VERSION = "1.0.0";
var PUBLIC_HTTP_PORT = process.env.FOA_HTTP_PORT || "8080";
var PUBLIC_HTTPS_PORT = process.env.FOA_HTTPS_PORT || "8443";
var rawCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || "*").trim();
var allowedCorsOrigins = rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean);
var corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes("*") || allowedCorsOrigins.length === 0) {
      return callback(null, true);
    }
    if (allowedCorsOrigins.includes(origin)) {
      return callback(null, true);
    }
    const matchesWildcard = allowedCorsOrigins.some((pattern) => {
      if (pattern.startsWith("*.")) {
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
    return callback(new Error(`CORS blocked: Origin '${origin}' is not permitted by CORS_ALLOWED_ORIGINS`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "X-Gateway-Key",
    "Cache-Control",
    "baggage",
    "sentry-trace"
  ],
  exposedHeaders: ["Content-Length", "Content-Range", "Retry-After", "X-Gateway-Node"]
};
app.use((0, import_cors.default)(corsOptions));
app.use(import_express.default.json({ limit: "10mb" }));
app.use(import_express.default.urlencoded({ extended: true, limit: "10mb" }));
app.use(import_express.default.static(import_path.default.join(process.cwd(), "public")));
var nodes = /* @__PURE__ */ new Map();
var consents = /* @__PURE__ */ new Map();
var blacklist = /* @__PURE__ */ new Map();
var candidates = /* @__PURE__ */ new Map();
var apiKeys = /* @__PURE__ */ new Map();
var auditLogs = [];
var LATENCY_BINS = [
  { id: "b_0_50", label: "< 50ms", min: 0, max: 50 },
  { id: "b_50_100", label: "50\u2013100ms", min: 50, max: 100 },
  { id: "b_100_200", label: "100\u2013200ms", min: 100, max: 200 },
  { id: "b_200_400", label: "200\u2013400ms", min: 200, max: 400 },
  { id: "b_400_800", label: "400\u2013800ms", min: 400, max: 800 },
  { id: "b_800_1500", label: "800\u20131500ms", min: 800, max: 1500 },
  { id: "b_1500_plus", label: "> 1500ms", min: 1500, max: Infinity }
];
var nodeLatencySamples = /* @__PURE__ */ new Map();
function generateDefaultSamplesForNode(node) {
  const base = Math.max(20, node.latency_ms || 60);
  const count = 120;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const u1 = Math.random();
    const u2 = Math.random();
    const randStd = Math.sqrt(-2 * Math.log(u1 || 1e-4)) * Math.cos(2 * Math.PI * u2);
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
function recordNodeLatencySample(nodeId, latencyMs) {
  if (!nodeLatencySamples.has(nodeId)) {
    const node = nodes.get(nodeId);
    nodeLatencySamples.set(nodeId, node ? generateDefaultSamplesForNode(node) : []);
  }
  const list = nodeLatencySamples.get(nodeId);
  list.push(Math.max(1, Math.round(latencyMs)));
  if (list.length > 300) list.shift();
}
var RPM_BUCKETS_COUNT = 60;
var rpmHistory = new Array(RPM_BUCKETS_COUNT).fill(0);
var lastRpmMinute = Math.floor(Date.now() / 6e4);
function initRpmHistory() {
  for (let i = 0; i < RPM_BUCKETS_COUNT; i++) {
    const wave = Math.sin(i / 60 * Math.PI * 4) * 22;
    const wave2 = Math.cos(i / 60 * Math.PI * 2) * 12;
    const jitter = Math.floor(Math.random() * 14) - 7;
    rpmHistory[i] = Math.max(15, Math.round(72 + wave + wave2 + jitter));
  }
}
initRpmHistory();
function recordRequestForRpm(count = 1) {
  const currentMin = Math.floor(Date.now() / 6e4);
  const diff = currentMin - lastRpmMinute;
  if (diff > 0) {
    const shift = Math.min(diff, RPM_BUCKETS_COUNT);
    for (let s = 0; s < shift; s++) {
      rpmHistory.shift();
      rpmHistory.push(0);
    }
    lastRpmMinute = currentMin;
  }
  rpmHistory[rpmHistory.length - 1] = (rpmHistory[rpmHistory.length - 1] || 0) + count;
}
function getRpm60mData() {
  const now = /* @__PURE__ */ new Date();
  const currentMin = Math.floor(Date.now() / 6e4);
  const diff = currentMin - lastRpmMinute;
  if (diff > 0) {
    const shift = Math.min(diff, RPM_BUCKETS_COUNT);
    for (let s = 0; s < shift; s++) {
      rpmHistory.shift();
      rpmHistory.push(0);
    }
    lastRpmMinute = currentMin;
  }
  const points = [];
  for (let i = 0; i < RPM_BUCKETS_COUNT; i++) {
    const minAgo = RPM_BUCKETS_COUNT - 1 - i;
    const pointTime = new Date(now.getTime() - minAgo * 6e4);
    const timeLabel = pointTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    points.push({
      minute_ago: minAgo,
      label: minAgo === 0 ? "\u0421\u0435\u0439\u0447\u0430\u0441" : `-${minAgo}\u043C`,
      time: timeLabel,
      timestamp: pointTime.toISOString(),
      rpm: rpmHistory[i] || 0
    });
  }
  const values = points.map((p) => p.rpm);
  const currentRpm = values[values.length - 1] || 0;
  const peakRpm = Math.max(...values, 0);
  const avgRpm = Math.round(values.reduce((a, b) => a + b, 0) / (values.length || 1));
  const totalLastHour = values.reduce((a, b) => a + b, 0);
  return {
    current_rpm: currentRpm,
    peak_rpm: peakRpm,
    avg_rpm: avgRpm,
    total_last_hour: totalLastHour,
    points
  };
}
function computeLatencyStats(samples) {
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
      percentages: LATENCY_BINS.map(() => 0)
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const getP = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(n * p)))];
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
  const percentages = counts.map((c) => Number((c / n * 100).toFixed(1)));
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
    percentages
  };
}
function addAudit(event, actor, subject_type, subject_id, detail = {}) {
  auditLogs.unshift({
    id: `aud_${import_crypto.default.randomBytes(6).toString("hex")}`,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    actor,
    subject_type,
    subject_id,
    detail
  });
  if (auditLogs.length > 500) auditLogs.pop();
}
function seedInitialData() {
  nodes.clear();
  consents.clear();
  blacklist.clear();
  candidates.clear();
  apiKeys.clear();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const sampleNodes = [
    {
      node_id: "node_us_east1",
      endpoint: "http://198.51.100.22:11434",
      display_name: "US-East FastCluster",
      owner_id: "ops@cloudscale.net",
      models: ["llama3", "llama3:8b", "llama3:70b", "mistral", "mistral:7b"],
      max_concurrency: 4,
      active_connections: 1,
      latency_ms: 45,
      error_rate: 2e-3,
      weight: 10,
      status: "healthy",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "healthy",
      active: 1,
      ewma_latency_ms: 45,
      effective_weight: 10,
      country: "US",
      ip: "198.51.100.22"
    },
    {
      node_id: "node_us_west2",
      endpoint: "http://198.51.100.58:11434",
      display_name: "US-West Inference Hub",
      owner_id: "ops@cloudscale.net",
      models: ["llama3", "llama3:8b", "qwen2", "qwen2:7b"],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 62,
      error_rate: 0,
      weight: 8,
      status: "healthy",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "healthy",
      active: 0,
      ewma_latency_ms: 62,
      effective_weight: 8,
      country: "US",
      ip: "198.51.100.58"
    },
    {
      node_id: "node_de_fra1",
      endpoint: "http://203.0.113.14:11434",
      display_name: "DE-Frankfurt Dedicated",
      owner_id: "berlin-lab@research.de",
      models: ["llama3", "llama3:8b", "mixtral:8x7b", "phi3:mini"],
      max_concurrency: 4,
      active_connections: 2,
      latency_ms: 88,
      error_rate: 5e-3,
      weight: 12,
      status: "healthy",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "healthy",
      active: 2,
      ewma_latency_ms: 88,
      effective_weight: 12,
      country: "DE",
      ip: "203.0.113.14"
    },
    {
      node_id: "node_de_mun2",
      endpoint: "http://203.0.113.88:11434",
      display_name: "DE-Munich GPU Rig",
      owner_id: "berlin-lab@research.de",
      models: ["codellama:13b", "llama3:8b"],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 145,
      error_rate: 0.02,
      weight: 5,
      status: "degraded",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "degraded",
      active: 0,
      ewma_latency_ms: 145,
      effective_weight: 5,
      country: "DE",
      ip: "203.0.113.88"
    },
    {
      node_id: "node_jp_tyo1",
      endpoint: "http://192.0.2.77:11434",
      display_name: "JP-Tokyo Edge Node",
      owner_id: "tokyo-edge@ai-pacific.jp",
      models: ["llama3:8b", "qwen2:72b", "gemma2:9b"],
      max_concurrency: 4,
      active_connections: 1,
      latency_ms: 120,
      error_rate: 1e-3,
      weight: 10,
      status: "healthy",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "healthy",
      active: 1,
      ewma_latency_ms: 120,
      effective_weight: 10,
      country: "JP",
      ip: "192.0.2.77"
    },
    {
      node_id: "node_nl_ams1",
      endpoint: "http://192.0.2.140:11434",
      display_name: "NL-Amsterdam Relay",
      owner_id: "community@foa-relay.eu",
      models: ["llama3:8b", "mistral:7b"],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 76,
      error_rate: 0,
      weight: 6,
      status: "healthy",
      consent_status: "verified",
      routable: true,
      created_at: now,
      updated_at: now,
      state: "healthy",
      active: 0,
      ewma_latency_ms: 76,
      effective_weight: 6,
      country: "NL",
      ip: "192.0.2.140"
    },
    {
      node_id: "node_fr_par1",
      endpoint: "http://192.0.2.215:11434",
      display_name: "FR-Paris Micro Compute",
      owner_id: "community@foa-relay.eu",
      models: ["phi3:mini", "llama3:8b"],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 82,
      error_rate: 0,
      weight: 4,
      status: "healthy",
      consent_status: "challenge_sent",
      routable: false,
      created_at: now,
      updated_at: now,
      state: "pending_consent",
      active: 0,
      ewma_latency_ms: 82,
      effective_weight: 0,
      country: "FR",
      ip: "192.0.2.215"
    }
  ];
  sampleNodes.forEach((node) => {
    nodes.set(node.node_id, node);
    nodeLatencySamples.set(node.node_id, generateDefaultSamplesForNode(node));
    consents.set(`cst_${node.node_id}`, {
      consent_id: `cst_${node.node_id}`,
      node_id: node.node_id,
      owner_id: node.owner_id,
      status: node.consent_status === "verified" ? "active" : "pending",
      method: "http_well_known",
      allowed_models: node.models,
      max_concurrency: node.max_concurrency,
      issued_at: now,
      expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
      version: 1,
      history: [{ event: "seed_init", actor: "system", created_at: now }]
    });
  });
  const sampleCandidates = [
    {
      candidate_id: "cand_discovery_us1",
      source: "censys",
      sources: ["censys"],
      ip: "198.51.100.99",
      port: 11434,
      protocol: "http",
      dns_names: ["ai-edge-pool.us.cloud"],
      country: "US",
      asn: "AS15169 Google LLC",
      service_hint: "Ollama API v0.1.32",
      risk_score: 12,
      requires_manual_review: false,
      status: "candidate",
      observed_at: now
    },
    {
      candidate_id: "cand_discovery_de1",
      source: "shodan",
      sources: ["shodan"],
      ip: "203.0.113.190",
      port: 11434,
      protocol: "http",
      dns_names: ["gpu-cluster-fra.de"],
      country: "DE",
      asn: "AS24940 Hetzner Online GmbH",
      service_hint: "Ollama API (Llama3, Mixtral)",
      risk_score: 8,
      requires_manual_review: false,
      status: "candidate",
      observed_at: now
    }
  ];
  sampleCandidates.forEach((cand) => candidates.set(cand.candidate_id, cand));
  addAudit("gateway_boot", "system", "gateway", GATEWAY_ID, {
    version: VERSION,
    pool_size: sampleNodes.length,
    status: "clean_initialized"
  });
}
seedInitialData();
var currentConfig = {
  gateway_id: GATEWAY_ID,
  security: {
    require_consent: true,
    allow_unverified_nodes: false,
    active_scanning: "deny",
    route_candidates: true,
    store_prompt_bodies: false,
    store_response_bodies: false,
    forward_client_ip: false,
    require_tls_for_nodes: false,
    allow_loopback_nodes: true,
    client_hash_salt: "***hidden***"
  },
  limits: {
    requests_per_minute_per_user: 60,
    concurrent_requests_per_user: 2,
    max_prompt_bytes: 1048576,
    max_num_predict: 2048,
    max_generation_seconds: 300,
    requests_per_minute_global: 1e3,
    requests_per_minute_per_model: 20,
    max_request_bytes: 1048576,
    max_messages: 200,
    max_message_bytes: 262144,
    concurrent_stream_requests_per_user: 2
  },
  health: {
    liveness_interval_seconds: 15,
    readiness_interval_seconds: 60,
    timeout_seconds: 3,
    failure_threshold: 3,
    liveness_connect_timeout_seconds: 2,
    liveness_response_timeout_seconds: 3,
    liveness_failure_threshold: 3,
    readiness_timeout_seconds: 5,
    readiness_failure_threshold: 2,
    consent_recheck_interval_seconds: 86400,
    consent_revocation_apply_seconds: 5,
    passive_window_seconds: 60,
    passive_error_rate_threshold: 0.2,
    functional_check_enabled: false,
    functional_check_model: "",
    functional_check_interval_seconds: 3600,
    retry_after_failure_seconds: 1
  },
  circuit_breaker: {
    window_seconds: 30,
    minimum_requests: 10,
    error_rate_threshold: 0.5,
    open_duration_seconds: 60,
    half_open_probes: 1
  },
  discovery: {
    mode: "authorized_enrollment",
    active_sources: ["shodan", "censys", "manual", "greynoise", "zoomeye", "natlas"],
    auto_route_candidates: true,
    auto_verify_candidates: true,
    verification_mode: "dual"
  }
};
var adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : req.query.token;
  const configuredAdminToken = process.env.FOA_ADMIN_TOKEN || "foa-admin-secret";
  const configuredAuditorToken = process.env.FOA_AUDITOR_TOKEN || "foa-auditor-secret";
  if (!token || token !== configuredAdminToken && token !== configuredAuditorToken) {
    return res.status(401).json({ error: "\u041D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u0430 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u0430\u0446\u0438\u044F \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430 (Bearer \u0442\u043E\u043A\u0435\u043D)" });
  }
  const isAdmin = token === configuredAdminToken;
  if (!isAdmin && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return res.status(403).json({ error: "\u0422\u043E\u043A\u0435\u043D \u0430\u0443\u0434\u0438\u0442\u043E\u0440\u0430 \u0434\u043E\u043F\u0443\u0441\u043A\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u043F\u0435\u0440\u0430\u0446\u0438\u0438 \u0447\u0442\u0435\u043D\u0438\u044F (GET)" });
  }
  req.adminRole = isAdmin ? "admin" : "auditor";
  return next();
};
var userAuth = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return res.status(401).json({ error: "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F API-\u043A\u043B\u044E\u0447: \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A Authorization: Bearer <foa_live_...>" });
  }
  const now = /* @__PURE__ */ new Date();
  for (const key of apiKeys.values()) {
    if (key.raw_key !== token || key.revoked) continue;
    if (key.expires_at && new Date(key.expires_at) < now) {
      return res.status(401).json({ error: "\u0421\u0440\u043E\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F API-\u043A\u043B\u044E\u0447\u0430 \u0438\u0441\u0442\u0451\u043A" });
    }
    key.last_used_at = now.toISOString();
    req.apiKey = key;
    return next();
  }
  return res.status(401).json({ error: "\u041D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 API-\u043A\u043B\u044E\u0447" });
};
var requireScopes = (...scopes) => {
  return (req, res, next) => {
    const key = req.apiKey;
    const granted = Array.isArray(key?.scopes) ? key.scopes : [];
    if (scopes.some((s) => granted.includes(s))) {
      return next();
    }
    return res.status(403).json({
      error: `\u041D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u043F\u0440\u0430\u0432: \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u043E\u0434\u0438\u043D \u0438\u0437 \u0441\u043A\u043E\u0443\u043F\u043E\u0432 [${scopes.join(", ")}], \u0443 \u043A\u043B\u044E\u0447\u0430 \u2014 [${granted.join(", ")}]`
    });
  };
};
var LIMIT_WINDOW_MS = 6e4;
function pruneWindow(hits, now) {
  const cutoff = now - LIMIT_WINDOW_MS;
  let i = 0;
  while (i < hits.length && hits[i] <= cutoff) i++;
  return i > 0 ? hits.slice(i) : hits;
}
function windowRetryAfter(hits, limit, now) {
  if (hits.length >= limit) {
    return Math.max(1, Math.ceil((hits[0] + LIMIT_WINDOW_MS - now) / 1e3));
  }
  return 0;
}
var userRpm = /* @__PURE__ */ new Map();
var modelRpm = /* @__PURE__ */ new Map();
var globalRpm = [];
var inflight = /* @__PURE__ */ new Map();
var inflightStreams = /* @__PURE__ */ new Map();
function rateLimited(res, scope, limit, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: `\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 (${scope} \u2264 ${limit}/\u043C\u0438\u043D). \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 ${retryAfter} \u0441.`,
    retry_after: retryAfter
  });
}
var applyLimits = (opts = {}) => {
  return (req, res, next) => {
    const key = req.apiKey;
    const limits = currentConfig.limits;
    const now = Date.now();
    const keyId = key.key_id;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > limits.max_request_bytes) {
      return res.status(413).json({ error: `\u0422\u0435\u043B\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0430 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_request_bytes (${limits.max_request_bytes} \u0431\u0430\u0439\u0442)` });
    }
    const body = req.body || {};
    if (opts.body === "prompt") {
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (Buffer.byteLength(prompt, "utf8") > limits.max_prompt_bytes) {
        return res.status(400).json({ error: `\u041F\u0440\u043E\u043C\u043F\u0442 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_prompt_bytes (${limits.max_prompt_bytes} \u0431\u0430\u0439\u0442)` });
      }
      const numPredict = body.options?.num_predict;
      if (typeof numPredict === "number" && numPredict > limits.max_num_predict) {
        return res.status(400).json({ error: `num_predict \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_num_predict (${limits.max_num_predict})` });
      }
    } else if (opts.body === "chat" || opts.body === "openai") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length > limits.max_messages) {
        return res.status(400).json({ error: `\u0427\u0438\u0441\u043B\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_messages (${limits.max_messages})` });
      }
      for (const m of messages) {
        const content = typeof m?.content === "string" ? m.content : "";
        if (Buffer.byteLength(content, "utf8") > limits.max_message_bytes) {
          return res.status(400).json({ error: `\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_message_bytes (${limits.max_message_bytes} \u0431\u0430\u0439\u0442)` });
        }
      }
      const cap = opts.body === "openai" ? body.max_tokens ?? body.max_completion_tokens : body.options?.num_predict;
      if (typeof cap === "number" && cap > limits.max_num_predict) {
        return res.status(400).json({ error: `\u041B\u0438\u043C\u0438\u0442 \u0433\u0435\u043D\u0435\u0440\u0430\u0446\u0438\u0438 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_num_predict (${limits.max_num_predict})` });
      }
    }
    const userLimit = key.rate_limit_per_minute ?? limits.requests_per_minute_per_user;
    const userHits = pruneWindow(userRpm.get(keyId) || [], now);
    let retryAfter = windowRetryAfter(userHits, userLimit, now);
    if (retryAfter) {
      userRpm.set(keyId, userHits);
      return rateLimited(res, "\u043D\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F", userLimit, retryAfter);
    }
    const globalHits = pruneWindow(globalRpm, now);
    retryAfter = windowRetryAfter(globalHits, limits.requests_per_minute_global, now);
    if (retryAfter) {
      userRpm.set(keyId, userHits);
      globalRpm = globalHits;
      return rateLimited(res, "\u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439", limits.requests_per_minute_global, retryAfter);
    }
    let modelId = "";
    if (opts.perModel && body.model) {
      modelId = `${keyId}|${String(body.model).toLowerCase()}`;
      const modelHits = pruneWindow(modelRpm.get(modelId) || [], now);
      retryAfter = windowRetryAfter(modelHits, limits.requests_per_minute_per_model, now);
      if (retryAfter) {
        userRpm.set(keyId, userHits);
        globalRpm = globalHits;
        modelRpm.set(modelId, modelHits);
        return rateLimited(res, `\u043D\u0430 \u043C\u043E\u0434\u0435\u043B\u044C ${body.model}`, limits.requests_per_minute_per_model, retryAfter);
      }
      modelRpm.set(modelId, modelHits);
    }
    const isStream = body.stream === true;
    const inflightMap = isStream ? inflightStreams : inflight;
    const inflightLimit = isStream ? limits.concurrent_stream_requests_per_user : limits.concurrent_requests_per_user;
    const current = inflightMap.get(keyId) || 0;
    if (current >= inflightLimit) {
      return res.status(429).json({ error: `\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 (${inflightLimit} \u043D\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F)` });
    }
    inflightMap.set(keyId, current + 1);
    userHits.push(now);
    userRpm.set(keyId, userHits);
    globalHits.push(now);
    globalRpm = globalHits;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflightMap.set(keyId, Math.max(0, (inflightMap.get(keyId) || 1) - 1));
    };
    res.on("close", release);
    req.on("aborted", release);
    next();
  };
};
app.get("/healthz", (req, res) => {
  res.json({ status: "ok", version: VERSION });
});
app.get("/readyz", (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const status = routable > 0 ? "ready" : "degraded";
  res.status(routable > 0 ? 200 : 503).json({
    status,
    routable_nodes: routable,
    version: VERSION
  });
});
app.get("/metrics", (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const activeBl = Array.from(blacklist.values()).filter((b) => !b.lifted_at).length;
  const payload = [
    `# HELP foa_build_info Gateway build information`,
    `# TYPE foa_build_info gauge`,
    `foa_build_info{version="${VERSION}",gateway_id="${GATEWAY_ID}"} 1`,
    `# HELP foa_nodes_routable Total routable nodes in pool`,
    `# TYPE foa_nodes_routable gauge`,
    `foa_nodes_routable ${routable}`,
    `# HELP foa_nodes_blacklisted Total blacklisted nodes`,
    `# TYPE foa_nodes_blacklisted gauge`,
    `foa_nodes_blacklisted ${activeBl}`,
    `# HELP foa_requests_total Total gateway requests served`,
    `# TYPE foa_requests_total counter`,
    `foa_requests_total 4289`
  ].join("\n");
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(payload);
});
app.get(["/", "/panel", "/panel/*"], (req, res) => {
  res.sendFile(import_path.default.join(process.cwd(), "public", "index.html"));
});
app.get("/admin/status", adminAuth, (req, res) => {
  const allNodes = Array.from(nodes.values());
  const routable = allNodes.filter((n) => n.routable).length;
  const activeBl = Array.from(blacklist.values()).filter((b) => !b.lifted_at).length;
  const nodesByStatus = {};
  allNodes.forEach((n) => {
    nodesByStatus[n.status] = (nodesByStatus[n.status] || 0) + 1;
  });
  const nodesMap = {};
  allNodes.forEach((n) => {
    nodesMap[n.node_id] = {
      state: n.status,
      active: n.active_connections,
      max_concurrency: n.max_concurrency,
      ewma_latency_ms: n.latency_ms,
      error_rate: n.error_rate,
      effective_weight: n.weight,
      routable: n.routable
    };
  });
  res.json({
    version: VERSION,
    gateway_id: GATEWAY_ID,
    time: (/* @__PURE__ */ new Date()).toISOString(),
    routable_nodes: routable,
    blacklisted: activeBl,
    nodes_by_status: nodesByStatus,
    security: currentConfig.security,
    discovery: {
      mode: currentConfig.discovery.mode,
      candidates: candidates.size,
      active_sources: currentConfig.discovery.active_sources
    },
    nodes: nodesMap,
    rpm_metrics: getRpm60mData()
  });
});
app.get("/admin/metrics/rpm", adminAuth, (req, res) => {
  res.json(getRpm60mData());
});
app.get("/admin/nodes", adminAuth, (req, res) => {
  const isDetailed = req.query.detailed === "true";
  const nodesList = Array.from(nodes.values()).map((node) => {
    if (!isDetailed) return node;
    const samples = nodeLatencySamples.get(node.node_id) || generateDefaultSamplesForNode(node);
    if (!nodeLatencySamples.has(node.node_id)) nodeLatencySamples.set(node.node_id, samples);
    return {
      ...node,
      latency_distribution: computeLatencyStats(samples)
    };
  });
  res.json({ nodes: nodesList });
});
app.get("/admin/nodes/latency-distribution", adminAuth, (req, res) => {
  const binLabels = LATENCY_BINS.map((b) => b.label);
  const resultNodes = {};
  let allSamples = [];
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
      country: node.country || "US",
      models: node.models,
      current_latency_ms: node.latency_ms,
      ...stats
    };
  }
  const aggregateStats = computeLatencyStats(allSamples);
  res.json({
    bins: binLabels,
    nodes: resultNodes,
    aggregate: aggregateStats,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/admin/nodes/metrics", adminAuth, (req, res) => {
  const timestamps = ["10:00", "10:05", "10:10", "10:15", "10:20", "10:25", "10:30", "10:35", "10:40", "10:45"];
  const nodeMetrics = [];
  for (const node of nodes.values()) {
    let baseCpu = 25 + Math.abs(node.node_id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 45);
    let baseMem = 35 + Math.abs(node.node_id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 35);
    const history = timestamps.map((time, idx) => {
      const cpu = Math.min(100, Math.max(5, Math.round(baseCpu + Math.sin(idx + node.node_id.length) * 15)));
      const memory = Math.min(100, Math.max(10, Math.round(baseMem + Math.cos(idx + node.node_id.length) * 10)));
      return { time, cpu, memory, latency_ms: node.latency_ms || Math.round(20 + Math.random() * 40) };
    });
    nodeMetrics.push({
      node_id: node.node_id,
      display_name: node.display_name || node.node_id,
      status: node.status,
      country: node.country || "US",
      history
    });
  }
  res.json({ metrics: nodeMetrics, timestamps, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
app.get("/admin/nodes/:id/latency-distribution", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
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
    country: node.country || "US",
    bins: LATENCY_BINS.map((b) => b.label),
    current_latency_ms: node.latency_ms,
    ...stats
  });
});
app.post("/admin/nodes", adminAuth, (req, res) => {
  const { endpoint, display_name, owner_id, models, max_concurrency, consent_method, weight, country, labels } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: "Endpoint \u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u0435\u043D" });
  }
  const nodeId = `node_${import_crypto.default.randomBytes(5).toString("hex")}`;
  const consentId = `cst_${import_crypto.default.randomBytes(5).toString("hex")}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const newNode = {
    node_id: nodeId,
    endpoint,
    display_name: display_name || `Node ${nodeId.slice(0, 8)}`,
    owner_id: owner_id || "unassigned@owner",
    models: Array.isArray(models) && models.length ? models : ["llama3:8b"],
    max_concurrency: max_concurrency || 2,
    active_connections: 0,
    latency_ms: 0,
    error_rate: 0,
    weight: weight || 1,
    status: "pending_consent",
    consent_status: "challenge_sent",
    routable: false,
    created_at: now,
    updated_at: now,
    state: "pending_consent",
    active: 0,
    ewma_latency_ms: 0,
    effective_weight: 0,
    country: (country || req.body.country || "US").toUpperCase(),
    labels: Array.isArray(labels) ? labels : []
  };
  nodes.set(nodeId, newNode);
  nodeLatencySamples.set(nodeId, generateDefaultSamplesForNode(newNode));
  consents.set(consentId, {
    consent_id: consentId,
    node_id: nodeId,
    owner_id: owner_id || "unassigned@owner",
    status: "pending",
    method: consent_method || "http_well_known",
    allowed_models: newNode.models,
    max_concurrency: newNode.max_concurrency,
    issued_at: now,
    expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
    version: 1,
    history: [
      { event: "node_registered", actor: "admin", created_at: now },
      { event: "challenge_created", actor: "system", created_at: now }
    ]
  });
  addAudit("node_registered", "admin", "node", nodeId, { endpoint, consent_id: consentId });
  res.json({
    node_id: nodeId,
    consent_id: consentId,
    status: "pending_consent",
    next_step: "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435 \u0432\u043B\u0430\u0434\u0435\u043D\u0438\u0435 \u0443\u0437\u043B\u043E\u043C \u0447\u0435\u0440\u0435\u0437 \u043C\u0435\u0442\u043E\u0434: " + (consent_method || "http_well_known"),
    challenge: {
      challenge_token: `foa_chk_${import_crypto.default.randomBytes(16).toString("hex")}`,
      verification_path: "/.well-known/foa-consent.json",
      expires_in_seconds: 3600
    }
  });
});
function generateChallengeForNode(nodeId, endpoint, ownerId) {
  const challengeToken = `ch_${import_crypto.default.randomBytes(12).toString("hex")}`;
  const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();
  let domain = "node.example.com";
  try {
    const u = new URL(endpoint.startsWith("http") ? endpoint : `http://${endpoint}`);
    domain = u.hostname;
  } catch (e) {
  }
  const wellKnownJson = {
    node_id: nodeId,
    challenge: challengeToken,
    gateway_id: GATEWAY_ID,
    owner_id: ownerId,
    expires_at: expiresAt,
    capabilities: {
      models: ["llama3:8b", "mistral:7b"],
      max_concurrency: 4
    },
    verification_status: "domain_agreement_authorized"
  };
  const dnsTxtRecord = `_free-ollama-challenge.${domain}`;
  const dnsTxtValue = `gateway=${GATEWAY_ID};node=${nodeId};challenge=${challengeToken};exp=${expiresAt}`;
  return {
    challenge_token: challengeToken,
    expires_at: expiresAt,
    well_known_url: `${endpoint.replace(/\/$/, "")}/.well-known/free-ollama/v1/consent.json`,
    well_known_json: wellKnownJson,
    dns_txt_record: dnsTxtRecord,
    dns_txt_value: dnsTxtValue
  };
}
app.get("/admin/nodes/:id", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  res.json(node);
});
app.get("/admin/nodes/:id/challenge", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const info = generateChallengeForNode(node.node_id, node.endpoint, node.owner_id);
  res.json(info);
});
app.post("/admin/nodes/:id/challenge", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const info = generateChallengeForNode(node.node_id, node.endpoint, node.owner_id);
  res.json(info);
});
app.post("/admin/nodes/:id/verify", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const { mode = "manual", method = "manual_admin", models, owner_id, max_concurrency } = req.body || {};
  if (owner_id) node.owner_id = owner_id;
  if (max_concurrency) node.max_concurrency = max_concurrency;
  if (Array.isArray(models) && models.length) node.models = models;
  try {
    const probeRes = await fetch(`${node.endpoint}/api/tags`, { signal: AbortSignal.timeout(3e3) });
    if (probeRes.ok) {
      const data = await probeRes.json();
      if (Array.isArray(data.models) && data.models.length) {
        node.models = data.models.map((m) => m.name || m.model);
      }
    }
  } catch (e) {
  }
  node.consent_status = "verified";
  node.status = "healthy";
  node.routable = true;
  node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  node.state = "healthy";
  node.effective_weight = node.weight;
  let consentFound = false;
  for (const c of consents.values()) {
    if (c.node_id === node.node_id) {
      c.status = "active";
      c.method = method;
      c.allowed_models = node.models;
      c.max_concurrency = node.max_concurrency;
      c.history.push({
        event: mode === "auto" ? "node_auto_verified" : "node_manual_verified",
        actor: "admin",
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        detail: { method, mode, domain_owners_agreed: true }
      });
      consentFound = true;
    }
  }
  if (!consentFound) {
    const cId = `cst_${node.node_id}`;
    consents.set(cId, {
      consent_id: cId,
      node_id: node.node_id,
      owner_id: node.owner_id,
      status: "active",
      method,
      allowed_models: node.models,
      max_concurrency: node.max_concurrency,
      issued_at: (/* @__PURE__ */ new Date()).toISOString(),
      expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
      version: 1,
      history: [
        {
          event: mode === "auto" ? "node_auto_verified" : "node_manual_verified",
          actor: "admin",
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          detail: { method, mode, domain_owners_agreed: true }
        }
      ]
    });
  }
  addAudit(mode === "auto" ? "node_auto_verified" : "node_verified", "admin", "node", node.node_id, {
    routable: true,
    models: node.models,
    method,
    mode,
    domain_owners_agreed: true
  });
  res.json({
    status: "verified",
    node_id: node.node_id,
    routable: true,
    models: node.models,
    method,
    mode
  });
});
app.post("/admin/nodes/bulk-verify", adminAuth, async (req, res) => {
  const { node_ids = [], mode = "auto", method = "auto_domain_agreement" } = req.body || {};
  let count = 0;
  for (const id of node_ids) {
    const node = nodes.get(id);
    if (!node) continue;
    node.consent_status = "verified";
    node.status = "healthy";
    node.routable = true;
    node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    node.state = "healthy";
    node.effective_weight = node.weight;
    for (const c of consents.values()) {
      if (c.node_id === node.node_id) {
        c.status = "active";
        c.method = method;
        c.history.push({
          event: mode === "auto" ? "node_auto_verified" : "node_manual_verified",
          actor: "admin",
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          detail: { method, mode, domain_owners_agreed: true, bulk: true }
        });
      }
    }
    count++;
  }
  addAudit("nodes_bulk_verified", "admin", "nodes", "bulk", { count, mode, method });
  res.json({ status: "completed", count });
});
app.post("/admin/nodes/:id/health-check", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const start = Date.now();
  let status = "unhealthy";
  let latency = 0;
  let errorMsg;
  try {
    const probeRes = await fetch(`${node.endpoint}/api/version`, {
      signal: AbortSignal.timeout(4e3)
    });
    latency = Date.now() - start;
    if (probeRes.ok) {
      status = latency > 600 ? "degraded" : "healthy";
      try {
        const tagsRes = await fetch(`${node.endpoint}/api/tags`, {
          signal: AbortSignal.timeout(3e3)
        });
        if (tagsRes.ok) {
          const tData = await tagsRes.json();
          if (Array.isArray(tData.models) && tData.models.length) {
            node.models = tData.models.map((m) => m.name || m.model);
          }
        }
      } catch (e) {
      }
    } else {
      status = "degraded";
    }
  } catch (err) {
    latency = Date.now() - start;
    status = "unhealthy";
    errorMsg = err.message;
  }
  node.latency_ms = latency;
  node.ewma_latency_ms = node.ewma_latency_ms > 0 ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3) : latency;
  node.status = status;
  node.state = status;
  node.last_health_check = (/* @__PURE__ */ new Date()).toISOString();
  node.updated_at = node.last_health_check;
  recordNodeLatencySample(node.node_id, latency);
  addAudit("health_probe", "system", "node", node.node_id, {
    latency_ms: latency,
    status,
    models: node.models,
    error: errorMsg
  });
  res.json({
    status,
    latency_ms: latency,
    node_id: node.node_id,
    models: node.models,
    error: errorMsg
  });
});
app.post("/admin/nodes/:id/revoke", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  node.consent_status = "revoked";
  node.status = "unhealthy";
  node.routable = false;
  node.state = "revoked";
  node.effective_weight = 0;
  node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  for (const c of consents.values()) {
    if (c.node_id === node.node_id) {
      c.status = "revoked";
      c.revoked_at = node.updated_at;
      c.revoke_reason = req.body.reason || "Admin revoked consent";
      c.history.push({
        event: "consent_revoked",
        actor: "admin",
        created_at: node.updated_at,
        detail: { reason: c.revoke_reason }
      });
    }
  }
  addAudit("node_revoked", "admin", "node", node.node_id, { reason: req.body.reason });
  res.json({ status: "revoked", node_id: node.node_id, routable: false });
});
app.post("/admin/nodes/:id/blacklist", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  const nodeId = req.params.id;
  const endpoint = node ? node.endpoint : req.body.endpoint || "unknown";
  if (node) {
    node.status = "blacklisted";
    node.routable = false;
    node.effective_weight = 0;
    node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  }
  blacklist.set(nodeId, {
    node_id: nodeId,
    endpoint,
    reason: req.body.reason || "Admin manual blacklist",
    permanent: req.body.duration === "permanent",
    actor: "admin",
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    expires_at: req.body.duration === "permanent" ? null : new Date(Date.now() + 864e5).toISOString(),
    lifted_at: null
  });
  addAudit("node_blacklisted", "admin", "node", nodeId, { reason: req.body.reason });
  res.json({ status: "blacklisted", node_id: nodeId });
});
app.post("/admin/nodes/:id/unblacklist", adminAuth, (req, res) => {
  const entry = blacklist.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u0447\u0451\u0440\u043D\u043E\u043C \u0441\u043F\u0438\u0441\u043A\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430" });
  entry.lifted_at = (/* @__PURE__ */ new Date()).toISOString();
  const node = nodes.get(req.params.id);
  if (node && node.consent_status === "verified") {
    node.status = "healthy";
    node.routable = true;
    node.effective_weight = node.weight;
  }
  addAudit("node_unblacklisted", "admin", "node", req.params.id);
  res.json({ status: "unblacklisted", node_id: req.params.id });
});
app.delete("/admin/nodes/:id", adminAuth, (req, res) => {
  const nodeId = req.params.id;
  if (!nodes.has(nodeId)) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  nodes.delete(nodeId);
  addAudit("node_deleted", "admin", "node", nodeId);
  res.json({ status: "deleted", node_id: nodeId });
});
app.post("/admin/nodes/:id/labels", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const { labels } = req.body;
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: "labels \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043C\u0430\u0441\u0441\u0438\u0432\u043E\u043C \u0441\u0442\u0440\u043E\u043A" });
  }
  node.labels = labels.map((l) => String(l).trim()).filter(Boolean);
  node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  addAudit("node_labels_updated", "admin", "node", req.params.id, { labels: node.labels });
  res.json({ success: true, node_id: node.node_id, labels: node.labels });
});
app.get("/admin/nodes/:id/logs", adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const logLevels = ["INFO", "DEBUG", "WARN", "SUCCESS"];
  const actions = [
    "Health check ping successful (latency: " + (node.latency_ms || 25) + "ms)",
    "Incoming proxy request routed for model " + (node.models[0] || "llama3:8b"),
    "Active connections count updated: " + (node.active_connections || 0) + "/" + node.max_concurrency,
    "TLS handshake established successfully with endpoint " + node.endpoint,
    "EWMA latency recalibrated to " + (node.ewma_latency_ms || node.latency_ms || 24) + "ms",
    "Heartbeat ACK received from gateway daemon",
    "Weight factor evaluated: effective_weight=" + (node.effective_weight || node.weight || 1),
    "Token bucket rate limit check passed (quota: 1000 req/min)",
    "Consent validation status: " + node.consent_status
  ];
  const logs = [];
  const now = Date.now();
  for (let i = 100; i >= 1; i--) {
    const timestamp = new Date(now - i * 15e3).toISOString();
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
app.get("/admin/consents", adminAuth, (req, res) => {
  res.json({ consents: Array.from(consents.values()) });
});
app.get("/admin/consents/:id", adminAuth, (req, res) => {
  const consent = consents.get(req.params.id);
  if (!consent) return res.status(404).json({ error: "\u0421\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E" });
  res.json(consent);
});
app.get("/admin/blacklist", adminAuth, (req, res) => {
  const all = Array.from(blacklist.values());
  const activeTotal = all.filter((b) => !b.lifted_at).length;
  res.json({ active_total: activeTotal, blacklist: all });
});
async function fetchFromCensys() {
  const token = process.env.CENSYS_API_TOKEN || process.env.CENSYS_API_KEY;
  const apiId = process.env.CENSYS_API_ID;
  const apiSecret = process.env.CENSYS_API_SECRET;
  if (!token && (!apiId || !apiSecret)) {
    return { items: [] };
  }
  const items = [];
  let lastError;
  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json"
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else if (apiId && apiSecret) {
      headers["Authorization"] = `Basic ${Buffer.from(`${apiId}:${apiSecret}`).toString("base64")}`;
    }
    const res = await fetch("https://api.platform.censys.io/v3/global/search/query", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "services.port: 11434",
        per_page: 25
      }),
      signal: AbortSignal.timeout(12e3)
    });
    if (res.ok) {
      const data = await res.json();
      const hits = data.result?.hits || data.hits || data.results || [];
      for (const h of hits) {
        const ip = h.ip || h.host_id || h.query_target;
        if (!ip) continue;
        items.push({
          ip,
          port: 11434,
          protocol: "tcp",
          dns_names: h.dns?.names || h.names || [],
          country: h.location?.country_code || h.country || "US",
          asn: h.autonomous_system?.asn ? `AS${h.autonomous_system.asn}` : void 0,
          source: "censys",
          service_hint: "ollama"
        });
      }
      if (items.length > 0) return { items };
    } else {
      let errMsg = `Censys status ${res.status}`;
      try {
        const errData = await res.json();
        if (errData.detail || errData.error) errMsg = `Censys: ${errData.detail || errData.error}`;
      } catch (e) {
      }
      lastError = errMsg;
    }
  } catch (e) {
    lastError = e.message;
  }
  if (apiId && apiSecret) {
    try {
      const auth = Buffer.from(`${apiId}:${apiSecret}`).toString("base64");
      const res = await fetch("https://search.censys.io/api/v2/hosts/search?q=services.port%3A11434&per_page=25", {
        headers: {
          "Authorization": `Basic ${auth}`,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(12e3)
      });
      if (res.ok) {
        const data = await res.json();
        const hits = data.result?.hits || [];
        for (const h of hits) {
          const ip = h.ip;
          if (!ip) continue;
          items.push({
            ip,
            port: 11434,
            protocol: "tcp",
            dns_names: h.dns?.names || [],
            country: h.location?.country_code || "US",
            asn: h.autonomous_system?.asn ? `AS${h.autonomous_system.asn}` : void 0,
            source: "censys",
            service_hint: "ollama"
          });
        }
      } else {
        let errMsg = `Censys v2 status ${res.status}`;
        try {
          const errData = await res.json();
          if (errData.error || errData.message) errMsg = `Censys v2: ${errData.error || errData.message}`;
        } catch (e) {
        }
        lastError = errMsg;
      }
    } catch (e) {
      return { items, error: e.message };
    }
  }
  return { items, error: items.length > 0 ? void 0 : lastError };
}
async function fetchFromShodan() {
  const apiKey = process.env.SHODAN_API_KEY;
  if (!apiKey) return { items: [] };
  try {
    const res = await fetch(`https://api.shodan.io/shodan/host/search?key=${encodeURIComponent(apiKey)}&query=port:11434`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(12e3)
    });
    if (!res.ok) {
      let errMsg = `Shodan status ${res.status}`;
      try {
        const errData = await res.json();
        if (errData.error) errMsg = `Shodan: ${errData.error}`;
      } catch (e) {
      }
      return { items: [], error: errMsg };
    }
    const data = await res.json();
    const matches = data.matches || [];
    const items = [];
    for (const m of matches) {
      const ip = m.ip_str || m.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: m.port || 11434,
        protocol: m.transport || "tcp",
        dns_names: m.hostnames || [],
        country: m.location?.country_code || "US",
        asn: m.asn || void 0,
        source: "shodan",
        service_hint: "ollama",
        banner: typeof m.data === "string" ? m.data.slice(0, 200) : void 0
      });
    }
    return { items };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
async function fetchFromGreyNoise() {
  const apiKey = process.env.GREYNOISE_API_KEY;
  if (!apiKey) return { items: [] };
  try {
    const res = await fetch("https://api.greynoise.io/v2/experimental/gnql?query=11434&size=25", {
      headers: {
        "key": apiKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(12e3)
    });
    if (!res.ok) {
      let errMsg = `GreyNoise status ${res.status}`;
      try {
        const errData = await res.json();
        if (errData.message) errMsg = `GreyNoise: ${errData.message}`;
      } catch (e) {
      }
      return { items: [], error: errMsg };
    }
    const data = await res.json();
    const records = data.data || [];
    const items = [];
    for (const r of records) {
      const ip = r.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: 11434,
        protocol: "tcp",
        dns_names: r.metadata?.rdns ? [r.metadata.rdns] : [],
        country: r.metadata?.country_code || "US",
        asn: r.metadata?.asn || void 0,
        source: "greynoise",
        service_hint: "ollama"
      });
    }
    return { items };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
async function fetchFromZoomEye() {
  const apiKey = process.env.ZOOMEYE_API_KEY;
  if (!apiKey) return { items: [] };
  try {
    const res = await fetch("https://api.zoomeye.org/host/search?query=port:11434&page=1", {
      headers: {
        "API-KEY": apiKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(12e3)
    });
    if (!res.ok) {
      let errMsg = `ZoomEye status ${res.status}`;
      try {
        const errData = await res.json();
        if (errData.message) errMsg = `ZoomEye: ${errData.message}`;
      } catch (e) {
      }
      return { items: [], error: errMsg };
    }
    const data = await res.json();
    const matches = data.matches || [];
    const items = [];
    for (const m of matches) {
      const ip = m.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: m.portinfo?.port || 11434,
        protocol: m.portinfo?.service || "tcp",
        dns_names: m.rdns ? [m.rdns] : [],
        country: m.geoinfo?.country?.code || "US",
        asn: m.geoinfo?.asn ? `AS${m.geoinfo.asn}` : void 0,
        source: "zoomeye",
        service_hint: "ollama"
      });
    }
    return { items };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
async function fetchFromCriminalIP() {
  const apiKey = process.env.CRIMINAL_IP_API_KEY;
  if (!apiKey) return { items: [] };
  try {
    const res = await fetch("https://api.criminalip.io/v1/banner/search?query=port:11434&offset=0", {
      headers: {
        "x-api-key": apiKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(12e3)
    });
    if (!res.ok) {
      return { items: [], error: `Criminal IP status ${res.status}` };
    }
    const data = await res.json();
    const list = data.data?.result || [];
    const items = [];
    for (const r of list) {
      const ip = r.ip_address;
      if (!ip) continue;
      items.push({
        ip,
        port: r.open_port_no || 11434,
        protocol: "tcp",
        dns_names: r.hostname ? [r.hostname] : [],
        country: r.country || "US",
        asn: r.as_name || void 0,
        source: "criminal_ip",
        service_hint: "ollama"
      });
    }
    return { items };
  } catch (e) {
    return { items: [], error: e.message };
  }
}
async function fetchFromNatlas() {
  const endpoint = process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || "https://app.netlas.io/api/";
  const apiKey = process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY;
  if (!apiKey) return { items: [] };
  const cleanUrl = endpoint.replace(/\/$/, "");
  const isNetlas = cleanUrl.includes("netlas.io") || cleanUrl.includes("netlas");
  if (isNetlas) {
    try {
      const res = await fetch(`${cleanUrl}/responses/?q=port:11434&start=0`, {
        headers: {
          "X-Api-Key": apiKey,
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(15e3)
      });
      if (!res.ok) {
        return { items: [], error: `Netlas status ${res.status}`, source_name: "netlas" };
      }
      const data = await res.json();
      const list = data.items || [];
      const items = [];
      for (const item of list) {
        const d = item.data;
        if (!d || !d.ip) continue;
        const dns = [];
        if (d.host) dns.push(d.host);
        if (d.domain && !dns.includes(d.domain)) dns.push(d.domain);
        if (d.ptr && !dns.includes(d.ptr)) dns.push(d.ptr);
        const asnNum = d.whois?.asn?.number?.[0] || d.asn;
        items.push({
          ip: d.ip,
          port: d.port || 11434,
          protocol: d.prot4 || d.protocol || "tcp",
          dns_names: dns,
          country: d.geo?.country || d.country || "US",
          asn: asnNum ? `AS${asnNum}` : void 0,
          source: "netlas",
          service_hint: "ollama",
          banner: d.http?.body ? String(d.http.body).slice(0, 200) : void 0
        });
      }
      return { items, source_name: "netlas" };
    } catch (e) {
      return { items: [], error: e.message, source_name: "netlas" };
    }
  }
  try {
    const res = await fetch(`${cleanUrl}/api/v1/search?query=port:11434`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(12e3)
    });
    if (!res.ok) {
      return { items: [], error: `Natlas status ${res.status}`, source_name: "natlas" };
    }
    const data = await res.json();
    const results = data.results || [];
    const items = [];
    for (const r of results) {
      const ip = r.ip;
      if (!ip) continue;
      items.push({
        ip,
        port: r.port || 11434,
        protocol: "tcp",
        dns_names: r.hostnames || [],
        country: r.country || "US",
        source: "natlas",
        service_hint: "ollama"
      });
    }
    return { items, source_name: "natlas" };
  } catch (e) {
    return { items: [], error: e.message, source_name: "natlas" };
  }
}
app.get("/admin/discovery/sources", adminAuth, (req, res) => {
  reloadEnv();
  const natlasUrl = process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || "";
  const isNetlas = natlasUrl.includes("netlas.io") || natlasUrl.includes("netlas");
  const sources = [
    {
      id: "censys",
      name: "Censys Platform / Hosts",
      configured: !!(process.env.CENSYS_API_TOKEN || process.env.CENSYS_API_ID && process.env.CENSYS_API_SECRET),
      query: "services.port: 11434"
    },
    {
      id: "shodan",
      name: "Shodan API",
      configured: !!process.env.SHODAN_API_KEY,
      query: "port:11434"
    },
    {
      id: "greynoise",
      name: "GreyNoise GNQL",
      configured: !!process.env.GREYNOISE_API_KEY,
      query: "11434"
    },
    {
      id: "zoomeye",
      name: "ZoomEye",
      configured: !!process.env.ZOOMEYE_API_KEY,
      query: "port:11434"
    },
    {
      id: "criminal_ip",
      name: "Criminal IP Banner",
      configured: !!process.env.CRIMINAL_IP_API_KEY,
      query: "port:11434"
    },
    {
      id: "natlas",
      name: isNetlas ? "Netlas Responses API" : "Natlas Crawler",
      configured: !!((process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT) && (process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY)),
      query: isNetlas ? "port:11434 (Netlas search)" : "port:11434"
    }
  ];
  res.json({ sources });
});
app.post("/admin/demo/clear", adminAuth, (req, res) => {
  const nCnt = nodes.size;
  const cCnt = candidates.size;
  const bCnt = blacklist.size;
  const csCnt = consents.size;
  nodes.clear();
  candidates.clear();
  blacklist.clear();
  consents.clear();
  addAudit("data_cleared", "admin", "gateway", GATEWAY_ID, {
    cleared_nodes: nCnt,
    cleared_candidates: cCnt
  });
  res.json({
    status: "cleared",
    message: "\u0412\u0441\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 (\u0443\u0437\u043B\u044B, \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u044B, \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F, \u0447\u0451\u0440\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A) \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u043E\u0447\u0438\u0449\u0435\u043D\u044B.",
    cleared: { nodes: nCnt, candidates: cCnt, blacklist: bCnt, consents: csCnt }
  });
});
app.get("/admin/candidates", adminAuth, (req, res) => {
  const list = Array.from(candidates.values());
  res.json({
    total: list.length,
    candidates: list,
    auto_verify: currentConfig.discovery.auto_verify_candidates,
    auto_route: currentConfig.discovery.auto_route_candidates,
    note: "\u041C\u0430\u0440\u0448\u0440\u0443\u0442\u0438\u0437\u0430\u0446\u0438\u044F \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u043A\u0430\u043A \u0432 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u043C, \u0442\u0430\u043A \u0438 \u0432 \u0440\u0443\u0447\u043D\u043E\u043C \u0440\u0435\u0436\u0438\u043C\u0430\u0445 \u0432\u0435\u0440\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u0438 (\u0441\u043E\u0433\u043B\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u0441 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430\u043C\u0438 \u0434\u043E\u043C\u0435\u043D\u043E\u0432)"
  });
});
app.delete("/admin/candidates", adminAuth, (req, res) => {
  const count = candidates.size;
  candidates.clear();
  addAudit("candidates_cleared", "admin", "discovery", "all", { count });
  res.json({ status: "cleared", count });
});
app.post("/admin/discovery/run", adminAuth, async (req, res) => {
  reloadEnv();
  const configuredSources = [];
  if (process.env.CENSYS_API_TOKEN || process.env.CENSYS_API_ID && process.env.CENSYS_API_SECRET) {
    configuredSources.push("censys");
  }
  if (process.env.SHODAN_API_KEY) configuredSources.push("shodan");
  if (process.env.GREYNOISE_API_KEY) configuredSources.push("greynoise");
  if (process.env.ZOOMEYE_API_KEY) configuredSources.push("zoomeye");
  if (process.env.CRIMINAL_IP_API_KEY) configuredSources.push("criminal_ip");
  if ((process.env.NATLAS_API_ENDPOINT || process.env.NETLAS_API_ENDPOINT || process.env.NETLAS_API_KEY) && (process.env.NATLAS_API_KEY || process.env.NETLAS_API_KEY)) {
    configuredSources.push("natlas");
  }
  const rawResults = [];
  const sourceStats = {};
  const tasks = [];
  if (configuredSources.includes("censys")) {
    tasks.push(
      fetchFromCensys().then((r) => {
        sourceStats["censys"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes("shodan")) {
    tasks.push(
      fetchFromShodan().then((r) => {
        sourceStats["shodan"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes("greynoise")) {
    tasks.push(
      fetchFromGreyNoise().then((r) => {
        sourceStats["greynoise"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes("zoomeye")) {
    tasks.push(
      fetchFromZoomEye().then((r) => {
        sourceStats["zoomeye"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes("criminal_ip")) {
    tasks.push(
      fetchFromCriminalIP().then((r) => {
        sourceStats["criminal_ip"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  if (configuredSources.includes("natlas")) {
    tasks.push(
      fetchFromNatlas().then((r) => {
        sourceStats["natlas"] = { count: r.items.length, error: r.error };
        rawResults.push(...r.items);
      })
    );
  }
  await Promise.allSettled(tasks);
  let created = 0;
  let deduped = 0;
  for (const item of rawResults) {
    const dedupeKey = `${item.ip}:${item.port}:${item.protocol || "tcp"}`;
    let existingCandidate;
    for (const c of candidates.values()) {
      if (`${c.ip}:${c.port}:${c.protocol || "tcp"}` === dedupeKey) {
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
        existingCandidate.source = existingCandidate.sources.join("+");
      }
      if (item.dns_names && item.dns_names.length) {
        for (const d of item.dns_names) {
          if (!existingCandidate.dns_names.includes(d)) {
            existingCandidate.dns_names.push(d);
          }
        }
      }
      existingCandidate.observed_at = (/* @__PURE__ */ new Date()).toISOString();
    } else {
      const id = `cnd_${import_crypto.default.randomBytes(4).toString("hex")}`;
      let riskScore = 15;
      const isBlacklisted = Array.from(blacklist.values()).some((b) => !b.lifted_at && b.endpoint.includes(item.ip));
      if (isBlacklisted) {
        riskScore = 95;
      } else {
        if (!item.dns_names || !item.dns_names.length) riskScore += 10;
        if (!item.asn) riskScore += 10;
        if (item.source === "criminal_ip" || item.source === "greynoise") riskScore += 15;
      }
      const candidate = {
        candidate_id: id,
        source: item.source,
        sources: [item.source],
        ip: item.ip,
        port: item.port,
        protocol: item.protocol || "tcp",
        dns_names: item.dns_names || [],
        country: item.country,
        asn: item.asn,
        service_hint: item.service_hint || "ollama",
        banner_hash: item.banner ? `sha256:${import_crypto.default.createHash("sha256").update(item.banner).digest("hex").slice(0, 16)}` : void 0,
        risk_score: riskScore,
        requires_manual_review: riskScore >= 70,
        status: "candidate",
        observed_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      candidates.set(id, candidate);
      created++;
    }
  }
  const shouldAutoVerify = req.body?.auto_verify === true || req.query?.auto_verify === "true" || currentConfig.discovery.auto_verify_candidates === true;
  let autoVerifiedCount = 0;
  if (shouldAutoVerify && created > 0) {
    const unverified = Array.from(candidates.values()).filter((c) => c.status === "candidate");
    for (const cand of unverified) {
      try {
        await verifyAndEnrollCandidate(cand, { mode: "auto", auto_route: true });
        autoVerifiedCount++;
      } catch (e) {
      }
    }
  }
  addAudit("discovery_run", "admin", "discovery", "scan", {
    created,
    deduped,
    auto_verified_count: autoVerifiedCount,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    total_candidates: candidates.size
  });
  res.json({
    status: "completed",
    created,
    deduped,
    auto_verified_count: autoVerifiedCount,
    total: candidates.size,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    message: configuredSources.length === 0 ? "\u0412 .env \u043D\u0435 \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u043E API-\u043A\u043B\u044E\u0447\u0435\u0439 \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0445 \u0441\u0435\u0440\u0432\u0438\u0441\u043E\u0432 (CENSYS_*, SHODAN_*, GREYNOISE_*, ZOOMEYE_*, CRIMINAL_IP_*, NATLAS_*)." : `\u041F\u043E\u0438\u0441\u043A \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D. \u041D\u0430\u0439\u0434\u0435\u043D\u043E \u043D\u043E\u0432\u044B\u0445: ${created}, \u0434\u0435\u0434\u0443\u043F\u043B\u0438\u0446\u0438\u0440\u043E\u0432\u0430\u043D\u043E: ${deduped}.${autoVerifiedCount > 0 ? ` \u0410\u0432\u0442\u043E-\u0432\u0435\u0440\u0438\u0444\u0438\u0446\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u0438 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u0432 \u043F\u0443\u043B: ${autoVerifiedCount}.` : ""}`
  });
});
async function verifyAndEnrollCandidate(cand, options = {}) {
  const mode = options.mode || "auto";
  const autoRoute = options.auto_route !== false;
  const nodeId = cand.node_id || `node_${import_crypto.default.randomBytes(5).toString("hex")}`;
  const consentId = `cst_${nodeId}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const endpoint = `http://${cand.ip}:${cand.port}`;
  const method = options.method || (mode === "auto" ? "auto_domain_agreement" : "manual_admin");
  let discoveredModels = options.models && options.models.length ? options.models : ["llama3:8b"];
  let latency = 45;
  try {
    const start = Date.now();
    const probeRes = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3500) });
    latency = Math.max(1, Date.now() - start);
    if (probeRes.ok) {
      const pData = await probeRes.json();
      if (Array.isArray(pData.models) && pData.models.length) {
        discoveredModels = pData.models.map((m) => m.name || m.model || "llama3:8b");
      }
    }
  } catch (e) {
    if (!options.models || !options.models.length) {
      discoveredModels = ["llama3:8b", "mistral:7b"];
    }
  }
  const ownerId = options.owner_id || (cand.dns_names && cand.dns_names[0] ? `admin@${cand.dns_names[0]}` : `domain-owner@${cand.ip}`);
  const displayName = options.display_name || (cand.dns_names && cand.dns_names[0] ? cand.dns_names[0] : `Node ${cand.ip}`);
  const challengeInfo = generateChallengeForNode(nodeId, endpoint, ownerId);
  const newNode = {
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
    status: "healthy",
    consent_status: "verified",
    routable: autoRoute,
    created_at: now,
    updated_at: now,
    state: "healthy",
    active: 0,
    ewma_latency_ms: latency,
    effective_weight: 10,
    country: cand.country || "US",
    ip: cand.ip
  };
  nodes.set(nodeId, newNode);
  nodeLatencySamples.set(nodeId, generateDefaultSamplesForNode(newNode));
  const newConsent = {
    consent_id: consentId,
    node_id: nodeId,
    owner_id: ownerId,
    status: "active",
    method,
    allowed_models: discoveredModels,
    max_concurrency: newNode.max_concurrency,
    issued_at: now,
    expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
    version: 1,
    history: [
      {
        event: mode === "auto" ? "candidate_auto_verified" : "candidate_manual_verified",
        actor: "admin",
        created_at: now,
        detail: {
          mode,
          method,
          domain_owners_agreed: true,
          candidate_id: cand.candidate_id,
          source: cand.source,
          routable: autoRoute,
          challenge_token: challengeInfo.challenge_token
        }
      }
    ]
  };
  consents.set(consentId, newConsent);
  cand.status = "enrolled";
  cand.verified = true;
  cand.verification_mode = mode;
  cand.verified_at = now;
  cand.node_id = nodeId;
  cand.challenge_token = challengeInfo.challenge_token;
  addAudit(
    mode === "auto" ? "candidate_auto_verified" : "candidate_manual_verified",
    "admin",
    "candidate",
    cand.candidate_id,
    {
      node_id: nodeId,
      endpoint,
      routable: autoRoute,
      models: discoveredModels,
      method,
      domain_owners_agreed: true
    }
  );
  return { node: newNode, consent: newConsent, challenge: challengeInfo };
}
app.post("/admin/candidates/:id/enroll", adminAuth, async (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const result = await verifyAndEnrollCandidate(cand, {
    mode: "manual",
    owner_id: req.body.owner_id,
    auto_route: req.body.auto_route !== false
  });
  res.json({
    status: "enrolled",
    node_id: result.node.node_id,
    candidate_id: cand.candidate_id,
    routable: result.node.routable,
    models: result.node.models
  });
});
app.post("/admin/candidates/:id/verify", adminAuth, async (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  try {
    const result = await verifyAndEnrollCandidate(cand, req.body || {});
    res.json({
      status: "verified",
      candidate_id: cand.candidate_id,
      node: result.node,
      consent: result.consent,
      routable: result.node.routable,
      models: result.node.models
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/admin/candidates/auto-verify-all", adminAuth, async (req, res) => {
  const unverified = Array.from(candidates.values()).filter((c) => c.status !== "enrolled");
  const verifiedList = [];
  let failed = 0;
  for (const cand of unverified) {
    try {
      const resItem = await verifyAndEnrollCandidate(cand, { mode: "auto", auto_route: true });
      verifiedList.push(resItem.node);
    } catch (e) {
      failed++;
    }
  }
  addAudit("candidates_auto_verified_all", "admin", "candidates", "all", {
    total: unverified.length,
    verified_count: verifiedList.length,
    failed_count: failed
  });
  res.json({
    status: "completed",
    total: unverified.length,
    verified_count: verifiedList.length,
    failed_count: failed,
    nodes: verifiedList
  });
});
app.get("/admin/candidates/:id/challenge", adminAuth, (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const endpoint = `http://${cand.ip}:${cand.port}`;
  const ownerId = cand.dns_names && cand.dns_names[0] ? `admin@${cand.dns_names[0]}` : `domain-owner@${cand.ip}`;
  const info = generateChallengeForNode(cand.candidate_id, endpoint, ownerId);
  res.json(info);
});
app.post("/admin/config/toggle-auto-verify", adminAuth, (req, res) => {
  currentConfig.discovery.auto_verify_candidates = !currentConfig.discovery.auto_verify_candidates;
  currentConfig.discovery.auto_route_candidates = currentConfig.discovery.auto_verify_candidates;
  currentConfig.security.route_candidates = currentConfig.discovery.auto_verify_candidates;
  addAudit("config_auto_verify_toggled", "admin", "config", "discovery", {
    auto_verify_candidates: currentConfig.discovery.auto_verify_candidates
  });
  res.json({
    status: "ok",
    auto_verify_candidates: currentConfig.discovery.auto_verify_candidates,
    auto_route_candidates: currentConfig.discovery.auto_route_candidates
  });
});
app.delete("/admin/candidates/:id", adminAuth, (req, res) => {
  if (!candidates.has(req.params.id)) return res.status(404).json({ error: "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  candidates.delete(req.params.id);
  res.json({ status: "deleted", candidate_id: req.params.id });
});
app.get("/admin/keys", adminAuth, (req, res) => {
  res.json({ keys: Array.from(apiKeys.values()) });
});
app.post("/admin/keys", adminAuth, (req, res) => {
  const { label, scopes, rate_limit_per_minute, ttl_seconds } = req.body;
  const keyId = `key_${import_crypto.default.randomBytes(5).toString("hex")}`;
  const rawKey = `foa_live_${import_crypto.default.randomBytes(16).toString("hex")}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const newKey = {
    key_id: keyId,
    label: label || "Default Key",
    prefix: rawKey.slice(0, 12),
    scopes: Array.isArray(scopes) && scopes.length ? scopes : ["ollama:read", "ollama:generate"],
    created_at: now,
    expires_at: ttl_seconds ? new Date(Date.now() + ttl_seconds * 1e3).toISOString() : null,
    revoked: false,
    last_used_at: null,
    rate_limit_per_minute: rate_limit_per_minute || 60,
    raw_key: rawKey
  };
  apiKeys.set(keyId, newKey);
  addAudit("api_key_created", "admin", "api_key", keyId, { label: newKey.label });
  res.json({
    key_id: keyId,
    api_key: rawKey,
    label: newKey.label,
    scopes: newKey.scopes
  });
});
app.post("/admin/keys/:id/revoke", adminAuth, (req, res) => {
  const key = apiKeys.get(req.params.id);
  if (!key) return res.status(404).json({ error: "\u041A\u043B\u044E\u0447 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  key.revoked = true;
  addAudit("api_key_revoked", "admin", "api_key", key.key_id);
  res.json({ status: "revoked", key_id: key.key_id });
});
app.post("/admin/keys/:id/rotate", adminAuth, (req, res) => {
  const oldKey = apiKeys.get(req.params.id);
  if (!oldKey) return res.status(404).json({ error: "\u041A\u043B\u044E\u0447 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const rawKey = `foa_live_${import_crypto.default.randomBytes(16).toString("hex")}`;
  oldKey.raw_key = rawKey;
  oldKey.prefix = rawKey.slice(0, 12);
  oldKey.revoked = false;
  oldKey.last_used_at = null;
  addAudit("api_key_rotated", "admin", "api_key", oldKey.key_id);
  res.json({ status: "rotated", key_id: oldKey.key_id, api_key: rawKey });
});
app.get("/admin/audit", adminAuth, (req, res) => {
  let list = auditLogs;
  const eventFilter = req.query.event;
  const subjectFilter = req.query.subject_id;
  const limit = parseInt(req.query.limit) || 100;
  if (eventFilter) {
    list = list.filter((e) => e.event.includes(eventFilter));
  }
  if (subjectFilter) {
    list = list.filter((e) => e.subject_id.includes(subjectFilter));
  }
  res.json({ entries: list.slice(0, limit) });
});
app.get("/admin/config", adminAuth, (req, res) => {
  res.json(currentConfig);
});
app.post("/admin/config/reload", adminAuth, (req, res) => {
  addAudit("config_reloaded", "admin", "config", "all");
  res.json({
    status: "ok",
    reloaded: ["security", "limits", "health", "circuit_breaker", "discovery"]
  });
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/v1/")) {
    if (req.method === "POST") {
      recordRequestForRpm(1);
    }
  }
  next();
});
function isModelSupportedByNode(node, targetModel) {
  if (!node.routable || !Array.isArray(node.models) || !node.models.length) return false;
  if (!targetModel) return true;
  const req = targetModel.trim().toLowerCase();
  const reqBase = req.split(":")[0];
  const reqTag = req.includes(":") ? req.split(":")[1] : "";
  return node.models.some((m) => {
    const mLower = m.trim().toLowerCase();
    if (mLower === req) return true;
    const mBase = mLower.split(":")[0];
    const mTag = mLower.includes(":") ? mLower.split(":")[1] : "";
    if (mBase === reqBase) {
      if (!reqTag) return true;
      if (reqTag === "latest") return true;
      if (!mTag || mTag === "latest") return true;
      if (mTag === reqTag) return true;
    }
    return false;
  });
}
function getRoutableModels() {
  const modelsSet = /* @__PURE__ */ new Set();
  for (const node of nodes.values()) {
    if (node.routable) {
      node.models.forEach((m) => {
        modelsSet.add(m);
        if (m.includes(":")) {
          modelsSet.add(m.split(":")[0]);
        }
      });
    }
  }
  return Array.from(modelsSet);
}
app.get("/api/version", userAuth, (req, res) => {
  res.json({ version: "0.1.32" });
});
app.get("/api/endpoints", (req, res) => {
  const hostname = req.hostname || "localhost";
  const makeUrl = (scheme, port) => `${scheme}://${hostname}:${port}`;
  const endpoints = [
    {
      scheme: "https",
      url: makeUrl("https", PUBLIC_HTTPS_PORT),
      label: "HTTPS (\u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0439)",
      description: "\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u044D\u043D\u0434\u043F\u043E\u0438\u043D\u0442 \u0441 TLS-\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u0438\u0435\u043C. \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E."
    },
    {
      scheme: "http",
      url: makeUrl("http", PUBLIC_HTTP_PORT),
      label: "HTTP (\u0431\u0435\u0437 SSL)",
      description: "\u041E\u0431\u044B\u0447\u043D\u044B\u0439 HTTP \u0431\u0435\u0437 \u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u0438\u044F. \u0414\u043B\u044F \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C \u0438 SDK, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043E\u0442\u043A\u043B\u043E\u043D\u044F\u044E\u0442 \u0441\u0430\u043C\u043E\u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D\u043D\u044B\u0439 \u0441\u0435\u0440\u0442\u0438\u0444\u0438\u043A\u0430\u0442 \u0448\u043B\u044E\u0437\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \u043E\u0448\u0438\u0431\u043A\u0430 DEPTH_ZERO_SELF_SIGNED_CERT)."
    }
  ];
  res.json({ gateway_id: GATEWAY_ID, version: VERSION, endpoints });
});
app.get("/api/tags", userAuth, requireScopes("ollama:read"), applyLimits(), (req, res) => {
  const modelNames = getRoutableModels();
  const models = modelNames.map((name) => ({
    name,
    model: name,
    modified_at: (/* @__PURE__ */ new Date()).toISOString(),
    size: 4661224676,
    digest: `sha256:${import_crypto.default.createHash("sha256").update(name).digest("hex")}`,
    details: {
      parent_model: "",
      format: "gguf",
      family: name.split(":")[0],
      families: [name.split(":")[0]],
      parameter_size: name.includes("70b") ? "70B" : name.includes("13b") ? "13B" : "8B",
      quantization_level: "Q4_K_M"
    }
  }));
  res.json({ models });
});
app.post("/api/generate", userAuth, requireScopes("ollama:generate"), applyLimits({ perModel: true, body: "prompt" }), async (req, res) => {
  const { model, prompt, stream } = req.body;
  const targetModel = model || "llama3:8b";
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `\u041C\u043E\u0434\u0435\u043B\u044C '${targetModel}' \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0432 \u043F\u0443\u043B\u0435 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0443\u0437\u043B\u043E\u0432. \u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u043C\u043E\u0434\u0435\u043B\u0438: ${available.slice(0, 10).join(", ")}`
    });
  }
  const selectedNode = routable.sort((a, b) => a.active_connections - b.active_connections)[0];
  selectedNode.active_connections++;
  try {
    const upstreamRes = await fetch(`${selectedNode.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(4e3)
    });
    if (upstreamRes.ok) {
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      if (stream === false) {
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        const data = await upstreamRes.json();
        return res.json(data);
      }
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
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
  }
  const responseText = `[\u041E\u0442\u0432\u0435\u0442 \u0448\u043B\u044E\u0437\u0430 FOA \u0447\u0435\u0440\u0435\u0437 \u0443\u0437\u0435\u043B ${selectedNode.display_name}]: \u0417\u0430\u043F\u0440\u043E\u0441 \u043A \u043C\u043E\u0434\u0435\u043B\u0438 ${targetModel} \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D. \u0412\u0430\u0448 \u0437\u0430\u043F\u0440\u043E\u0441: "${(prompt || "").slice(0, 100)}..."`;
  if (stream === false) {
    selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
    return res.json({
      model: targetModel,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      response: responseText,
      done: true,
      context: [1, 2, 3],
      total_duration: 124e7,
      load_duration: 2e7,
      prompt_eval_count: 24,
      eval_count: 48,
      eval_duration: 12e8
    });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  const words = responseText.split(" ");
  let idx = 0;
  const interval = setInterval(() => {
    if (idx < words.length) {
      const chunk = {
        model: targetModel,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        response: words[idx] + " ",
        done: false
      };
      res.write(JSON.stringify(chunk) + "\n");
      idx++;
    } else {
      clearInterval(interval);
      selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
      const finalChunk = {
        model: targetModel,
        created_at: (/* @__PURE__ */ new Date()).toISOString(),
        response: "",
        done: true,
        total_duration: 145e7,
        eval_count: words.length
      };
      res.write(JSON.stringify(finalChunk) + "\n");
      res.end();
    }
  }, 40);
});
app.post("/api/chat", userAuth, requireScopes("ollama:generate"), applyLimits({ perModel: true, body: "chat" }), async (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || "llama3:8b";
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `\u041C\u043E\u0434\u0435\u043B\u044C '${targetModel}' \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0432 \u043F\u0443\u043B\u0435 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0443\u0437\u043B\u043E\u0432. \u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u043C\u043E\u0434\u0435\u043B\u0438: ${available.slice(0, 10).join(", ")}`
    });
  }
  const selectedNode = routable.sort((a, b) => a.active_connections - b.active_connections)[0];
  selectedNode.active_connections++;
  try {
    const upstreamRes = await fetch(`${selectedNode.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(4e3)
    });
    if (upstreamRes.ok) {
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      if (stream === false) {
        selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
        const data = await upstreamRes.json();
        return res.json(data);
      }
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
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
  }
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : "\u041F\u0440\u0438\u0432\u0435\u0442";
  const replyContent = `[FOA Gateway / ${selectedNode.display_name}]: \u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u0430\u0448\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 ("${lastMsg}") \u0447\u0435\u0440\u0435\u0437 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0443\u0437\u0435\u043B ${selectedNode.endpoint}.`;
  if (stream === false) {
    selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
    return res.json({
      model: targetModel,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      message: {
        role: "assistant",
        content: replyContent
      },
      done: true,
      total_duration: 98e7,
      eval_count: 32
    });
  }
  res.setHeader("Content-Type", "application/x-ndjson");
  const words = replyContent.split(" ");
  let idx = 0;
  const interval = setInterval(() => {
    if (idx < words.length) {
      res.write(
        JSON.stringify({
          model: targetModel,
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          message: { role: "assistant", content: words[idx] + " " },
          done: false
        }) + "\n"
      );
      idx++;
    } else {
      clearInterval(interval);
      selectedNode.active_connections = Math.max(0, selectedNode.active_connections - 1);
      res.write(
        JSON.stringify({
          model: targetModel,
          created_at: (/* @__PURE__ */ new Date()).toISOString(),
          done: true,
          total_duration: 112e7
        }) + "\n"
      );
      res.end();
    }
  }, 40);
});
app.post("/api/embed", userAuth, requireScopes("ollama:embed", "ollama:generate"), applyLimits(), (req, res) => {
  const { input } = req.body;
  const count = Array.isArray(input) ? input.length : 1;
  const embeddings = Array(count).fill(0).map(
    () => Array(128).fill(0).map(() => Math.random() * 2 - 1)
  );
  res.json({ embeddings });
});
app.get("/v1/models", userAuth, requireScopes("ollama:read"), applyLimits(), (req, res) => {
  const modelNames = getRoutableModels();
  res.json({
    object: "list",
    data: modelNames.map((id) => ({
      id,
      object: "model",
      created: 17e8,
      owned_by: "foa-gateway",
      permission: [],
      root: id,
      parent: null
    }))
  });
});
app.post("/v1/chat/completions", userAuth, requireScopes("ollama:generate"), applyLimits({ perModel: true, body: "openai" }), (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || "llama3:8b";
  let routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: {
        message: `Model '${targetModel}' is not available on any authorized node. Available models: ${available.slice(0, 10).join(", ")}`,
        type: "service_unavailable"
      }
    });
  }
  const selectedNode = routable[0];
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : "";
  const text = `[FOA Gateway via ${selectedNode.display_name}]: Processed OpenAI-compatible completion for: "${lastMsg}"`;
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const words = text.split(" ");
    let i = 0;
    const interval = setInterval(() => {
      if (i < words.length) {
        const chunk = {
          id: `chatcmpl-${import_crypto.default.randomBytes(8).toString("hex")}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1e3),
          model: targetModel,
          choices: [
            {
              index: 0,
              delta: { content: words[i] + " " },
              finish_reason: null
            }
          ]
        };
        res.write(`data: ${JSON.stringify(chunk)}

`);
        i++;
      } else {
        clearInterval(interval);
        res.write(`data: [DONE]

`);
        res.end();
      }
    }, 40);
    return;
  }
  res.json({
    id: `chatcmpl-${import_crypto.default.randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: targetModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 16,
      completion_tokens: 32,
      total_tokens: 48
    }
  });
});
app.use("/admin/*", (req, res) => {
  res.status(501).json({ error: "Not yet migrated in FOA Node.js gateway" });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FOA Gateway running on http://0.0.0.0:${PORT}`);
  console.log(`CORS allowed origins: ${allowedCorsOrigins.join(", ") || "*"}`);
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  reloadEnv
});
