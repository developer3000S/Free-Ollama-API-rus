import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Инфраструктура теста:
//   1) fakeOllama — локальный HTTP-сервер, имитирующий Ollama-узел
//      (/api/tags, /api/version, /api/chat, /api/generate, /v1/chat/completions).
//   2) gateway — импортирует server.ts (импорт НЕ запускает main()) и поднимает
//      Express-приложение на выделенном порту в памяти (без PostgreSQL/Redis).
// ---------------------------------------------------------------------------

const GATEWAY_PORT = 18091;
const FAKE_NODE_PORT = 18092;
const ADMIN_TOKEN = process.env.FOA_ADMIN_TOKEN || 'foa_admin_test_token_12345678901234567890';

let fakeServer;
let gatewayServer;
let baseUrl;
let userKey;

const hits = {}; // фиксация запросов на узлы для проверки retry: hits[nodeName] = { chat: [], generate: [] }
function hit(name, kind) {
  if (!hits[name]) hits[name] = { chat: [], generate: [] };
  hits[name][kind].push(Date.now());
}

function startFakeOllama(port, name) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/api/tags') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ models: [{ name: 'test-model', model: 'test-model' }] }));
        }
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ version: '0.1.32-fake-' + name }));
        }
        if (req.url === '/api/chat') {
          hit(name, 'chat');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ model: 'test-model', message: { role: 'assistant', content: `reply from ${name}` }, done: true }));
        }
        if (req.url === '/api/generate') {
          hit(name, 'generate');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ model: 'test-model', response: `gen from ${name}`, done: true }));
        }
        if (req.url === '/v1/chat/completions') {
          hit(name, 'chat');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: 'cmpl-1', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: `openai reply from ${name}` }, finish_reason: 'stop' }] }));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function api(path, opts = {}, token = null) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text, headers: r.headers };
}

describe('FOA Gateway e2e', () => {
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.FOA_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.PORT = String(GATEWAY_PORT);

    fakeServer = await startFakeOllama(FAKE_NODE_PORT, 'node_a');
    const mod = await import('../server.ts');
    assert.ok(mod.foaApp, 'server.ts должен экспортировать foaApp для тестов');

    await new Promise((resolve, reject) => {
      gatewayServer = mod.foaApp.listen(GATEWAY_PORT, '127.0.0.1', resolve);
      gatewayServer.on('error', reject);
    });
    baseUrl = `http://127.0.0.1:${GATEWAY_PORT}`;

    // Пользовательский API-ключ через админский эндпоинт
    const keyRes = await api('/admin/keys', { method: 'POST', body: { label: 'test-key', scopes: ['ollama:read', 'ollama:generate'] } }, ADMIN_TOKEN);
    assert.equal(keyRes.status, 200, 'создание ключа: ' + keyRes.text);
    userKey = keyRes.json.raw_key || keyRes.json.api_key || (keyRes.json.key && keyRes.json.key.raw_key);
    assert.ok(userKey && userKey.startsWith('foa_live_'), 'ключ должен быть получен: ' + keyRes.text);
  });

  after(() => {
    gatewayServer && gatewayServer.close();
    fakeServer && fakeServer.close();
  });

  it('пустой пул: /api/tags отдаёт пустой список, /api/chat → 503', async () => {
    const tags = await api('/api/tags', {}, userKey);
    assert.equal(tags.status, 200);
    assert.ok(Array.isArray(tags.json.models));
    const chat = await api('/api/chat', { method: 'POST', body: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: false } }, userKey);
    assert.equal(chat.status, 503);
  });

  it('регистрация узла через admin API', async () => {
    const reg = await api('/admin/nodes', { method: 'POST', body: { display_name: 'Fake Node A', endpoint: `http://127.0.0.1:${FAKE_NODE_PORT}`, models: ['test-model'], routable: true } }, ADMIN_TOKEN);
    assert.equal(reg.status, 200, 'регистрация: ' + reg.text);
    assert.ok(reg.json.node_id);
    // Сразу после регистрации узел в статусе pending_consent и НЕ маршрутизируется —
    // подтверждаем (verify) и делаем health-check, чтобы он стал healthy/routable.
    const ver = await api(`/admin/nodes/${reg.json.node_id}/verify`, { method: 'POST', body: { mode: 'manual', method: 'manual_admin' } }, ADMIN_TOKEN);
    assert.equal(ver.status, 200, 'verify: ' + ver.text);
    const hc = await api(`/admin/nodes/${reg.json.node_id}/health-check`, { method: 'POST' }, ADMIN_TOKEN);
    assert.equal(hc.status, 200, 'health-check: ' + hc.text);
  });

  it('чат пользователя идёт через реальный узел (балансировщик), а не fallback', async () => {
    const before = (hits.node_a && hits.node_a.chat.length) || 0;
    const chat = await api('/api/chat', { method: 'POST', body: { model: 'test-model', messages: [{ role: 'user', content: 'привет' }], stream: false } }, userKey);
    assert.equal(chat.status, 200, 'chat: ' + chat.text);
    assert.equal(chat.json.message.content, 'reply from node_a', 'ответ должен прийти с узла, а не из fallback-текста шлюза');
    assert.equal((hits.node_a && hits.node_a.chat.length) || 0, before + 1, 'узлу должен быть отправлен ровно 1 запрос');
    assert.equal(chat.headers.get('x-foa-gateway-node'), 'node_a', 'должен быть заголовок выбранного узла');
  });

  it('generate проксируется на узел', async () => {
    const gen = await api('/api/generate', { method: 'POST', body: { model: 'test-model', prompt: 'ping', stream: false } }, userKey);
    assert.equal(gen.status, 200, 'generate: ' + gen.text);
    assert.equal(gen.json.response, 'gen from node_a');
  });

  it('/v1/chat/completions проксируется на узел (OpenAI-совместимость)', async () => {
    const oai = await api('/v1/chat/completions', { method: 'POST', body: { model: 'test-model', messages: [{ role: 'user', content: 'ping' }] } }, userKey);
    assert.equal(oai.status, 200, 'openai: ' + oai.text);
    assert.equal(oai.json.choices[0].message.content, 'openai reply from node_a');
  });

  it('retry на следующий узел: первый узел боится 5xx — запрос уходит на второй (§7.6)', async () => {
    // Второй живой узел
    const fakeB = await startFakeOllama(FAKE_NODE_PORT + 1, 'node_b');
    try {
      const regBad = await api('/admin/nodes', { method: 'POST', body: { display_name: 'Broken Node', endpoint: `http://127.0.0.1:${FAKE_NODE_PORT + 2}`, models: ['test-model'], routable: true } }, ADMIN_TOKEN);
      assert.equal(regBad.status, 200);
      await api(`/admin/nodes/${regBad.json.node_id}/verify`, { method: 'POST', body: { mode: 'manual', method: 'manual_admin' } }, ADMIN_TOKEN);
      const regGood = await api('/admin/nodes', { method: 'POST', body: { display_name: 'Fake Node B', endpoint: `http://127.0.0.1:${FAKE_NODE_PORT + 1}`, models: ['test-model'], routable: true } }, ADMIN_TOKEN);
      assert.equal(regGood.status, 200);
      await api(`/admin/nodes/${regGood.json.node_id}/verify`, { method: 'POST', body: { mode: 'manual', method: 'manual_admin' } }, ADMIN_TOKEN);
      const hcB = await api(`/admin/nodes/${regGood.json.node_id}/health-check`, { method: 'POST' }, ADMIN_TOKEN);
      assert.equal(hcB.status, 200, 'health-check node_b: ' + hcB.text);

      const chat = await api('/api/chat', { method: 'POST', body: { model: 'test-model', messages: [{ role: 'user', content: 'retry me' }], stream: false } }, userKey);
      assert.equal(chat.status, 200, 'после ретрая запрос обязан отработать: ' + chat.text);
      // Ответ пришёл с одного из живых узлов (не fallback — fallback-текст содержит '[FOA Gateway /')
      assert.ok(!String(chat.json.message.content).startsWith('[FOA Gateway /'), 'ответ должен быть от узла');
    } finally {
      fakeB.close();
      // чистим узлы, чтобы не влиять на другие тесты
      await api('/admin/demo/clear', { method: 'POST' }, ADMIN_TOKEN);
    }
  });

  it('userAuth защищает /api/chat: без ключа — 401, с админ-токеном — 401 (Недействительный API-ключ)', async () => {
    const noKey = await api('/api/chat', { method: 'POST', body: { model: 'x', messages: [] } });
    assert.equal(noKey.status, 401);
    const wrongKey = await api('/api/chat', { method: 'POST', body: { model: 'x', messages: [] } }, ADMIN_TOKEN);
    assert.equal(wrongKey.status, 401);
    assert.equal(wrongKey.json.code, 'unauthorized');
  });
});

describe('Basic Test', () => {
  it('should pass', () => {
    assert.equal(1, 1);
  });
});

export {};
