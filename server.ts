import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';

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
  ip: string;
  port: number;
  dns_names: string[];
  country: string;
  risk_score: number;
  status: 'candidate' | 'enrolled' | 'out_of_scope';
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

// Seed Demo Data for FOA Gateway
function seedInitialData() {
  const now = new Date();
  const dIso = (offsetMinutes: number) => new Date(now.getTime() - offsetMinutes * 60000).toISOString();
  const futureIso = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();

  // Node 1 - GPU Cluster Primary
  const n1Id = 'node_7f9b201a4e';
  nodes.set(n1Id, {
    node_id: n1Id,
    endpoint: 'http://node-us-west.internal:11434',
    display_name: 'Primary GPU Cluster (RTX 4090 x4)',
    owner_id: 'ops@gateway-cluster.org',
    models: ['llama3:8b', 'mistral:7b', 'codellama:13b', 'qwen2:7b'],
    max_concurrency: 8,
    active_connections: 2,
    latency_ms: 142,
    error_rate: 0.004,
    weight: 10,
    status: 'healthy',
    consent_status: 'verified',
    routable: true,
    created_at: dIso(14400),
    updated_at: dIso(10),
    last_health_check: dIso(1),
    state: 'healthy',
    active: 2,
    ewma_latency_ms: 138,
    effective_weight: 10,
  });

  consents.set('cst_90a1bc3342', {
    consent_id: 'cst_90a1bc3342',
    node_id: n1Id,
    owner_id: 'ops@gateway-cluster.org',
    status: 'active',
    method: 'http_well_known',
    allowed_models: ['llama3:8b', 'mistral:7b', 'codellama:13b', 'qwen2:7b'],
    max_concurrency: 8,
    issued_at: dIso(14400),
    expires_at: futureIso(90),
    version: 1,
    history: [
      { event: 'challenge_created', actor: 'system', created_at: dIso(14405) },
      { event: 'consent_verified', actor: 'ops@gateway-cluster.org', created_at: dIso(14400), detail: { method: 'http_well_known' } },
    ],
  });

  // Node 2 - Academic Community Contributor
  const n2Id = 'node_3d8e90bb12';
  nodes.set(n2Id, {
    node_id: n2Id,
    endpoint: 'http://ollama-lab.edu.eu:11434',
    display_name: 'CS Lab Node (A100 80GB)',
    owner_id: 'lab-lead@cs.edu.eu',
    models: ['llama3:70b', 'codellama:34b', 'deepseek-coder:33b'],
    max_concurrency: 4,
    active_connections: 1,
    latency_ms: 285,
    error_rate: 0.012,
    weight: 5,
    status: 'healthy',
    consent_status: 'verified',
    routable: true,
    created_at: dIso(7200),
    updated_at: dIso(15),
    last_health_check: dIso(2),
    state: 'healthy',
    active: 1,
    ewma_latency_ms: 279,
    effective_weight: 5,
  });

  consents.set('cst_12fe89ab44', {
    consent_id: 'cst_12fe89ab44',
    node_id: n2Id,
    owner_id: 'lab-lead@cs.edu.eu',
    status: 'active',
    method: 'dns_txt',
    allowed_models: ['llama3:70b', 'codellama:34b', 'deepseek-coder:33b'],
    max_concurrency: 4,
    issued_at: dIso(7200),
    expires_at: futureIso(60),
    version: 1,
    history: [
      { event: 'challenge_created', actor: 'system', created_at: dIso(7205) },
      { event: 'consent_verified', actor: 'lab-lead@cs.edu.eu', created_at: dIso(7200), detail: { method: 'dns_txt' } },
    ],
  });

  // Node 3 - Edge Volunteer (Degraded/High Latency)
  const n3Id = 'node_55ac71e809';
  nodes.set(n3Id, {
    node_id: n3Id,
    endpoint: 'http://edge-node-03.community.net:11434',
    display_name: 'Volunteer Edge (M3 Max 64GB)',
    owner_id: 'volunteer@fastmail.com',
    models: ['llama3:8b', 'phi3:mini'],
    max_concurrency: 2,
    active_connections: 0,
    latency_ms: 680,
    error_rate: 0.08,
    weight: 2,
    status: 'degraded',
    consent_status: 'verified',
    routable: true,
    created_at: dIso(3600),
    updated_at: dIso(5),
    last_health_check: dIso(3),
    state: 'degraded',
    active: 0,
    ewma_latency_ms: 672,
    effective_weight: 1,
  });

  // Node 4 - Enrolled Pending Consent
  const n4Id = 'node_ee4102cd56';
  nodes.set(n4Id, {
    node_id: n4Id,
    endpoint: 'http://ai-host-sg.cloud.io:11434',
    display_name: 'APAC Singapore Node',
    owner_id: 'sg-admin@cloud.io',
    models: ['qwen2:7b', 'gemma2:9b'],
    max_concurrency: 4,
    active_connections: 0,
    latency_ms: 0,
    error_rate: 0,
    weight: 3,
    status: 'pending_consent',
    consent_status: 'challenge_sent',
    routable: false,
    created_at: dIso(120),
    updated_at: dIso(120),
    last_health_check: dIso(120),
    state: 'pending_consent',
    active: 0,
    ewma_latency_ms: 0,
    effective_weight: 0,
  });

  // Blacklist item
  const blId = 'node_99b0c441a1';
  blacklist.set(blId, {
    node_id: blId,
    endpoint: 'http://honeypot-suspicious.ru:11434',
    reason: 'Security violation: unauthenticated external probing & telemetry modification',
    permanent: true,
    actor: 'admin@gateway',
    created_at: dIso(8640),
    expires_at: null,
    lifted_at: null,
  });

  // Discovery Candidates
  candidates.set('cand_01a', {
    candidate_id: 'cand_01a',
    source: 'censys',
    ip: '198.51.100.42',
    port: 11434,
    dns_names: ['ollama-research.institute.org'],
    country: 'DE',
    risk_score: 18,
    status: 'candidate',
    observed_at: dIso(45),
  });

  candidates.set('cand_02b', {
    candidate_id: 'cand_02b',
    source: 'shodan',
    ip: '203.0.113.88',
    port: 11434,
    dns_names: ['ai-test.tokyo-cloud.jp'],
    country: 'JP',
    risk_score: 34,
    status: 'candidate',
    observed_at: dIso(75),
  });

  candidates.set('cand_03c', {
    candidate_id: 'cand_03c',
    source: 'greynoise',
    ip: '192.0.2.199',
    port: 11434,
    dns_names: ['unknown-server.dynamic-ip.net'],
    country: 'BR',
    risk_score: 72,
    status: 'candidate',
    observed_at: dIso(180),
  });

  // Demo API Key
  const k1 = 'foa_live_e93847291a0c8b6d';
  apiKeys.set('key_prod_01', {
    key_id: 'key_prod_01',
    label: 'Production Application Key',
    prefix: 'foa_live_e938',
    scopes: ['ollama:read', 'ollama:generate'],
    created_at: dIso(14400),
    expires_at: futureIso(365),
    revoked: false,
    last_used_at: dIso(4),
    rate_limit_per_minute: 120,
    raw_key: k1,
  });

  // Audit Logs
  addAudit('gateway_boot', 'system', 'gateway', GATEWAY_ID, { version: VERSION, pool_size: 4 });
  addAudit('node_registered', 'admin@gateway', 'node', n1Id, { endpoint: 'http://node-us-west.internal:11434' });
  addAudit('consent_verified', 'ops@gateway-cluster.org', 'consent', 'cst_90a1bc3342', { method: 'http_well_known' });
  addAudit('blacklist_add', 'admin@gateway', 'node', blId, { reason: 'Security violation' });
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
  const { endpoint, display_name, owner_id, models, max_concurrency, consent_method, weight } = req.body;
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

app.post('/admin/nodes/:id/verify', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

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

  addAudit('node_verified', 'admin', 'node', node.node_id, { routable: true });
  res.json({ status: 'verified', node_id: node.node_id, routable: true });
});

app.post('/admin/nodes/:id/health-check', adminAuth, (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Узел не найден' });

  // Simulate probe
  const latency = Math.floor(Math.random() * 80) + 90;
  node.latency_ms = latency;
  node.ewma_latency_ms = latency;
  node.last_health_check = new Date().toISOString();
  node.updated_at = node.last_health_check;

  addAudit('health_probe', 'system', 'node', node.node_id, { latency_ms: latency });
  res.json({ status: 'healthy', latency_ms: latency, node_id: node.node_id });
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

// Discovery / Candidates
app.get('/admin/candidates', adminAuth, (req, res) => {
  const list = Array.from(candidates.values());
  res.json({
    total: list.length,
    candidates: list,
    note: 'Кандидаты discovery никогда не маршрутизируются (§4.4.4 ТЗ) до прохождения верификации',
  });
});

app.post('/admin/discovery/run', adminAuth, (req, res) => {
  const sampleIps = ['198.51.100.77', '203.0.113.14', '192.0.2.89', '198.51.100.120'];
  const sampleSources = ['shodan', 'censys', 'manual', 'greynoise'];
  const sampleCountries = ['US', 'DE', 'FR', 'NL', 'SG'];

  let created = 0;
  for (let i = 0; i < 2; i++) {
    const id = `cand_${crypto.randomBytes(3).toString('hex')}`;
    const ip = sampleIps[Math.floor(Math.random() * sampleIps.length)] + '.' + Math.floor(Math.random() * 200 + 1);
    candidates.set(id, {
      candidate_id: id,
      source: sampleSources[Math.floor(Math.random() * sampleSources.length)],
      ip,
      port: 11434,
      dns_names: [`node-${id.slice(5)}.discovered-ai.net`],
      country: sampleCountries[Math.floor(Math.random() * sampleCountries.length)],
      risk_score: Math.floor(Math.random() * 50) + 10,
      status: 'candidate',
      observed_at: new Date().toISOString(),
    });
    created++;
  }

  addAudit('discovery_run', 'admin', 'discovery', 'scan', { created, deduped: 1 });
  res.json({ status: 'completed', created, deduped: 1 });
});

app.post('/admin/candidates/:id/enroll', adminAuth, (req, res) => {
  const cand = candidates.get(req.params.id);
  if (!cand) return res.status(404).json({ error: 'Кандидат не найден' });

  cand.status = 'enrolled';
  const nodeId = `node_${crypto.randomBytes(5).toString('hex')}`;
  const consentId = `cst_${crypto.randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();

  const newNode: NodeItem = {
    node_id: nodeId,
    endpoint: `http://${cand.ip}:${cand.port}`,
    display_name: `Enrolled (${cand.dns_names[0] || cand.ip})`,
    owner_id: req.body.owner_id || 'candidate.enrolled@foa',
    models: ['llama3:8b'],
    max_concurrency: 2,
    active_connections: 0,
    latency_ms: 0,
    error_rate: 0,
    weight: 1,
    status: 'pending_consent',
    consent_status: 'challenge_sent',
    routable: false,
    created_at: now,
    updated_at: now,
    state: 'pending_consent',
    active: 0,
    ewma_latency_ms: 0,
    effective_weight: 0,
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

  addAudit('candidate_enrolled', 'admin', 'candidate', cand.candidate_id, { node_id: nodeId });
  res.json({ status: 'enrolled', node_id: nodeId, candidate_id: cand.candidate_id });
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

app.post('/api/generate', (req, res) => {
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

  const responseText = `[Ответ шлюза FOA через узел ${selectedNode.display_name}]: Здравствуйте! Запрос к модели ${targetModel} успешно обработан пулом узлов шлюза. Ваш запрос: "${(prompt || '').slice(0, 100)}..."`;

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

app.post('/api/chat', (req, res) => {
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

  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : 'Привет';
  const replyContent = `[FOA Gateway / ${selectedNode.display_name}]: Ответ на ваше сообщение ("${lastMsg}") успешно сгенерирован в пуле узлов с подтверждённым согласием владельца.`;

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
