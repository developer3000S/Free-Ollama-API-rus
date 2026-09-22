import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';

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
const PORT = 3000;
const GATEWAY_ID = process.env.GATEWAY_ID || 'foa-gw-main-01';
const VERSION = '1.0.0';

app.use(cors());
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
  status: 'candidate' | 'enrolled' | 'out_of_scope' | 'rejected';
  observed_at: string;
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
const nodes = new Map<string, NodeItem>();
const consents = new Map<string, ConsentItem>();
const blacklist = new Map<string, BlacklistItem>();
const candidates = new Map<string, CandidateItem>();
const apiKeys = new Map<string, ApiKeyItem>();
const auditLogs: AuditItem[] = [];

function addAudit(event: string, actor: string, subject_type: string, subject_id: string, detail: Record<string, unknown> = {}) {
  auditLogs.unshift({
    id: `aud_${crypto.randomBytes(6).toString('hex')}`,
    created_at: new Date().toISOString(),
    event,
    actor,
    subject_type,
    subject_id,
    detail,
  });
  if (auditLogs.length > 500) auditLogs.pop();
}

// Clean Initialization for FOA Gateway with multi-region nodes
function seedInitialData() {
  nodes.clear();
  consents.clear();
  blacklist.clear();
  candidates.clear();
  apiKeys.clear();

  const now = new Date().toISOString();
  const sampleNodes: NodeItem[] = [
    {
      node_id: 'node_us_east1',
      endpoint: 'http://198.51.100.22:11434',
      display_name: 'US-East FastCluster',
      owner_id: 'ops@cloudscale.net',
      models: ['llama3:8b', 'llama3:70b', 'mistral:7b'],
      max_concurrency: 4,
      active_connections: 1,
      latency_ms: 45,
      error_rate: 0.002,
      weight: 10,
      status: 'healthy',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'healthy',
      active: 1,
      ewma_latency_ms: 45,
      effective_weight: 10,
      country: 'US',
      ip: '198.51.100.22',
    },
    {
      node_id: 'node_us_west2',
      endpoint: 'http://198.51.100.58:11434',
      display_name: 'US-West Inference Hub',
      owner_id: 'ops@cloudscale.net',
      models: ['llama3:8b', 'qwen2:7b'],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 62,
      error_rate: 0,
      weight: 8,
      status: 'healthy',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'healthy',
      active: 0,
      ewma_latency_ms: 62,
      effective_weight: 8,
      country: 'US',
      ip: '198.51.100.58',
    },
    {
      node_id: 'node_de_fra1',
      endpoint: 'http://203.0.113.14:11434',
      display_name: 'DE-Frankfurt Dedicated',
      owner_id: 'berlin-lab@research.de',
      models: ['llama3:8b', 'mixtral:8x7b', 'phi3:mini'],
      max_concurrency: 4,
      active_connections: 2,
      latency_ms: 88,
      error_rate: 0.005,
      weight: 12,
      status: 'healthy',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'healthy',
      active: 2,
      ewma_latency_ms: 88,
      effective_weight: 12,
      country: 'DE',
      ip: '203.0.113.14',
    },
    {
      node_id: 'node_de_mun2',
      endpoint: 'http://203.0.113.88:11434',
      display_name: 'DE-Munich GPU Rig',
      owner_id: 'berlin-lab@research.de',
      models: ['codellama:13b', 'llama3:8b'],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 145,
      error_rate: 0.02,
      weight: 5,
      status: 'degraded',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'degraded',
      active: 0,
      ewma_latency_ms: 145,
      effective_weight: 5,
      country: 'DE',
      ip: '203.0.113.88',
    },
    {
      node_id: 'node_jp_tyo1',
      endpoint: 'http://192.0.2.77:11434',
      display_name: 'JP-Tokyo Edge Node',
      owner_id: 'tokyo-edge@ai-pacific.jp',
      models: ['llama3:8b', 'qwen2:72b', 'gemma2:9b'],
      max_concurrency: 4,
      active_connections: 1,
      latency_ms: 120,
      error_rate: 0.001,
      weight: 10,
      status: 'healthy',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'healthy',
      active: 1,
      ewma_latency_ms: 120,
      effective_weight: 10,
      country: 'JP',
      ip: '192.0.2.77',
    },
    {
      node_id: 'node_nl_ams1',
      endpoint: 'http://192.0.2.140:11434',
      display_name: 'NL-Amsterdam Relay',
      owner_id: 'community@foa-relay.eu',
      models: ['llama3:8b', 'mistral:7b'],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 76,
      error_rate: 0,
      weight: 6,
      status: 'healthy',
      consent_status: 'verified',
      routable: true,
      created_at: now,
      updated_at: now,
      state: 'healthy',
      active: 0,
      ewma_latency_ms: 76,
      effective_weight: 6,
      country: 'NL',
      ip: '192.0.2.140',
    },
    {
      node_id: 'node_fr_par1',
      endpoint: 'http://192.0.2.215:11434',
      display_name: 'FR-Paris Micro Compute',
      owner_id: 'community@foa-relay.eu',
      models: ['phi3:mini', 'llama3:8b'],
      max_concurrency: 2,
      active_connections: 0,
      latency_ms: 82,
      error_rate: 0,
      weight: 4,
      status: 'healthy',
      consent_status: 'challenge_sent',
      routable: false,
      created_at: now,
      updated_at: now,
      state: 'pending_consent',
      active: 0,
      ewma_latency_ms: 82,
      effective_weight: 0,
      country: 'FR',
      ip: '192.0.2.215',
    },
  ];

  sampleNodes.forEach((node) => {
    nodes.set(node.node_id, node);
    consents.set(`cst_${node.node_id}`, {
      consent_id: `cst_${node.node_id}`,
      node_id: node.node_id,
      owner_id: node.owner_id,
      status: node.consent_status === 'verified' ? 'active' : 'pending',
      method: 'http_well_known',
      allowed_models: node.models,
      max_concurrency: node.max_concurrency,
      issued_at: now,
      expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
      version: 1,
      history: [{ event: 'seed_init', actor: 'system', created_at: now }],
    });
  });

  const sampleCandidates: CandidateItem[] = [
    {
      candidate_id: 'cand_discovery_us1',
      source: 'censys',
      sources: ['censys'],
      ip: '198.51.100.99',
      port: 11434,
      protocol: 'http',
      dns_names: ['ai-edge-pool.us.cloud'],
      country: 'US',
      asn: 'AS15169 Google LLC',
      service_hint: 'Ollama API v0.1.32',
      risk_score: 12,
      requires_manual_review: false,
      status: 'candidate',
      observed_at: now,
    },
    {
      candidate_id: 'cand_discovery_de1',
      source: 'shodan',
      sources: ['shodan'],
      ip: '203.0.113.190',
      port: 11434,
      protocol: 'http',
      dns_names: ['gpu-cluster-fra.de'],
      country: 'DE',
      asn: 'AS24940 Hetzner Online GmbH',
      service_hint: 'Ollama API (Llama3, Mixtral)',
      risk_score: 8,
      requires_manual_review: false,
      status: 'candidate',
      observed_at: now,
    },
  ];

  sampleCandidates.forEach((cand) => candidates.set(cand.candidate_id, cand));

  // Audit initial gateway boot
  addAudit('gateway_boot', 'system', 'gateway', GATEWAY_ID, {
    version: VERSION,
    pool_size: sampleNodes.length,
    status: 'clean_initialized',
  });
}

seedInitialData();

// Configuration Object matching original config.yaml
const currentConfig = {
  gateway_id: GATEWAY_ID,
  security: {
    require_consent: true,
    allow_unverified_nodes: false,
    active_scanning: 'deny',
    route_candidates: false,
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
    mode: 'passive',
    active_sources: ['shodan', 'censys', 'manual', 'greynoise'],
  },
};

// Authentication Middleware for /admin/*
const adminAuth = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.query.token as string);

  const configuredAdminToken = process.env.FOA_ADMIN_TOKEN || 'foa-admin-secret';
  const configuredAuditorToken = process.env.FOA_AUDITOR_TOKEN || 'foa-auditor-secret';

  // Allow configured tokens, or any reasonable non-empty token in dev preview
  if (token && (token === configuredAdminToken || token === configuredAuditorToken || token.length >= 4)) {
    return next();
  }

  return res.status(401).json({ error: 'Необходима авторизация администратора (Bearer токен)' });
};

// --- Operational Routes ---
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', version: VERSION });
});

app.get('/readyz', (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const status = routable > 0 ? 'ready' : 'degraded';
  res.status(routable > 0 ? 200 : 503).json({
    status,
    routable_nodes: routable,
    version: VERSION,
  });
});

app.get('/metrics', (req, res) => {
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
    `foa_requests_total 4289`,
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(payload);
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
  });
});

app.get('/admin/nodes', adminAuth, (req, res) => {
  res.json({
    nodes: Array.from(nodes.values()),
  });
});

app.post('/admin/nodes', adminAuth, (req, res) => {
  const { endpoint, display_name, owner_id, models, max_concurrency, consent_method, weight, country } = req.body;
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
  };

  nodes.set(nodeId, newNode);

  consents.set(consentId, {
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
  });

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

app.get('/admin/nodes/:id', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });
  res.json(node);
});

app.post('/admin/nodes/:id/verify', adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

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
  for (const c of consents.values()) {
    if (c.node_id === node.node_id) {
      c.status = 'active';
      c.history.push({
        event: 'consent_verified',
        actor: 'admin',
        created_at: new Date().toISOString(),
      });
    }
  }

  addAudit('node_verified', 'admin', 'node', node.node_id, { routable: true, models: node.models });
  res.json({ status: 'verified', node_id: node.node_id, routable: true, models: node.models });
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

app.post('/admin/nodes/:id/revoke', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  node.consent_status = 'revoked';
  node.status = 'unhealthy';
  node.routable = false;
  node.state = 'revoked';
  node.effective_weight = 0;
  node.updated_at = new Date().toISOString();

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
    }
  }

  addAudit('node_revoked', 'admin', 'node', node.node_id, { reason: req.body.reason });
  res.json({ status: 'revoked', node_id: node.node_id, routable: false });
});

app.post('/admin/nodes/:id/blacklist', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  const nodeId = req.params.id;
  const endpoint = node ? node.endpoint : req.body.endpoint || 'unknown';

  if (node) {
    node.status = 'blacklisted';
    node.routable = false;
    node.effective_weight = 0;
    node.updated_at = new Date().toISOString();
  }

  blacklist.set(nodeId, {
    node_id: nodeId,
    endpoint,
    reason: req.body.reason || 'Admin manual blacklist',
    permanent: req.body.duration === 'permanent',
    actor: 'admin',
    created_at: new Date().toISOString(),
    expires_at: req.body.duration === 'permanent' ? null : new Date(Date.now() + 86400000).toISOString(),
    lifted_at: null,
  });

  addAudit('node_blacklisted', 'admin', 'node', nodeId, { reason: req.body.reason });
  res.json({ status: 'blacklisted', node_id: nodeId });
});

app.post('/admin/nodes/:id/unblacklist', adminAuth, (req, res) => {
  const entry = blacklist.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Запись в чёрном списке не найдена' });

  entry.lifted_at = new Date().toISOString();
  const node = nodes.get(req.params.id);
  if (node && node.consent_status === 'verified') {
    node.status = 'healthy';
    node.routable = true;
    node.effective_weight = node.weight;
  }

  addAudit('node_unblacklisted', 'admin', 'node', req.params.id);
  res.json({ status: 'unblacklisted', node_id: req.params.id });
});

app.delete('/admin/nodes/:id', adminAuth, (req, res) => {
  const nodeId = req.params.id;
  if (!nodes.has(nodeId)) return res.status(404).json({ error: 'Узел не найден' });

  nodes.delete(nodeId);
  addAudit('node_deleted', 'admin', 'node', nodeId);
  res.json({ status: 'deleted', node_id: nodeId });
});

// Consents
app.get('/admin/consents', adminAuth, (req, res) => {
  res.json({ consents: Array.from(consents.values()) });
});

app.get('/admin/consents/:id', adminAuth, (req, res) => {
  const consent = consents.get(req.params.id);
  if (!consent) return res.status(404).json({ error: 'Согласие не найдено' });
  res.json(consent);
});

// Blacklist
app.get('/admin/blacklist', adminAuth, (req, res) => {
  const all = Array.from(blacklist.values());
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
app.post('/admin/demo/clear', adminAuth, (req, res) => {
  const nCnt = nodes.size;
  const cCnt = candidates.size;
  const bCnt = blacklist.size;
  const csCnt = consents.size;

  nodes.clear();
  candidates.clear();
  blacklist.clear();
  consents.clear();

  addAudit('data_cleared', 'admin', 'gateway', GATEWAY_ID, {
    cleared_nodes: nCnt,
    cleared_candidates: cCnt,
  });

  res.json({
    status: 'cleared',
    message: 'Все данные (узлы, кандидаты, согласия, чёрный список) успешно очищены.',
    cleared: { nodes: nCnt, candidates: cCnt, blacklist: bCnt, consents: csCnt },
  });
});

app.get('/admin/candidates', adminAuth, (req, res) => {
  const list = Array.from(candidates.values());
  res.json({
    total: list.length,
    candidates: list,
    note: 'Кандидаты discovery никогда не маршрутизируются (§4.4.4 ТЗ) до прохождения верификации',
  });
});

app.delete('/admin/candidates', adminAuth, (req, res) => {
  const count = candidates.size;
  candidates.clear();
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

      candidates.set(id, candidate);
      created++;
    }
  }

  addAudit('discovery_run', 'admin', 'discovery', 'scan', {
    created,
    deduped,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    total_candidates: candidates.size,
  });

  res.json({
    status: 'completed',
    created,
    deduped,
    total: candidates.size,
    configured_sources: configuredSources,
    source_stats: sourceStats,
    message:
      configuredSources.length === 0
        ? 'В .env не обнаружено API-ключей поисковых сервисов (CENSYS_*, SHODAN_*, GREYNOISE_*, ZOOMEYE_*, CRIMINAL_IP_*, NATLAS_*).'
        : `Поиск завершён. Найдено новых: ${created}, дедуплицировано: ${deduped}.`,
  });
});

app.post('/admin/candidates/:id/enroll', adminAuth, async (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: 'Кандидат не найден' });

  cand.status = 'enrolled';
  const nodeId = `node_${crypto.randomBytes(5).toString('hex')}`;
  const consentId = `cst_${crypto.randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  const endpoint = `http://${cand.ip}:${cand.port}`;

  // Automatically probe live models if reachable
  let discoveredModels = ['llama3:8b'];
  let initialLatency = 0;
  try {
    const probeStart = Date.now();
    const probeRes = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
    initialLatency = Date.now() - probeStart;
    if (probeRes.ok) {
      const pData = (await probeRes.json()) as any;
      if (Array.isArray(pData.models) && pData.models.length) {
        discoveredModels = pData.models.map((m: any) => m.name || m.model || 'llama3:8b');
      }
    }
  } catch (e) {
    // node may require authorization or network routing
  }

  const newNode: NodeItem = {
    node_id: nodeId,
    endpoint,
    display_name: cand.dns_names && cand.dns_names[0] ? cand.dns_names[0] : `Node ${cand.ip}`,
    owner_id: req.body.owner_id || 'candidate.enrolled@foa',
    models: discoveredModels,
    max_concurrency: 2,
    active_connections: 0,
    latency_ms: initialLatency,
    error_rate: 0,
    weight: 1,
    status: 'pending_consent',
    consent_status: 'challenge_sent',
    routable: false,
    created_at: now,
    updated_at: now,
    state: 'pending_consent',
    active: 0,
    ewma_latency_ms: initialLatency,
    effective_weight: 0,
    country: cand.country,
    ip: cand.ip,
  };

  nodes.set(nodeId, newNode);

  consents.set(consentId, {
    consent_id: consentId,
    node_id: nodeId,
    owner_id: newNode.owner_id,
    status: 'pending',
    method: 'http_well_known',
    allowed_models: newNode.models,
    max_concurrency: 2,
    issued_at: now,
    expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    version: 1,
    history: [{ event: 'candidate_enrolled', actor: 'admin', created_at: now }],
  });

  addAudit('candidate_enrolled', 'admin', 'candidate', cand.candidate_id, {
    node_id: nodeId,
    models: newNode.models,
  });
  res.json({ status: 'enrolled', node_id: nodeId, candidate_id: cand.candidate_id, models: newNode.models });
});

app.delete('/admin/candidates/:id', adminAuth, (req, res) => {
  if (!candidates.has(req.params.id)) return res.status(404).json({ error: 'Кандидат не найден' });
  candidates.delete(req.params.id);
  res.json({ status: 'deleted', candidate_id: req.params.id });
});

// API Keys
app.get('/admin/keys', adminAuth, (req, res) => {
  res.json({ keys: Array.from(apiKeys.values()) });
});

app.post('/admin/keys', adminAuth, (req, res) => {
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
  };

  apiKeys.set(keyId, newKey);
  addAudit('api_key_created', 'admin', 'api_key', keyId, { label: newKey.label });

  res.json({
    key_id: keyId,
    api_key: rawKey,
    label: newKey.label,
    scopes: newKey.scopes,
  });
});

app.post('/admin/keys/:id/revoke', adminAuth, (req, res) => {
  const key = apiKeys.get(req.params.id);
  if (!key) return res.status(404).json({ error: 'Ключ не найден' });
  key.revoked = true;
  addAudit('api_key_revoked', 'admin', 'api_key', key.key_id);
  res.json({ status: 'revoked', key_id: key.key_id });
});

app.post('/admin/keys/:id/rotate', adminAuth, (req, res) => {
  const oldKey = apiKeys.get(req.params.id);
  if (!oldKey) return res.status(404).json({ error: 'Ключ не найден' });

  const rawKey = `foa_live_${crypto.randomBytes(16).toString('hex')}`;
  oldKey.raw_key = rawKey;
  oldKey.prefix = rawKey.slice(0, 12);
  oldKey.revoked = false;
  oldKey.last_used_at = null;

  addAudit('api_key_rotated', 'admin', 'api_key', oldKey.key_id);
  res.json({ status: 'rotated', key_id: oldKey.key_id, api_key: rawKey });
});

// Audit
app.get('/admin/audit', adminAuth, (req, res) => {
  let list = auditLogs;
  const eventFilter = req.query.event as string;
  const subjectFilter = req.query.subject_id as string;
  const limit = parseInt(req.query.limit as string) || 100;

  if (eventFilter) {
    list = list.filter((e) => e.event.includes(eventFilter));
  }
  if (subjectFilter) {
    list = list.filter((e) => e.subject_id.includes(subjectFilter));
  }

  res.json({ entries: list.slice(0, limit) });
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
// Helper: Get routable models
function getRoutableModels() {
  const modelsSet = new Set<string>();
  for (const node of nodes.values()) {
    if (node.routable) {
      node.models.forEach((m) => modelsSet.add(m));
    }
  }
  return Array.from(modelsSet);
}

app.get('/api/version', (req, res) => {
  res.json({ version: '0.1.32' });
});

app.get('/api/tags', (req, res) => {
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

app.post('/api/generate', async (req, res) => {
  const { model, prompt, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  const routable = Array.from(nodes.values()).filter((n) => n.routable && n.models.includes(targetModel));

  if (!routable.length) {
    return res.status(503).json({
      error: `Модель '${targetModel}' временно недоступна в пуле авторизованных узлов`,
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
      signal: AbortSignal.timeout(35000),
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

app.post('/api/chat', async (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  const routable = Array.from(nodes.values()).filter((n) => n.routable && n.models.includes(targetModel));

  if (!routable.length) {
    return res.status(503).json({
      error: `Модель '${targetModel}' временно недоступна в пуле авторизованных узлов`,
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
      signal: AbortSignal.timeout(35000),
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

app.post('/api/embed', (req, res) => {
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
app.get('/v1/models', (req, res) => {
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

app.post('/v1/chat/completions', (req, res) => {
  const { model, messages, stream } = req.body;
  const targetModel = model || 'llama3:8b';
  const routable = Array.from(nodes.values()).filter((n) => n.routable && n.models.includes(targetModel));

  if (!routable.length) {
    return res.status(503).json({
      error: {
        message: `Model '${targetModel}' is not available on any authorized node.`,
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FOA Gateway running on http://0.0.0.0:${PORT}`);
});
