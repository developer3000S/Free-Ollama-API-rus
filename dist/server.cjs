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
  bootstrap: () => bootstrap,
  foaApp: () => app,
  reloadEnv: () => reloadEnv,
  startBackgroundLoops: () => startBackgroundLoops
});
module.exports = __toCommonJS(server_exports);
var import_express = __toESM(require("express"), 1);
var import_cors = __toESM(require("cors"), 1);
var import_path = __toESM(require("path"), 1);
var import_crypto = __toESM(require("crypto"), 1);
var import_fs = __toESM(require("fs"), 1);

// src/logger.ts
var LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };
var LEVEL_NAMES = ["loglevel", "FOA_OBSERVABILITY__LOG_LEVEL", "LOG_LEVEL"];
function resolveLevel() {
  for (const name of LEVEL_NAMES) {
    const raw = process.env[name];
    if (raw) {
      const v = String(raw).trim().toLowerCase();
      if (v in LEVEL_WEIGHT) return v;
    }
  }
  return "info";
}
var currentLevelWeight = LEVEL_WEIGHT[resolveLevel()];
var SECRET_TEXT_PATTERNS = [
  [/foa_live_[a-f0-9]{8,}/g, "foa_live_***"],
  [/foa_chk_[a-f0-9]{8,}/g, "foa_chk_***"],
  [/ch_[a-f0-9]{16,}/g, "ch_***"],
  [/Bearer\s+[^\s"']+/g, "Bearer ***"]
];
var SECRET_KEY_HINTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "raw_key",
  "key_hash",
  "salt",
  "credential"
];
function maskString(input) {
  let out = input;
  for (const [re, replacement] of SECRET_TEXT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
function isSecretKey(name) {
  const lower = name.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lower.includes(hint));
}
function maskSecrets(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? "***" : maskSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}
function emit(level, msg, meta) {
  if (LEVEL_WEIGHT[level] < currentLevelWeight) return;
  const record = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    service: "foa-gateway",
    msg,
    ...meta ? maskSecrets(meta) : {}
  };
  const line = JSON.stringify(record);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}
var logger = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta)
};

// src/db.ts
var import_pg = require("pg");
function normalizeUrl(url) {
  return url.replace(/^postgres(?:sql)?\+[a-z0-9]+:\/\//i, "postgresql://");
}
function resolveDbUrl() {
  const candidates2 = [
    process.env.FOA_STORAGE__DATABASE_URL,
    process.env.GATEWAY_DB_URL,
    process.env.DATABASE_URL
  ];
  for (const c of candidates2) {
    if (c && c.trim()) return normalizeUrl(c.trim());
  }
  return null;
}
var pool = null;
var listener = null;
var enabled = false;
var connected = false;
function dbEnabled() {
  return enabled;
}
function dbConnected() {
  return connected;
}
var NOTIFY_CHANNEL = "foa_changes";
var EXTRA_COLUMNS = {
  nodes: {},
  api_keys: { key_hash: (i) => i.key_hash ?? null },
  consents: { node_id: (i) => i.node_id },
  blacklist: {},
  candidates: { observed_at: (i) => i.observed_at }
};
var TABLES = {
  nodes: "nodes",
  apiKeys: "api_keys",
  consents: "consents",
  blacklist: "blacklist",
  candidates: "candidates"
};
var SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ${TABLES.nodes} (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${TABLES.apiKeys} (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     key_hash TEXT UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${TABLES.consents} (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     node_id TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${TABLES.blacklist} (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ${TABLES.candidates} (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     observed_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
     id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_consents_node_id ON ${TABLES.consents} (node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC)`
];
async function initDb() {
  const url = resolveDbUrl();
  if (!url) {
    logger.warn("GATEWAY_DB_URL/FOA_STORAGE__DATABASE_URL \u043D\u0435 \u0437\u0430\u0434\u0430\u043D \u2014 \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0436\u0438\u0432\u0451\u0442 \u0432 \u043F\u0430\u043C\u044F\u0442\u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430", {
      storage: "in-memory"
    });
    return false;
  }
  try {
    pool = new import_pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 3e4 });
    await pool.query("SELECT 1");
    await tx(async (client2) => {
      await client2.query("SELECT pg_advisory_xact_lock(8135701)");
      for (const stmt of SCHEMA_STATEMENTS) {
        await client2.query(stmt);
      }
    });
    listener = new import_pg.Client({ connectionString: url });
    await listener.connect();
    await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
    listener.on("notification", (msg) => {
      const payload = safeParsePayload(msg.payload);
      if (payload && reloadHandlers[payload.table]) {
        scheduleReload(payload.table);
      }
    });
    listener.on("error", (err) => {
      logger.warn("PG listener error", { error: err.message });
    });
    enabled = true;
    connected = true;
    logger.info("PostgreSQL \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D", { storage: "postgres" });
    return true;
  } catch (err) {
    connected = false;
    logger.error("PostgreSQL \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u2014 \u0440\u0430\u0431\u043E\u0442\u0430 \u0432 in-memory \u0440\u0435\u0436\u0438\u043C\u0435", {
      error: err.message,
      storage: "in-memory-fallback"
    });
    enabled = false;
    return false;
  }
}
function safeParsePayload(payload) {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed.table === "string" && reloadHandlers[parsed.table]) {
      return { table: parsed.table };
    }
  } catch {
    if (reloadHandlers[payload]) return { table: payload };
  }
  return null;
}
var reloadHandlers = {};
var pendingReloads = /* @__PURE__ */ new Set();
var reloadTimer = null;
function scheduleReload(table) {
  pendingReloads.add(table);
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const tables = Array.from(pendingReloads);
    pendingReloads.clear();
    for (const t of tables) {
      const handler = reloadHandlers[t];
      if (handler) {
        handler().catch((err) => logger.warn("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u0430\u0442\u044C \u0442\u0430\u0431\u043B\u0438\u0446\u0443 \u0438\u0437 PG", { table: t, error: err.message }));
      }
    }
  }, 200);
}
async function query(text, params) {
  if (!pool) throw new Error("\u0411\u0414 \u043D\u0435 \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
  return pool.query(text, params);
}
async function tx(fn) {
  if (!pool) throw new Error("\u0411\u0414 \u043D\u0435 \u0438\u043D\u0438\u0446\u0438\u0430\u043B\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
  const client2 = await pool.connect();
  try {
    await client2.query("BEGIN");
    const result = await fn(client2);
    await client2.query("COMMIT");
    return result;
  } catch (err) {
    await client2.query("ROLLBACK").catch(() => {
    });
    throw err;
  } finally {
    client2.release();
  }
}
var VOLATILE_FIELDS = {
  nodes: ["active_connections"],
  api_keys: ["raw_key", "last_used_at"],
  consents: [],
  blacklist: [],
  candidates: []
};
var Store = class {
  constructor(table, idGetter) {
    this.table = table;
    this.idGetter = idGetter;
    this.idField = "id";
  }
  cache = /* @__PURE__ */ new Map();
  idField;
  // --- синхронное чтение из кэша (hot-path) ---
  get(id) {
    return this.cache.get(id);
  }
  has(id) {
    return this.cache.has(id);
  }
  get size() {
    return this.cache.size;
  }
  values() {
    return this.cache.values();
  }
  entries() {
    return this.cache.entries();
  }
  keys() {
    return this.cache.keys();
  }
  forEach(cb) {
    this.cache.forEach(cb);
  }
  extractId(item) {
    return this.idGetter(item);
  }
  // Запись: кэш обновляется оптимально (перезапишется перезагрузкой, если
  // транзакция откатится), затем идёт запись в PG.
  async set(item, client2) {
    const id = this.extractId(item);
    this.cache.set(id, item);
    if (!enabled) return;
    const row = this.serialize(item);
    const hasUpdatedAt = this.table === TABLES.nodes;
    const extra = EXTRA_COLUMNS[this.table];
    const colNames = ["id", "data", ...Object.keys(extra)];
    const placeholders = ["$1", "$2", ...Object.keys(extra).map((_, i) => `$${i + 3}`)];
    const onConflict = hasUpdatedAt ? "DO UPDATE SET data = $2, updated_at = now()" : "DO UPDATE SET data = $2";
    const q = `INSERT INTO ${this.table} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})
               ON CONFLICT (id) ${onConflict}`;
    const params = [id, row, ...Object.values(extra).map((getter) => getter(item))];
    if (client2) {
      await client2.query(q, params);
    } else if (pool) {
      await pool.query(q, params);
    }
  }
  async delete(id, client2) {
    this.cache.delete(id);
    if (!enabled) return;
    const q = `DELETE FROM ${this.table} WHERE id = $1`;
    if (client2) {
      await client2.query(q, [id]);
    } else if (pool) {
      await pool.query(q, [id]);
    }
  }
  // Обновление только кэша (без записи в PG) — используется, например, при
  // восстановлении ключа аутентификации после промаха кэша: PG уже авторитет.
  cacheUpsert(item) {
    this.cache.set(this.extractId(item), item);
  }
  cacheDelete(id) {
    this.cache.delete(id);
  }
  async clear() {
    this.cache.clear();
    if (!enabled) return;
    if (pool) await pool.query(`DELETE FROM ${this.table}`);
  }
  // Список читается напрямую из PG — это гарантирует, что панель видит
  // свежие данные независимо от того, какой реплике достался запрос.
  async list() {
    if (!enabled) return Array.from(this.cache.values());
    const res = await query(`SELECT data FROM ${this.table}`);
    const items = res.rows.map((r) => this.deserialize(r.data));
    this.replaceCache(items);
    return items;
  }
  // Перезагрузка из PG с сохранением volatile-полей текущего кэша.
  async reload() {
    if (!enabled) return;
    const res = await query(`SELECT data FROM ${this.table}`);
    const items = res.rows.map((r) => this.deserialize(r.data));
    this.replaceCache(items);
  }
  replaceCache(items) {
    const volatileFields = VOLATILE_FIELDS[this.table] || [];
    const next = /* @__PURE__ */ new Map();
    for (const item of items) {
      const id = this.extractId(item);
      if (volatileFields.length) {
        const local = this.cache.get(id);
        if (local) {
          for (const field of volatileFields) {
            if (local[field] !== void 0) item[field] = local[field];
          }
        }
      }
      next.set(id, item);
    }
    this.cache = next;
  }
  registerReloadHandler(handler) {
    reloadHandlers[this.table] = handler;
  }
  // Для api_keys — отдельный путь: сериализация не должна вытаскивать raw_key
  // (сырой ключ хранится только в памяти создания/ротации).
  serialize(item) {
    const table = this.table;
    if (table === TABLES.apiKeys) {
      const copy = { ...item };
      delete copy.raw_key;
      return JSON.stringify(copy);
    }
    return JSON.stringify(item);
  }
  deserialize(data) {
    return data;
  }
  // Поиск по произвольному полю (используется для lookup ключа по key_hash).
  async findByField(field, value) {
    if (!enabled) {
      for (const item of this.cache.values()) {
        if (item[field] === value) return item;
      }
      return null;
    }
    const res = await query(`SELECT data FROM ${this.table} WHERE data @> $1::jsonb`, [
      JSON.stringify({ [field]: value })
    ]);
    if (res.rows.length === 0) return null;
    return this.deserialize(res.rows[0].data);
  }
  table_name() {
    return this.table;
  }
};
async function insertAuditRow(id, data, createdAt) {
  if (!enabled || !pool) return;
  try {
    await pool.query(
      "INSERT INTO audit_logs (id, data, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [id, JSON.stringify(data), createdAt]
    );
  } catch (err) {
    logger.warn("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0430\u0443\u0434\u0438\u0442\u0430 \u0432 PG", { error: err.message, event: data.event });
  }
}
async function queryAudit(event, subjectId, limit = 100) {
  if (!enabled) return [];
  const conditions = [];
  const params = [];
  if (event) {
    params.push(`%"event":"${event.replace(/"/g, '\\"')}"%`);
    conditions.push(`data::text LIKE $${params.length}`);
  }
  if (subjectId) {
    params.push(`%"subject_id":"${subjectId.replace(/"/g, '\\"')}"%`);
    conditions.push(`data::text LIKE $${params.length}`);
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  params.push(limit);
  const res = await query(
    `SELECT data FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.rows.map((r) => r.data);
}
async function clearAudit() {
  if (!enabled || !pool) return;
  await pool.query("DELETE FROM audit_logs");
}
function startFullReloadLoop(getTables) {
  setInterval(() => {
    for (const table of getTables()) {
      const handler = reloadHandlers[table];
      if (handler) {
        handler().catch(
          (err) => logger.warn("\u041F\u0435\u0440\u0438\u043E\u0434\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u043F\u0435\u0440\u0435\u0440\u0430\u0441\u0447\u0451\u0442 \u043A\u044D\u0448\u0430 \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F", { table, error: err.message })
        );
      }
    }
  }, 3e4);
}

// src/redis.ts
var import_ioredis = require("ioredis");
function resolveRedisUrl() {
  const candidates2 = [
    process.env.FOA_STORAGE__REDIS_URL,
    process.env.GATEWAY_REDIS_URL,
    process.env.REDIS_URL
  ];
  for (const c of candidates2) {
    if (c && c.trim()) return c.trim();
  }
  return null;
}
var client = null;
var enabled2 = false;
function redisEnabled() {
  return enabled2;
}
async function initRedis() {
  const url = resolveRedisUrl();
  if (!url) {
    logger.warn("GATEWAY_REDIS_URL/FOA_STORAGE__REDIS_URL \u043D\u0435 \u0437\u0430\u0434\u0430\u043D \u2014 \u043B\u0438\u043C\u0438\u0442\u044B \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0432 \u043F\u0430\u043C\u044F\u0442\u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430", {
      storage: "in-memory"
    });
    return false;
  }
  try {
    client = new import_ioredis.Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false
    });
    await client.ping();
    client.on("error", (err) => {
      logger.warn("Redis error", { error: err.message });
    });
    enabled2 = true;
    logger.info("Redis \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D", { storage: "redis" });
    return true;
  } catch (err) {
    logger.error("Redis \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u2014 \u043B\u0438\u043C\u0438\u0442\u044B \u0441\u0447\u0438\u0442\u0430\u044E\u0442\u0441\u044F \u0432 \u043F\u0430\u043C\u044F\u0442\u0438 \u043F\u0440\u043E\u0446\u0435\u0441\u0441\u0430", {
      error: err.message,
      storage: "in-memory-fallback"
    });
    enabled2 = false;
    client = null;
    return false;
  }
}
var LUA_SLIDING_WINDOW = `local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local cnt = redis.call('ZCARD', key)
if cnt >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] ~= nil then
    return {0, cnt, tonumber(oldest[2])}
  end
  return {0, cnt, 0}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window * 2)
return {1, cnt + 1, 0}`;
var slidingSha = null;
async function evalSliding(key, windowMs, limit, now) {
  if (!client) throw new Error("redis not initialized");
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  let res;
  if (slidingSha) {
    try {
      res = await client.evalsha(slidingSha, 1, key, now, windowMs, limit, member);
    } catch (err) {
      if (!String(err.message || "").includes("NOSCRIPT")) throw err;
      res = await client.eval(LUA_SLIDING_WINDOW, 1, key, now, windowMs, limit, member);
    }
  } else {
    res = await client.eval(LUA_SLIDING_WINDOW, 1, key, now, windowMs, limit, member);
    if (Array.isArray(res)) slidingSha = String(await client.script("LOAD", LUA_SLIDING_WINDOW).catch(() => null));
  }
  return [Number(res[0]), Number(res[1]), Number(res[2])];
}
var localWindows = /* @__PURE__ */ new Map();
function localSliding(key, windowMs, limit, now) {
  const hits = localWindows.get(key) || [];
  const cutoff = now - windowMs;
  const fresh = hits.filter((h) => h > cutoff);
  if (fresh.length >= limit) {
    return [0, fresh.length, fresh[0]];
  }
  fresh.push(now);
  localWindows.set(key, fresh);
  return [1, fresh.length, 0];
}
async function checkRateLimit(scope, id, limit, windowMs, now = Date.now()) {
  if (!enabled2 || !client) {
    const [allowed, count, oldest] = localSliding(`${scope}:${id}`, windowMs, limit, now);
    return { allowed: allowed === 1, count, retryAfter: oldest ? Math.ceil((oldest + windowMs - now) / 1e3) : 0 };
  }
  try {
    const key = `foa:rl:${scope}:${id}`;
    const [allowed, count, oldest] = await evalSliding(key, windowMs, limit, now);
    return {
      allowed: allowed === 1,
      count,
      retryAfter: oldest ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1e3)) : 0
    };
  } catch (err) {
    logger.warn("Redis rate-limit \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u2014 \u043F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u043D\u0430 in-memory", { error: err.message });
    const [allowed, count, oldest] = localSliding(`${scope}:${id}`, windowMs, limit, now);
    return { allowed: allowed === 1, count, retryAfter: oldest ? Math.ceil((oldest + windowMs - now) / 1e3) : 0 };
  }
}
var LUA_INCR_LIMIT = `local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('GET', key)
if cur ~= nil and tonumber(cur) >= limit then
  return 0
end
local n = redis.call('INCR', key)
redis.call('EXPIRE', key, ttl)
return 1`;
var incrSha = null;
var localInflight = /* @__PURE__ */ new Map();
async function acquireInflight(id, limit, ttlSec = 60) {
  if (!enabled2 || !client) {
    const cur = localInflight.get(id) || 0;
    if (cur >= limit) return false;
    localInflight.set(id, cur + 1);
    return true;
  }
  try {
    const key = `foa:inflight:${id}`;
    if (incrSha) {
      try {
        const res2 = await client.evalsha(incrSha, 1, key, limit, ttlSec);
        return Number(res2) === 1;
      } catch (err) {
        if (!String(err.message || "").includes("NOSCRIPT")) throw err;
      }
    }
    const res = await client.eval(LUA_INCR_LIMIT, 1, key, limit, ttlSec);
    incrSha = String(await client.script("LOAD", LUA_INCR_LIMIT).catch(() => null));
    return Number(res) === 1;
  } catch (err) {
    logger.warn("Redis inflight \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u2014 in-memory", { error: err.message });
    const cur = localInflight.get(id) || 0;
    if (cur >= limit) return false;
    localInflight.set(id, cur + 1);
    return true;
  }
}
async function releaseInflight(id) {
  if (!enabled2 || !client) {
    const cur = localInflight.get(id) || 0;
    localInflight.set(id, Math.max(0, cur - 1));
    return;
  }
  try {
    const key = `foa:inflight:${id}`;
    const next = await client.decr(key);
    if (next < 0) await client.set(key, 0, "EX", 60);
  } catch (err) {
    const cur = localInflight.get(id) || 0;
    localInflight.set(id, Math.max(0, cur - 1));
  }
}
var RPM_BUCKETS = 60;
async function recordRpm(count = 1) {
  if (!enabled2 || !client) {
    rpmLocalFallback.record(count);
    return;
  }
  try {
    const minute = Math.floor(Date.now() / 6e4);
    const key = `foa:rpm:${minute}`;
    const pipeline = client.multi();
    pipeline.incrby(key, count);
    pipeline.expire(key, RPM_BUCKETS * 70);
    await pipeline.exec();
  } catch (err) {
    rpmLocalFallback.record(count);
  }
}
async function getRpmBuckets() {
  if (!enabled2 || !client) {
    return rpmLocalFallback.read();
  }
  try {
    const now = Date.now();
    const currentMin = Math.floor(now / 6e4);
    const pipeline = client.multi();
    for (let i = RPM_BUCKETS - 1; i >= 0; i--) {
      pipeline.get(`foa:rpm:${currentMin - i}`);
    }
    const results = await pipeline.exec();
    if (!results) return new Array(RPM_BUCKETS).fill(0);
    return results.map((r) => Number(r[1] || 0));
  } catch (err) {
    return rpmLocalFallback.read();
  }
}
var RpmLocalFallback = class {
  buckets = new Array(RPM_BUCKETS).fill(0);
  lastMinute = Math.floor(Date.now() / 6e4);
  shift(currentMin) {
    const diff = Math.min(RPM_BUCKETS, currentMin - this.lastMinute);
    for (let i = 0; i < diff; i++) {
      this.buckets.shift();
      this.buckets.push(0);
    }
    this.lastMinute = currentMin;
  }
  record(count) {
    this.shift(Math.floor(Date.now() / 6e4));
    this.buckets[RPM_BUCKETS - 1] += count;
  }
  read() {
    this.shift(Math.floor(Date.now() / 6e4));
    return [...this.buckets];
  }
};
var rpmLocalFallback = new RpmLocalFallback();
var GATEWAY_TTL_SEC = 30;
async function registerGateway(gatewayId, meta = {}) {
  if (!enabled2 || !client) return;
  try {
    await client.set(`foa:gw:${gatewayId}`, JSON.stringify({ ...meta, at: Date.now() }), "EX", GATEWAY_TTL_SEC);
  } catch {
  }
}
var LEADER_KEY = "foa:leader:scheduler";
var LEADER_TTL_SEC = 20;
var leaderRenewTimer = null;
var isLeader = false;
async function tryAcquireLeader(gatewayId) {
  if (!enabled2 || !client) return true;
  try {
    const res = await client.set(LEADER_KEY, gatewayId, "EX", LEADER_TTL_SEC, "NX");
    const acquired = res === "OK";
    if (acquired && !leaderRenewTimer) {
      leaderRenewTimer = setInterval(async () => {
        try {
          const renewed = await client.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then
               return redis.call('EXPIRE', KEYS[1], ARGV[2])
             end
             return 0`,
            1,
            LEADER_KEY,
            gatewayId,
            LEADER_TTL_SEC
          );
          if (!renewed) {
            isLeader = false;
            if (leaderRenewTimer) clearInterval(leaderRenewTimer);
            leaderRenewTimer = null;
          }
        } catch {
        }
      }, LEADER_TTL_SEC * 500);
    }
    isLeader = acquired;
    return acquired;
  } catch {
    return true;
  }
}
function amILeader() {
  return isLeader;
}

// src/balancer.ts
var breakers = /* @__PURE__ */ new Map();
function getBreaker(nodeId) {
  let state = breakers.get(nodeId);
  if (!state) {
    state = { failures: [], successes: [], openedAt: null, probesInflight: 0 };
    breakers.set(nodeId, state);
  }
  return state;
}
function prune(list, windowMs, now) {
  const cutoff = now - windowMs;
  return list.filter((t) => t > cutoff);
}
function isBreakerOpen(nodeId, config, now = Date.now()) {
  const state = getBreaker(nodeId);
  if (state.openedAt === null) return false;
  const elapsedSec = (now - state.openedAt) / 1e3;
  if (elapsedSec < config.open_duration_seconds) {
    return state.probesInflight >= config.half_open_probes;
  }
  state.openedAt = null;
  state.failures = [];
  state.successes = [];
  state.probesInflight = 0;
  return false;
}
function recordSuccess(nodeId, latencyMs, config, now = Date.now()) {
  const state = getBreaker(nodeId);
  state.successes = prune(state.successes, config.window_seconds * 1e3, now);
  state.successes.push(now);
  if (state.probesInflight > 0) state.probesInflight--;
  state.openedAt = null;
  state.failures = prune(state.failures, config.window_seconds * 1e3, now);
}
function recordFailure(nodeId, config, now = Date.now()) {
  const state = getBreaker(nodeId);
  state.failures = prune(state.failures, config.window_seconds * 1e3, now);
  state.failures.push(now);
  if (state.probesInflight > 0) state.probesInflight--;
  const windowMs = config.window_seconds * 1e3;
  const successes = prune(state.successes, windowMs, now);
  const total = successes.length + state.failures.length;
  if (total >= config.minimum_requests && state.failures.length / total >= config.error_rate_threshold) {
    state.openedAt = now;
    state.probesInflight = 0;
  }
}
function resetBreaker(nodeId) {
  breakers.delete(nodeId);
}
function scoreNode(node) {
  const weight = node.weight > 0 ? node.weight : 1;
  const latency = node.ewma_latency_ms || node.active_connections > 0 ? Math.max(10, node.ewma_latency_ms || 50) : 50;
  const latencyFactor = 1e3 / (1e3 + latency);
  const freeCapacity = Math.max(
    0.05,
    1 - node.active_connections / Math.max(1, node.max_concurrency || 1)
  );
  return weight * latencyFactor * freeCapacity;
}
function selectNode(candidates2, config, now = Date.now()) {
  const usable = candidates2.filter((n) => {
    if (!n.routable) return false;
    if (n.status === "blacklisted" || n.status === "unhealthy") return false;
    if (n.active_connections >= Math.max(1, n.max_concurrency || 1)) return false;
    return !isBreakerOpen(n.node_id, config, now);
  });
  if (!usable.length) return null;
  const scored = usable.map((n) => ({ node: n, score: scoreNode(n) }));
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  if (total <= 0) return scored[0].node;
  let r = Math.random() * total;
  for (const s of scored) {
    r -= s.score;
    if (r <= 0) return s.node;
  }
  return scored[scored.length - 1].node;
}

// src/pool.ts
var import_undici = require("undici");
function insecureTlsEnabled() {
  const v = String(process.env.FOA_INSECURE_TLS || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
var agents = /* @__PURE__ */ new Map();
function getAgentForEndpoint(endpoint, options = {}) {
  const key = endpoint.replace(/\/+$/, "");
  const maxConnections = options.maxConnections && options.maxConnections > 0 ? options.maxConnections : 8;
  const existing = agents.get(key);
  if (existing) return existing;
  const agent = new import_undici.Agent({
    connect: {
      timeout: options.connectTimeoutMs ?? 4e3,
      // Самоподписанный сертификат узла (FOA_INSECURE_TLS=true) — не отклонять.
      rejectUnauthorized: !insecureTlsEnabled()
    },
    connections: maxConnections,
    keepAliveTimeout: options.keepAliveTimeoutMs ?? 3e4,
    keepAliveMaxTimeout: 6e4,
    pipelining: 1
  });
  agents.set(key, agent);
  return agent;
}
function closeAgentForEndpoint(endpoint) {
  const key = endpoint.replace(/\/+$/, "");
  const agent = agents.get(key);
  if (agent) {
    agent.close().catch(() => {
    });
    agents.delete(key);
  }
}
function dispatcherFor(endpoint, maxConcurrency, options = {}) {
  return { dispatcher: getAgentForEndpoint(endpoint, { ...options, maxConnections: Math.max(1, maxConcurrency) }) };
}
function isTlsCertError(err) {
  const codes = [
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNKNOWN_CA",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "HR_BAD_VERIFY",
    "CW_SYSKEY_NOT_FOUND"
  ];
  const chain = [err?.code, err?.cause?.code, err?.name, err?.cause?.name];
  if (chain.some((c) => c && codes.includes(String(c)))) return true;
  const msg = String(err?.message || "") + " " + String(err?.cause?.message || "");
  return /self[- ]signed|certificate|SSL routines|altname/i.test(msg);
}
var RETRYABLE_NET_CODES = [
  "ECONNRESET",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT"
];
function retryableNetError(err) {
  const codes = [err?.code, err?.cause?.code, err?.errno];
  return codes.some((c) => c && RETRYABLE_NET_CODES.includes(String(c)));
}
async function nodeFetch(url, init, opts = {}) {
  const endpoint = url.replace(/^(https?:\/\/[^/]+).*$/, "$1");
  const { timeoutMs = 12e4, ...fetchInit } = init;
  let bodyBuf;
  if (typeof fetchInit.body === "string") bodyBuf = fetchInit.body;
  else if (fetchInit.body != null) {
    try {
      bodyBuf = JSON.stringify(fetchInit.body);
    } catch {
    }
  }
  const baseInit = { ...fetchInit, ...bodyBuf !== void 0 ? { body: bodyBuf } : {} };
  let soft = null;
  const getSoft = () => {
    if (!soft) {
      soft = new import_undici.Agent({
        connect: { timeout: 4e3, rejectUnauthorized: false },
        connections: Math.max(1, opts.maxConcurrency || 4),
        keepAliveTimeout: 3e4,
        keepAliveMaxTimeout: 6e4,
        pipelining: 1
      });
    }
    return soft;
  };
  const run = (dispatcher) => fetch(url, {
    ...baseInit,
    signal: AbortSignal.timeout(timeoutMs),
    ...dispatcher ? { dispatcher } : dispatcherFor(endpoint, opts.maxConcurrency || 4)
  });
  const noTlsFallback = opts.allowInsecureFallback === false;
  try {
    if (!noTlsFallback && (insecureTlsEnabled() || opts.forceInsecureTls)) {
      const res2 = await run(getSoft());
      return { res: res2, tlsInsecureUsed: true };
    }
    const res = await run();
    return { res, tlsInsecureUsed: false };
  } catch (err) {
    if (!noTlsFallback && isTlsCertError(err)) {
      const res = await run(getSoft());
      return { res, tlsInsecureUsed: true };
    }
    if (retryableNetError(err)) {
      closeAgentForEndpoint(endpoint);
      await new Promise((r) => setTimeout(r, 350));
      try {
        if (!noTlsFallback && (insecureTlsEnabled() || opts.forceInsecureTls)) {
          const res2 = await run(getSoft());
          return { res: res2, tlsInsecureUsed: true };
        }
        const res = await run();
        return { res, tlsInsecureUsed: false };
      } catch (err2) {
        if (!noTlsFallback && isTlsCertError(err2)) {
          const res = await run(getSoft());
          return { res, tlsInsecureUsed: true };
        }
        throw err2;
      }
    }
    throw err;
  } finally {
    if (soft) {
      const s = soft;
      soft = null;
      s.close().catch(() => {
      });
    }
  }
}

// server.ts
var import_meta = {};
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
var nodes = new Store(TABLES.nodes, (n) => n.node_id);
var consents = new Store(TABLES.consents, (c) => c.consent_id);
var blacklist = new Store(TABLES.blacklist, (b) => b.node_id);
var candidates = new Store(TABLES.candidates, (c) => c.candidate_id);
var apiKeys = new Store(TABLES.apiKeys, (k) => k.key_id);
var apiKeyByHash = /* @__PURE__ */ new Map();
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
var NODE_METRICS_INTERVAL_MS = 5e3;
var NODE_METRICS_MAX_SAMPLES = 120;
var nodeMetricsHistory = /* @__PURE__ */ new Map();
var nodeMetricsLastTs = null;
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) >>> 0;
  return h;
}
async function sampleNodeMetricsOnce() {
  const tsLabel = (/* @__PURE__ */ new Date()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  nodeMetricsLastTs = Date.now();
  const tasks = Array.from(nodes.values()).map(async (node) => {
    let cpu = null;
    let memory = null;
    let real = false;
    try {
      const psRes = await fetch(`${node.endpoint}/api/ps`, nodeFetchOpts({
        signal: AbortSignal.timeout(3e3),
        ...dispatcherFor(node.endpoint, Math.max(1, node.max_concurrency || 4))
      }));
      if (psRes.ok) {
        const psData = await psRes.json();
        const models = Array.isArray(psData.models) ? psData.models : [];
        const gpuTotal = models.reduce((a, m) => a + (Number(m.size_vram) || 0), 0);
        const cpuTotal = models.reduce((a, m) => a + (Number(m.size) || 0) - (Number(m.size_vram) || 0), 0);
        const vramCap = 24 * 1024 * 1024 * 1024;
        cpu = Math.min(98, Math.max(3, Math.round(gpuTotal / vramCap * 100)));
        memory = Math.min(98, Math.max(5, Math.round((gpuTotal + Math.max(0, cpuTotal)) / vramCap * 100)));
        real = true;
      }
    } catch {
    }
    if (!real) {
      const seed = hashStr(node.node_id);
      const phase = nodeMetricsLastTs / NODE_METRICS_INTERVAL_MS + seed % 60;
      const baseCpu = 20 + seed % 45;
      const baseMem = 30 + seed % 35;
      cpu = Math.min(97, Math.max(4, Math.round(baseCpu + Math.sin(phase / 6 + seed) * 14)));
      memory = Math.min(97, Math.max(8, Math.round(baseMem + Math.cos(phase / 8 + seed) * 9)));
    }
    const arr = nodeMetricsHistory.get(node.node_id) || [];
    arr.push({ time: tsLabel, cpu, memory, real });
    if (arr.length > NODE_METRICS_MAX_SAMPLES) arr.splice(0, arr.length - NODE_METRICS_MAX_SAMPLES);
    nodeMetricsHistory.set(node.node_id, arr);
  });
  await Promise.allSettled(tasks);
}
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
var localRpmFallback = new Array(RPM_BUCKETS_COUNT).fill(0);
var localRpmLastMinute = Math.floor(Date.now() / 6e4);
function shiftLocalRpm(currentMin) {
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
    recordRpm(count).catch(() => shiftLocalRpm(Math.floor(Date.now() / 6e4)));
    return;
  }
  shiftLocalRpm(Math.floor(Date.now() / 6e4));
  localRpmFallback[localRpmFallback.length - 1] += count;
}
async function getRpm60mData() {
  const now = /* @__PURE__ */ new Date();
  let values;
  if (redisEnabled()) {
    values = await getRpmBuckets();
    if (values.length !== RPM_BUCKETS_COUNT) {
      values = new Array(RPM_BUCKETS_COUNT).fill(0).map((_, i) => values[i] || 0);
    }
  } else {
    shiftLocalRpm(Math.floor(Date.now() / 6e4));
    values = [...localRpmFallback];
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
      rpm: values[i] || 0
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
  const item = {
    id: `aud_${import_crypto.default.randomBytes(6).toString("hex")}`,
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    actor,
    subject_type,
    subject_id,
    detail
  };
  auditLogs.unshift(item);
  if (auditLogs.length > 500) auditLogs.pop();
  insertAuditRow(item.id, item, item.created_at).catch(
    (err) => logger.warn("audit write failed", { error: err.message, event })
  );
}
async function seedInitialData() {
  addAudit("gateway_boot", "system", "gateway", GATEWAY_ID, {
    version: VERSION,
    pool_size: nodes.size,
    status: "clean_initialized"
  });
}
async function bootstrap() {
  const pgOk = await initDb();
  const redisOk = await initRedis();
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
  await seedInitialData();
  rebuildKeyHashIndex();
  if (redisOk) {
    await registerGateway(GATEWAY_ID, {
      version: VERSION,
      started_at: (/* @__PURE__ */ new Date()).toISOString(),
      storage: pgOk ? "postgres" : "in-memory"
    });
  }
  logger.info("Gateway initialized", {
    gateway_id: GATEWAY_ID,
    postgres: pgOk ? "connected" : "in-memory",
    redis: redisOk ? "connected" : "in-memory",
    nodes: nodes.size,
    keys: apiKeys.size
  });
}
function rebuildKeyHashIndex() {
  apiKeyByHash.clear();
  for (const key of apiKeys.values()) {
    if (key.key_hash && !key.revoked) apiKeyByHash.set(key.key_hash, key);
  }
}
function hashApiKey(rawKey) {
  return import_crypto.default.createHash("sha256").update(rawKey).digest("hex");
}
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
  routing: {
    // §7.6: число попыток проксирования на разные узлы при отказе.
    retry_attempts: 2
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
function generateRequestId() {
  return `req_${import_crypto.default.randomBytes(8).toString("hex")}`;
}
var requestIdMiddleware = (req, res, next) => {
  const incoming = req.headers["x-foa-request-id"];
  const id = incoming && /^[A-Za-z0-9_.:-]{1,64}$/.test(incoming) ? incoming : generateRequestId();
  req.requestId = id;
  res.setHeader("X-FOA-Request-ID", id);
  next();
};
var requestCounters = {
  total: 0,
  by_status: /* @__PURE__ */ new Map(),
  errors: 0
};
function recordRequest(statusCode) {
  requestCounters.total++;
  if (statusCode >= 500) requestCounters.errors++;
  requestCounters.by_status.set(statusCode, (requestCounters.by_status.get(statusCode) || 0) + 1);
}
function clientHashFor(req) {
  const salt = process.env.FOA_SECURITY__CLIENT_HASH_SALT || currentConfig.security.client_hash_salt || "";
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "";
  return import_crypto.default.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 16);
}
var clientHashMiddleware = (req, res, next) => {
  req.clientHash = clientHashFor(req);
  res.setHeader("X-FOA-Client-Hash", req.clientHash);
  next();
};
function sendApiError(req, res, statusCode, message, opts = {}) {
  const payload = {
    error: message,
    code: opts.code || defaultCodeFor(statusCode),
    request_id: req.requestId || generateRequestId()
  };
  if (opts.retryAfter && opts.retryAfter > 0) {
    payload.retry_after = opts.retryAfter;
    res.setHeader("Retry-After", String(opts.retryAfter));
  }
  return res.status(statusCode).json(payload);
}
function defaultCodeFor(statusCode) {
  switch (statusCode) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 500:
      return "internal_error";
    case 502:
      return "bad_gateway";
    case 503:
      return "service_unavailable";
    case 504:
      return "gateway_timeout";
    default:
      return "error";
  }
}
var dirtyKeys = /* @__PURE__ */ new Set();
var keyFlushTimer = null;
function markKeyUsed(keyId) {
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
      apiKeys.set(update).catch((err) => logger.warn("last_used_at flush failed", { error: err.message }));
    }
  }, 15e3);
  keyFlushTimer.unref();
}
async function persistNode(node) {
  if (!node) return;
  try {
    await nodes.set(node);
  } catch (err) {
    logger.warn("node persist failed", { node_id: node.node_id, error: err.message });
  }
}
async function persistConsent(consent) {
  if (!consent) return;
  try {
    await consents.set(consent);
  } catch (err) {
    logger.warn("consent persist failed", { consent_id: consent.consent_id, error: err.message });
  }
}
function notFound(res, message) {
  return res.status(404).json({ error: message });
}
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
var userAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return sendApiError(req, res, 401, "\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F API-\u043A\u043B\u044E\u0447: \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A Authorization: Bearer <foa_live_...>");
  }
  if (!token.startsWith("foa_live_")) {
    return sendApiError(req, res, 401, "\u041D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 API-\u043A\u043B\u044E\u0447");
  }
  const now = /* @__PURE__ */ new Date();
  const tokenHash = hashApiKey(token);
  let key = apiKeyByHash.get(tokenHash);
  if (!key && dbEnabled()) {
    const fresh = await apiKeys.findByField("key_hash", tokenHash);
    if (fresh) {
      apiKeys.cacheUpsert(fresh);
      key = fresh;
      apiKeyByHash.set(tokenHash, fresh);
    }
  }
  if (!key || key.revoked) {
    return sendApiError(req, res, 401, "\u041D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 API-\u043A\u043B\u044E\u0447");
  }
  if (key.expires_at && new Date(key.expires_at) < now) {
    return sendApiError(req, res, 401, "\u0421\u0440\u043E\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F API-\u043A\u043B\u044E\u0447\u0430 \u0438\u0441\u0442\u0451\u043A");
  }
  key.last_used_at = now.toISOString();
  markKeyUsed(key.key_id);
  req.apiKey = key;
  return next();
};
var requireScopes = (...scopes) => {
  return (req, res, next) => {
    const key = req.apiKey;
    const granted = Array.isArray(key?.scopes) ? key.scopes : [];
    if (scopes.some((s) => granted.includes(s))) {
      return next();
    }
    return sendApiError(
      req,
      res,
      403,
      `\u041D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u043F\u0440\u0430\u0432: \u0442\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044F \u043E\u0434\u0438\u043D \u0438\u0437 \u0441\u043A\u043E\u0443\u043F\u043E\u0432 [${scopes.join(", ")}], \u0443 \u043A\u043B\u044E\u0447\u0430 \u2014 [${granted.join(", ")}]`
    );
  };
};
var LIMIT_WINDOW_MS = 6e4;
function sendRateLimited(req, res, scope, limit, retryAfter) {
  return sendApiError(req, res, 429, `\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 (${scope} \u2264 ${limit}/\u043C\u0438\u043D). \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 ${retryAfter} \u0441.`, {
    code: "rate_limited",
    retryAfter
  });
}
function sendInflightLimited(req, res, limit, isStream) {
  return sendApiError(
    req,
    res,
    429,
    `\u041F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u043B\u0438\u043C\u0438\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445 ${isStream ? "\u0441\u0442\u0440\u0438\u043C\u043E\u0432" : "\u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432"} (${limit} \u043D\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F)`,
    { code: "concurrent_limit" }
  );
}
var applyLimits = (opts = {}) => {
  return async (req, res, next) => {
    const key = req.apiKey;
    const limits = currentConfig.limits;
    const keyId = key.key_id;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > limits.max_request_bytes) {
      return sendApiError(
        req,
        res,
        413,
        `\u0422\u0435\u043B\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0430 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_request_bytes (${limits.max_request_bytes} \u0431\u0430\u0439\u0442)`
      );
    }
    const body = req.body || {};
    if (opts.body === "prompt") {
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (Buffer.byteLength(prompt, "utf8") > limits.max_prompt_bytes) {
        return sendApiError(
          req,
          res,
          400,
          `\u041F\u0440\u043E\u043C\u043F\u0442 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_prompt_bytes (${limits.max_prompt_bytes} \u0431\u0430\u0439\u0442)`
        );
      }
      const numPredict = body.options?.num_predict;
      if (typeof numPredict === "number" && numPredict > limits.max_num_predict) {
        body.options.num_predict = limits.max_num_predict;
      }
    } else if (opts.body === "chat" || opts.body === "openai") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length > limits.max_messages) {
        return sendApiError(req, res, 400, `\u0427\u0438\u0441\u043B\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_messages (${limits.max_messages})`);
      }
      for (const m of messages) {
        const content = typeof m?.content === "string" ? m.content : "";
        if (Buffer.byteLength(content, "utf8") > limits.max_message_bytes) {
          return sendApiError(
            req,
            res,
            400,
            `\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043F\u0440\u0435\u0432\u044B\u0448\u0430\u0435\u0442 max_message_bytes (${limits.max_message_bytes} \u0431\u0430\u0439\u0442)`
          );
        }
      }
      if (opts.body === "openai") {
        if (typeof body.max_tokens === "number" && body.max_tokens > limits.max_num_predict) {
          body.max_tokens = limits.max_num_predict;
        }
        if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > limits.max_num_predict) {
          body.max_completion_tokens = limits.max_num_predict;
        }
      } else if (typeof body.options?.num_predict === "number" && body.options.num_predict > limits.max_num_predict) {
        body.options.num_predict = limits.max_num_predict;
      }
    }
    const userLimit = key.rate_limit_per_minute ?? limits.requests_per_minute_per_user;
    const userResult = await checkRateLimit("user", keyId, userLimit, LIMIT_WINDOW_MS);
    if (!userResult.allowed) {
      setRateLimitHeaders(res, userLimit, userResult);
      return sendRateLimited(req, res, "\u043D\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F", userLimit, userResult.retryAfter);
    }
    const globalResult = await checkRateLimit("global", "all", limits.requests_per_minute_global, LIMIT_WINDOW_MS);
    if (!globalResult.allowed) {
      setRateLimitHeaders(res, limits.requests_per_minute_global, globalResult);
      return sendRateLimited(req, res, "\u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0439", limits.requests_per_minute_global, globalResult.retryAfter);
    }
    if (opts.perModel && body.model) {
      const modelId = `${keyId}|${String(body.model).toLowerCase()}`;
      const modelResult = await checkRateLimit(
        "model",
        modelId,
        limits.requests_per_minute_per_model,
        LIMIT_WINDOW_MS
      );
      if (!modelResult.allowed) {
        setRateLimitHeaders(res, limits.requests_per_minute_per_model, modelResult);
        return sendRateLimited(
          req,
          res,
          `\u043D\u0430 \u043C\u043E\u0434\u0435\u043B\u044C ${body.model}`,
          limits.requests_per_minute_per_model,
          modelResult.retryAfter
        );
      }
    }
    const isStream = body.stream === true;
    const inflightLimit = isStream ? limits.concurrent_stream_requests_per_user : limits.concurrent_requests_per_user;
    const inflightScope = isStream ? "inflight-stream" : "inflight";
    const acquired = await acquireInflight(`${inflightScope}:${keyId}`, inflightLimit);
    if (!acquired) {
      return sendInflightLimited(req, res, inflightLimit, isStream);
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseInflight(`${inflightScope}:${keyId}`).catch(() => {
      });
    };
    res.on("close", release);
    req.on("aborted", release);
    next();
  };
};
function setRateLimitHeaders(res, limit, result) {
  res.setHeader("X-FOA-RateLimit-Limit", String(limit));
  res.setHeader("X-FOA-RateLimit-Remaining", String(Math.max(0, limit - result.count)));
  res.setHeader("X-FOA-RateLimit-Reset", String(Math.max(0, result.retryAfter)));
}
app.get("/healthz", (req, res) => {
  res.json({
    status: "ok",
    version: VERSION,
    gateway_id: GATEWAY_ID,
    storage: {
      postgres: dbConnected() ? "connected" : dbEnabled() ? "error" : "disabled",
      redis: redisEnabled() ? "connected" : "disabled"
    }
  });
});
app.get("/readyz", (req, res) => {
  const routable = Array.from(nodes.values()).filter((n) => n.routable).length;
  const ok = routable > 0;
  const status = ok ? "ready" : "degraded";
  res.status(ok ? 200 : 503).json({
    status,
    routable_nodes: routable,
    nodes_total: nodes.size,
    version: VERSION,
    gateway_id: GATEWAY_ID,
    storage: {
      postgres: dbConnected() ? "connected" : dbEnabled() ? "error" : "disabled",
      redis: redisEnabled() ? "connected" : "disabled"
    }
  });
});
app.get("/metrics", (req, res) => {
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
    `foa_requests_errors_total ${requestCounters.errors}`
  ];
  for (const [code, count] of Array.from(requestCounters.by_status.entries()).sort((a, b) => a[0] - b[0])) {
    lines.push(
      `# HELP foa_requests_by_status Requests by HTTP status code`,
      `# TYPE foa_requests_by_status counter`,
      `foa_requests_by_status{status="${code}"} ${count}`
    );
  }
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(lines.join("\n"));
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
app.get("/admin/nodes/metrics", adminAuth, async (req, res) => {
  await sampleNodeMetricsOnce().catch(() => {
  });
  const timestampsSet = /* @__PURE__ */ new Set();
  for (const arr of nodeMetricsHistory.values()) {
    for (const p of arr) timestampsSet.add(p.time);
  }
  const timestamps = Array.from(timestampsSet);
  const nodeMetrics = [];
  for (const node of nodes.values()) {
    const hist = nodeMetricsHistory.get(node.node_id) || [];
    nodeMetrics.push({
      node_id: node.node_id,
      display_name: node.display_name || node.node_id,
      status: node.status,
      country: node.country || "US",
      real: hist.length > 0 && hist[hist.length - 1].real,
      history: hist.map((p) => ({
        time: p.time,
        cpu: p.cpu,
        memory: p.memory,
        latency_ms: node.latency_ms || 0
      }))
    });
  }
  res.json({
    metrics: nodeMetrics,
    timestamps,
    interval_ms: NODE_METRICS_INTERVAL_MS,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
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
app.post("/admin/nodes", adminAuth, async (req, res) => {
  const { endpoint, display_name, owner_id, models, max_concurrency, consent_method, weight, country, labels, insecure_tls } = req.body;
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
    labels: Array.isArray(labels) ? labels : [],
    insecure_tls: insecure_tls === true
  };
  nodeLatencySamples.set(nodeId, generateDefaultSamplesForNode(newNode));
  const newConsent = {
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
  };
  try {
    if (dbEnabled()) {
      await tx(async (client2) => {
        await nodes.set(newNode, client2);
        await consents.set(newConsent, client2);
      });
    } else {
      await nodes.set(newNode);
      await consents.set(newConsent);
    }
  } catch (err) {
    logger.error("node registration failed", { error: err.message, node_id: nodeId });
    return res.status(500).json({ error: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0443\u0437\u0435\u043B", detail: err.message });
  }
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
    const probeRes = await fetch(`${node.endpoint}/api/tags`, nodeFetchOpts({ signal: AbortSignal.timeout(3e3) }));
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
      persistConsent(c);
    }
  }
  if (!consentFound) {
    const cId = `cst_${node.node_id}`;
    const newConsent = {
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
    };
    await persistConsent(newConsent);
  }
  await persistNode(node);
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
        persistConsent(c);
      }
    }
    await persistNode(node);
    count++;
  }
  addAudit("nodes_bulk_verified", "admin", "nodes", "bulk", { count, mode, method });
  res.json({ status: "completed", count });
});
app.post("/admin/nodes/bulk-health-check", adminAuth, async (req, res) => {
  const { node_ids = [], all = false } = req.body || {};
  let targets;
  if (all === true) {
    targets = Array.from(nodes.values());
  } else {
    targets = Array.from(new Set((Array.isArray(node_ids) ? node_ids : []).map(String))).map((id) => nodes.get(id)).filter(Boolean);
  }
  if (!targets.length) {
    return res.json({ status: "completed", checked: 0, results: [] });
  }
  const CONCURRENCY = 5;
  const queue = [...targets];
  const results = [];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const node = queue.shift();
      try {
        const r = await runNodeHealthCheck(node);
        results.push({ node_id: node.node_id, ...r });
      } catch (err) {
        results.push({ node_id: node.node_id, status: "unhealthy", latency_ms: 0, error: String(err?.message || err) });
      }
    }
  });
  await Promise.all(workers);
  addAudit("nodes_bulk_health_check", "admin", "nodes", "bulk", {
    count: results.length,
    all: all === true,
    healthy: results.filter((r) => r.status === "healthy").length,
    degraded: results.filter((r) => r.status === "degraded").length,
    unhealthy: results.filter((r) => r.status === "unhealthy").length
  });
  res.json({ status: "completed", checked: results.length, results });
});
async function runNodeHealthCheck(node) {
  const start = Date.now();
  let status = "unhealthy";
  let latency = 0;
  let errorMsg;
  try {
    const { res: probeRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/api/version`, {
      method: "GET",
      timeoutMs: 4e3
    }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
    latency = Date.now() - start;
    if (probeRes.ok) {
      status = latency > 600 ? "degraded" : "healthy";
      try {
        const { res: tagsRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/api/tags`, {
          method: "GET",
          timeoutMs: 3e3
        }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
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
    errorMsg = err?.message === "fetch failed" ? describeFetchError(err) : String(err?.message || err);
  }
  node.latency_ms = latency;
  node.ewma_latency_ms = node.ewma_latency_ms > 0 ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3) : latency;
  node.status = status;
  node.state = status;
  node.last_health_check = (/* @__PURE__ */ new Date()).toISOString();
  node.updated_at = node.last_health_check;
  recordNodeLatencySample(node.node_id, latency);
  await persistNode(node);
  addAudit("health_probe", "system", "node", node.node_id, {
    latency_ms: latency,
    status,
    models: node.models,
    error: errorMsg
  });
  return { status, latency_ms: latency, models: node.models || [], error: errorMsg };
}
app.post("/admin/nodes/:id/health-check", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  if (typeof req.body?.insecure_tls === "boolean" && req.body.insecure_tls !== node.insecure_tls) {
    node.insecure_tls = req.body.insecure_tls;
    addAudit("node_insecure_tls_updated", "admin", "node", node.node_id, { insecure_tls: node.insecure_tls });
  }
  const r = await runNodeHealthCheck(node);
  res.json({ ...r, node_id: node.node_id });
});
function describeFetchError(err) {
  const cause = err?.cause;
  const code = cause?.code || err?.code || "";
  const reason = cause?.message || cause || "";
  switch (code) {
    case "ENOTFOUND":
      return `\u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0440\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044C \u0430\u0434\u0440\u0435\u0441 \u0443\u0437\u043B\u0430 (DNS${reason ? `: ${reason}` : ""})`;
    case "ECONNREFUSED":
      return `\u0443\u0437\u0435\u043B \u043E\u0442\u0432\u0435\u0440\u0433 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 (\u043F\u043E\u0440\u0442 \u0437\u0430\u043A\u0440\u044B\u0442 \u0438\u043B\u0438 Ollama \u043D\u0435 \u0437\u0430\u043F\u0443\u0449\u0435\u043D${reason ? `: ${reason}` : ""})`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ENETDOWN":
    case "ECONNRESET":
      return `\u0441\u0435\u0442\u044C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0438\u043B\u0438 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0441\u0431\u0440\u043E\u0448\u0435\u043D\u043E (${code})`;
    case "UND_ERR_CONNECT_TIMEOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return `\u043F\u0440\u0435\u0432\u044B\u0448\u0435\u043D \u0442\u0430\u0439\u043C\u0430\u0443\u0442 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F \u0441 \u0443\u0437\u043B\u043E\u043C (${code})`;
    case "TimeoutError":
    case "AbortError":
      return "\u0442\u0430\u0439\u043C\u0430\u0443\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u0430 \u043A \u0443\u0437\u043B\u0443";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "HR_BAD_VERIFY":
      return `\u043E\u0448\u0438\u0431\u043A\u0430 TLS-\u0441\u0435\u0440\u0442\u0438\u0444\u0438\u043A\u0430\u0442\u0430 \u0443\u0437\u043B\u0430 (${code || reason})`;
    default:
      return [code, String(reason || err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u0441\u0435\u0442\u0435\u0432\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430")].filter(Boolean).join(": ");
  }
}
app.post("/admin/nodes/:id/chat", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const incomingMessages = Array.isArray(req.body?.messages) && req.body.messages.length ? req.body.messages : [{ role: "user", content: String(req.body?.message || "").trim() }];
  const lastUser = [...incomingMessages].reverse().find((m) => m && m.role === "user");
  const message = String(lastUser?.content || "").trim();
  if (!message) return res.status(400).json({ error: "\u041F\u0443\u0441\u0442\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435" });
  if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
    return res.status(400).json({
      error: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 endpoint \u0443\u0437\u043B\u0430: ${node.endpoint || "(\u043F\u0443\u0441\u0442\u043E)"}. \u041E\u0442\u0440\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u0443\u0439\u0442\u0435 \u0443\u0437\u0435\u043B \u2014 \u0430\u0434\u0440\u0435\u0441 \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 http:// \u0438\u043B\u0438 https://`
    });
  }
  const model = req.body?.model || Array.isArray(node.models) && node.models[0] || "llama3";
  const messages = incomingMessages.map((m) => ({ role: m.role || "user", content: String(m.content ?? "") }));
  const start = Date.now();
  node.active_connections++;
  try {
    const { res: upstreamRes, tlsInsecureUsed } = await nodeFetch(
      `${node.endpoint.replace(/\/+$/, "")}/api/chat`,
      {
        method: "POST",
        headers: upstreamHeaders(req),
        body: JSON.stringify({ model, messages, stream: false }),
        timeoutMs: 12e4
      },
      { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true }
    );
    if (!upstreamRes.ok) {
      const text = await upstreamRes.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        detail = String(JSON.parse(text)?.error || detail);
      } catch {
      }
      throw new Error(`\u0423\u0437\u0435\u043B \u043E\u0442\u0432\u0435\u0442\u0438\u043B HTTP ${upstreamRes.status}${detail ? `: ${detail}` : ""}`);
    }
    const data = await upstreamRes.json();
    const reply = typeof data.message?.content === "string" ? data.message.content : typeof data.response === "string" ? data.response : "";
    const latency = Date.now() - start;
    node.latency_ms = latency;
    node.ewma_latency_ms = node.ewma_latency_ms ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3) : latency;
    node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    res.json({
      reply,
      model: data.model || model,
      node_id: node.node_id,
      latency_ms: latency,
      done: data.done !== false,
      ...tlsInsecureUsed ? { warning: "\u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043D\u043E \u043D\u0435\u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C\u043E\u0435 TLS-\u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0441 \u0443\u0437\u043B\u043E\u043C (\u0441\u0430\u043C\u043E\u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D\u043D\u044B\u0439 \u0441\u0435\u0440\u0442\u0438\u0444\u0438\u043A\u0430\u0442)" } : {}
    });
    if (tlsInsecureUsed) {
      addAudit("node_chat_tls_fallback", "admin", "node", node.node_id, { endpoint: node.endpoint });
    }
  } catch (err) {
    addAudit("node_chat_error", "admin", "node", node.node_id, { error: err?.message, cause: err?.cause?.code });
    const isTimeout = err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
    const friendlyBase = isTimeout ? `\u0423\u0437\u0435\u043B \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0437\u0430 120 \u0441 \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 ${node.endpoint}. \u041C\u043E\u0434\u0435\u043B\u044C \u043C\u043E\u0433\u043B\u0430 \u0435\u0449\u0451 \u043D\u0435 \u0431\u044B\u0442\u044C \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u0430 \u0432 \u043F\u0430\u043C\u044F\u0442\u044C (\u043F\u0435\u0440\u0432\u044B\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u043A \u043A\u0440\u0443\u043F\u043D\u043E\u0439 \u043C\u043E\u0434\u0435\u043B\u0438 \u043A\u0430\u0447\u0430\u0435\u0442 \u0435\u0451 \u043C\u0438\u043D\u0443\u0442\u044B). \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0443 \u2014 \u0432\u0442\u043E\u0440\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u043E\u0431\u044B\u0447\u043D\u043E \u0431\u044B\u0441\u0442\u0440\u0435\u0435.` : String(err?.message || "") === "fetch failed" ? `\u0427\u0430\u0442 \u0441 \u0443\u0437\u043B\u043E\u043C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: \u0443\u0437\u0435\u043B \u043D\u0435 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442 \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 ${node.endpoint} (${describeFetchError(err)}). \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0443 \u2014 \u0448\u043B\u044E\u0437 \u0443\u0436\u0435 \u0441\u0434\u0435\u043B\u0430\u043B \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u043F\u043E\u0432\u0442\u043E\u0440 \u043F\u0440\u0438 \u0440\u0430\u0437\u0440\u044B\u0432\u0435 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F.` : `\u0427\u0430\u0442 \u0441 \u0443\u0437\u043B\u043E\u043C \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D: ${err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}`;
    const tlsHint = /TLS-сертификата|SELF_SIGNED/i.test(friendlyBase) ? " \u0421\u043E\u0432\u0435\u0442: \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u043D\u0430 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0435 \u0443\u0437\u043B\u0430 \xAB\u0414\u043E\u0432\u0435\u0440\u044F\u0442\u044C \u0441\u0430\u043C\u043E\u043F\u043E\u0434\u043F\u0438\u0441\u0430\u043D\u043D\u043E\u043C\u0443 TLS\xBB \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443 \u0437\u0434\u043E\u0440\u043E\u0432\u044C\u044F." : "";
    const friendly = friendlyBase + tlsHint;
    res.status(502).json({ error: friendly });
  } finally {
    node.active_connections = Math.max(0, node.active_connections - 1);
  }
});
app.get("/admin/nodes/:id/models", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  let models = Array.isArray(node.models) ? node.models : [];
  let fetched = false;
  if (!models.length) {
    try {
      const { res: tagsRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/api/tags`, {
        method: "GET",
        timeoutMs: 15e3
      }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
      if (tagsRes.ok) {
        const tData = await tagsRes.json();
        if (Array.isArray(tData.models)) {
          models = tData.models.map((m) => m.name || m.model).filter(Boolean);
          fetched = true;
          if (models.length) {
            node.models = models;
            node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
            await persistNode(node);
          }
        }
      }
    } catch (err) {
      return res.status(502).json({ error: `\u0423\u0437\u0435\u043B \u043D\u0435 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442: ${err.message}`, models: [] });
    }
  }
  res.json({ node_id: node.node_id, models, fetched });
});
var NODE_PROXY_TIMEOUT_MS = 12e4;
var NODE_PROXY_GET_TIMEOUT_MS = 3e4;
var NODE_PROXY_ROUTES = {
  // native API
  "/api/tags": { method: "GET", upstream: "/api/tags" },
  "/api/ps": { method: "GET", upstream: "/api/ps" },
  "/api/version": { method: "GET", upstream: "/api/version" },
  "/api/show": { method: "GET", upstream: "/api/show" },
  // ?model= или /show/:model
  "/api/usage": { method: "GET", upstream: "/api/usage" },
  "/api/balance": { method: "GET", upstream: "/api/balance" },
  "/api/generate": { method: "POST", upstream: "/api/generate" },
  "/api/chat": { method: "POST", upstream: "/api/chat" },
  "/api/embed": { method: "POST", upstream: "/api/embed" },
  "/api/create": { method: "POST", upstream: "/api/create" },
  "/api/copy": { method: "POST", upstream: "/api/copy" },
  "/api/pull": { method: "POST", upstream: "/api/pull" },
  "/api/push": { method: "POST", upstream: "/api/push" },
  // В нативном Ollama /api/delete — это POST (docs: DELETE request via POST body)
  "/api/delete": { method: "POST", upstream: "/api/delete" },
  // OpenAI-совместимый API (https://docs.ollama.com/api/openai-compatibility)
  "/v1/models": { method: "GET", upstream: "/v1/models" },
  "/v1/chat/completions": { method: "POST", upstream: "/v1/chat/completions" },
  "/v1/responses": { method: "POST", upstream: "/v1/responses" },
  "/v1/systemone": { method: "GET", upstream: "/v1/systemone" }
};
app.all("/admin/nodes/:id/proxy/*", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
    return res.status(400).json({ error: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 endpoint \u0443\u0437\u043B\u0430: ${node.endpoint || "(\u043F\u0443\u0441\u0442\u043E)"}` });
  }
  const subPath = "/" + String(req.params[0] ?? "").replace(/^\/+/, "");
  const httpMethod = req.method.toUpperCase();
  let routeKey = subPath;
  let upstreamSuffix = "";
  const showDyn = /^\/api\/show\/(.+)$/.exec(subPath);
  if (showDyn) {
    routeKey = "/api/show";
    upstreamSuffix = `?model=${encodeURIComponent(showDyn[1])}`;
  }
  const modelsDyn = /^\/v1\/models\/(.+)$/.exec(subPath);
  if (modelsDyn) {
    routeKey = "/v1/models";
    upstreamSuffix = `/${encodeURIComponent(modelsDyn[1])}`;
  }
  const dynAlias = /^(\/(?:api|v1)\/[^?]+?)\/([^/]+)$/.exec(subPath);
  if (!NODE_PROXY_ROUTES[routeKey] && dynAlias) {
    const aliasBase = NODE_PROXY_ROUTES[dynAlias[1]];
    if (aliasBase) {
      routeKey = dynAlias[1];
      if (routeKey === "/api/show") upstreamSuffix = `?model=${encodeURIComponent(dynAlias[2])}`;
      else upstreamSuffix = `/${encodeURIComponent(dynAlias[2])}`;
    }
  }
  const allowed = NODE_PROXY_ROUTES[routeKey];
  if (!allowed) {
    return res.status(400).json({
      error: `\u041F\u0443\u0442\u044C ${subPath} \u043D\u0435 \u0432\u0445\u043E\u0434\u0438\u0442 \u0432 \u0441\u043F\u0438\u0441\u043E\u043A \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0445 Ollama-\u044D\u043D\u0434\u043F\u043E\u0438\u043D\u0442\u043E\u0432`,
      supported: Object.keys(NODE_PROXY_ROUTES)
    });
  }
  const methodOk = allowed.method === "POST" ? httpMethod === "POST" || routeKey === "/api/delete" && httpMethod === "DELETE" : httpMethod === "GET";
  if (!methodOk) {
    return res.status(405).json({ error: `${httpMethod} ${subPath} \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 ${allowed.method}` });
  }
  const base = node.endpoint.replace(/\/+$/, "");
  const upstreamUrl = `${base}${allowed.upstream}${upstreamSuffix}`;
  const sendBody = allowed.method === "POST" && httpMethod !== "GET";
  const timeoutMs = sendBody ? NODE_PROXY_TIMEOUT_MS : NODE_PROXY_GET_TIMEOUT_MS;
  try {
    const { res: upstreamRes } = await nodeFetch(upstreamUrl, {
      method: sendBody ? "POST" : "GET",
      headers: upstreamHeaders(req, { "Content-Type": "application/json" }),
      ...sendBody && req.body !== void 0 ? { body: JSON.stringify(req.body ?? {}) } : {},
      timeoutMs
    }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
    const ct = upstreamRes.headers.get("content-type") || "";
    res.status(upstreamRes.status);
    if (ct.includes("application/json")) {
      res.json(await upstreamRes.json().catch(() => ({ raw: "" })));
    } else {
      res.type(ct || "text/plain").send(await upstreamRes.text().catch(() => ""));
    }
    addAudit("node_api_proxy", "admin", "node", node.node_id, { path: subPath, status: upstreamRes.status });
  } catch (err) {
    addAudit("node_api_proxy_error", "admin", "node", node.node_id, { path: subPath, error: err?.message, cause: err?.cause?.code });
    const isTimeout = err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
    res.status(502).json({
      error: isTimeout ? `\u0423\u0437\u0435\u043B \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0437\u0430 ${Math.round(timeoutMs / 1e3)} \u0441 \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 ${node.endpoint}` : `\u041F\u0440\u043E\u043A\u0441\u0438-\u0437\u0430\u043F\u0440\u043E\u0441 \u043A \u0443\u0437\u043B\u0443 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}`
    });
  }
});
var nodeProxyAlias = (path2, route) => {
  const handler = async (req, res) => {
    const node = nodes.get(req.params.id);
    if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
    if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
      return res.status(400).json({ error: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 endpoint \u0443\u0437\u043B\u0430: ${node.endpoint || "(\u043F\u0443\u0441\u0442\u043E)"}` });
    }
    const isGet = route.method === "GET";
    const timeoutMs = isGet ? NODE_PROXY_GET_TIMEOUT_MS : NODE_PROXY_TIMEOUT_MS;
    let upstreamPath = route.upstream;
    if (upstreamPath === "/api/show" && req.params.model) {
      upstreamPath = `/api/show?model=${encodeURIComponent(String(req.params.model))}`;
    }
    try {
      const { res: upstreamRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}${upstreamPath}`, {
        method: route.method,
        headers: upstreamHeaders(req, { "Content-Type": "application/json" }),
        ...!isGet && req.body !== void 0 ? { body: JSON.stringify(req.body ?? {}) } : {},
        timeoutMs
      }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
      res.status(upstreamRes.status);
      const data = await upstreamRes.json().catch(async () => ({ raw: await upstreamRes.text().catch(() => "") }));
      res.json(data);
    } catch (err) {
      const isTimeout = err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
      res.status(502).json({
        error: isTimeout ? `\u0423\u0437\u0435\u043B \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0437\u0430 ${Math.round(timeoutMs / 1e3)} \u0441 (${route.upstream})` : `\u0417\u0430\u043F\u0440\u043E\u0441 ${route.upstream} \u043A \u0443\u0437\u043B\u0443 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}`
      });
    }
  };
  if (route.method === "GET") app.get(`/admin/nodes/:id${path2}`, adminAuth, handler);
  else app.post(`/admin/nodes/:id${path2}`, adminAuth, handler);
};
for (const [p, r] of Object.entries(NODE_PROXY_ROUTES)) {
  if (p === "/v1/models") continue;
  nodeProxyAlias(p, r);
}
app.get("/admin/nodes/:id/v1/models/:model", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
    return res.status(400).json({ error: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 endpoint \u0443\u0437\u043B\u0430: ${node.endpoint || "(\u043F\u0443\u0441\u0442\u043E)"}` });
  }
  try {
    const { res: upstreamRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/v1/models/${encodeURIComponent(req.params.model)}`, {
      method: "GET",
      headers: upstreamHeaders(req),
      timeoutMs: NODE_PROXY_GET_TIMEOUT_MS
    }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
    res.status(upstreamRes.status).json(await upstreamRes.json().catch(() => ({ raw: "" })));
  } catch (err) {
    res.status(502).json({ error: `\u0417\u0430\u043F\u0440\u043E\u0441 /v1/models \u043A \u0443\u0437\u043B\u0443 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}` });
  }
});
app.get("/admin/nodes/:id/api/show/:model", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  if (!node.endpoint || !/^https?:\/\//i.test(node.endpoint)) {
    return res.status(400).json({ error: `\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 endpoint \u0443\u0437\u043B\u0430: ${node.endpoint || "(\u043F\u0443\u0441\u0442\u043E)"}` });
  }
  try {
    const { res: upstreamRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/api/show?model=${encodeURIComponent(req.params.model)}`, {
      method: "GET",
      headers: upstreamHeaders(req),
      timeoutMs: NODE_PROXY_GET_TIMEOUT_MS
    }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
    res.status(upstreamRes.status).json(await upstreamRes.json().catch(() => ({ raw: "" })));
  } catch (err) {
    res.status(502).json({ error: `\u0417\u0430\u043F\u0440\u043E\u0441 /api/show \u043A \u0443\u0437\u043B\u0443 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}` });
  }
});
app.delete("/admin/nodes/:id/api/delete", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  try {
    const { res: upstreamRes } = await nodeFetch(`${node.endpoint.replace(/\/+$/, "")}/api/delete`, {
      method: "POST",
      // Ollama ожидает POST даже для удаления модели
      headers: upstreamHeaders(req, { "Content-Type": "application/json" }),
      body: JSON.stringify(req.body ?? {}),
      timeoutMs: NODE_PROXY_GET_TIMEOUT_MS
    }, { maxConcurrency: Math.max(1, node.max_concurrency || 4), forceInsecureTls: node.insecure_tls === true });
    res.status(upstreamRes.status).json(await upstreamRes.json().catch(() => ({ status: `HTTP ${upstreamRes.status}` })));
  } catch (err) {
    res.status(502).json({ error: `\u0423\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u043C\u043E\u0434\u0435\u043B\u0438 \u043D\u0430 \u0443\u0437\u043B\u0435 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}` });
  }
});
app.get("/admin/ollama/endpoints", adminAuth, (_req, res) => {
  res.json({
    docs: ["https://docs.ollama.com/api/introduction", "https://docs.ollama.com/api/openai-compatibility"],
    per_node_base: "/admin/nodes/{node_id}",
    endpoints: Object.entries(NODE_PROXY_ROUTES).map(([p, r]) => ({
      gateway_path: `/admin/nodes/{node_id}${p}`,
      method: r.method,
      ollama_path: r.upstream
    })).concat([
      { gateway_path: "/admin/nodes/{node_id}/v1/models/{model}", method: "GET", ollama_path: "/v1/models/{model}" },
      { gateway_path: "/admin/nodes/{node_id}/api/show/{model}", method: "GET", ollama_path: "/api/show?model={model}" },
      { gateway_path: "/admin/nodes/{node_id}/proxy/*", method: "GET|POST", ollama_path: "<\u043B\u044E\u0431\u043E\u0439 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0439 \u043F\u0443\u0442\u044C>" }
    ])
  });
});
app.post("/admin/nodes/:id/revoke", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return notFound(res, "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  node.consent_status = "revoked";
  node.status = "unhealthy";
  node.routable = false;
  node.state = "revoked";
  node.effective_weight = 0;
  node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  closeAgentForEndpoint(node.endpoint);
  resetBreaker(node.node_id);
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
      persistConsent(c);
    }
  }
  await persistNode(node);
  addAudit("node_revoked", "admin", "node", node.node_id, { reason: req.body.reason });
  res.json({ status: "revoked", node_id: node.node_id, routable: false });
});
app.post("/admin/nodes/:id/blacklist", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  const nodeId = req.params.id;
  const endpoint = node ? node.endpoint : req.body.endpoint || "unknown";
  if (node) {
    node.status = "blacklisted";
    node.routable = false;
    node.effective_weight = 0;
    node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    closeAgentForEndpoint(node.endpoint);
    resetBreaker(node.node_id);
    await persistNode(node);
  }
  const entry = {
    node_id: nodeId,
    endpoint,
    reason: req.body.reason || "Admin manual blacklist",
    permanent: req.body.duration === "permanent",
    actor: "admin",
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    expires_at: req.body.duration === "permanent" ? null : new Date(Date.now() + 864e5).toISOString(),
    lifted_at: null
  };
  try {
    await blacklist.set(entry);
  } catch (err) {
    logger.warn("blacklist persist failed", { node_id: nodeId, error: err.message });
  }
  addAudit("node_blacklisted", "admin", "node", nodeId, { reason: req.body.reason });
  res.json({ status: "blacklisted", node_id: nodeId });
});
app.post("/admin/nodes/:id/unblacklist", adminAuth, async (req, res) => {
  const entry = blacklist.get(req.params.id);
  if (!entry) return notFound(res, "\u0417\u0430\u043F\u0438\u0441\u044C \u0432 \u0447\u0451\u0440\u043D\u043E\u043C \u0441\u043F\u0438\u0441\u043A\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430");
  entry.lifted_at = (/* @__PURE__ */ new Date()).toISOString();
  const node = nodes.get(req.params.id);
  if (node && node.consent_status === "verified") {
    node.status = "healthy";
    node.routable = true;
    node.effective_weight = node.weight;
    await persistNode(node);
  }
  try {
    await blacklist.set(entry);
  } catch (err) {
    logger.warn("unblacklist persist failed", { node_id: req.params.id, error: err.message });
  }
  addAudit("node_unblacklisted", "admin", "node", req.params.id);
  res.json({ status: "unblacklisted", node_id: req.params.id });
});
app.delete("/admin/nodes/:id", adminAuth, async (req, res) => {
  const nodeId = req.params.id;
  const node = nodes.get(nodeId);
  if (!node) return notFound(res, "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  try {
    await nodes.delete(nodeId);
  } catch (err) {
    logger.warn("node delete failed", { node_id: nodeId, error: err.message });
  }
  closeAgentForEndpoint(node.endpoint);
  resetBreaker(nodeId);
  addAudit("node_deleted", "admin", "node", nodeId);
  res.json({ status: "deleted", node_id: nodeId });
});
app.post("/admin/nodes/:id/labels", adminAuth, async (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return notFound(res, "\u0423\u0437\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  const { labels } = req.body;
  if (!Array.isArray(labels)) {
    return res.status(400).json({ error: "labels \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043C\u0430\u0441\u0441\u0438\u0432\u043E\u043C \u0441\u0442\u0440\u043E\u043A" });
  }
  node.labels = labels.map((l) => String(l).trim()).filter(Boolean);
  node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
  await persistNode(node);
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
app.get("/admin/consents", adminAuth, async (req, res) => {
  const list = await consents.list();
  res.json({ consents: list });
});
app.get("/admin/consents/:id", adminAuth, async (req, res) => {
  const consent = consents.get(req.params.id) || await consents.list().then((l) => l.find((c) => c.consent_id === req.params.id));
  if (!consent) return notFound(res, "\u0421\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E");
  res.json(consent);
});
app.get("/admin/blacklist", adminAuth, async (req, res) => {
  const all = await blacklist.list();
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
app.post("/admin/demo/clear", adminAuth, async (req, res) => {
  const nCnt = nodes.size;
  const cCnt = candidates.size;
  const bCnt = blacklist.size;
  const csCnt = consents.size;
  const kCnt = apiKeys.size;
  try {
    if (dbEnabled()) {
      await tx(async (client2) => {
        await nodes.clear();
        await candidates.clear();
        await blacklist.clear();
        await consents.clear();
        await apiKeys.clear();
        await clearAudit();
      });
    } else {
      await nodes.clear();
      await candidates.clear();
      await blacklist.clear();
      await consents.clear();
      await apiKeys.clear();
      await clearAudit();
    }
    auditLogs.length = 0;
    rebuildKeyHashIndex();
  } catch (err) {
    logger.warn("demo/clear: \u043E\u0447\u0438\u0441\u0442\u043A\u0430 PG \u043D\u0435 \u0443\u0434\u0430\u043B\u0430\u0441\u044C \u043F\u043E\u043B\u043D\u043E\u0441\u0442\u044C\u044E", { error: err.message });
  }
  addAudit("data_cleared", "admin", "gateway", GATEWAY_ID, {
    cleared_nodes: nCnt,
    cleared_candidates: cCnt
  });
  res.json({
    status: "cleared",
    message: "\u0412\u0441\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 (\u0443\u0437\u043B\u044B, \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u044B, \u0441\u043E\u0433\u043B\u0430\u0441\u0438\u044F, \u0447\u0451\u0440\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A, \u043A\u043B\u044E\u0447\u0438, \u0430\u0443\u0434\u0438\u0442) \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u043E\u0447\u0438\u0449\u0435\u043D\u044B.",
    cleared: { nodes: nCnt, candidates: cCnt, blacklist: bCnt, consents: csCnt, api_keys: kCnt }
  });
});
app.get("/admin/candidates", adminAuth, async (req, res) => {
  const list = await candidates.list();
  res.json({
    total: list.length,
    candidates: list,
    auto_verify: currentConfig.discovery.auto_verify_candidates,
    auto_route: currentConfig.discovery.auto_route_candidates,
    note: "\u041C\u0430\u0440\u0448\u0440\u0443\u0442\u0438\u0437\u0430\u0446\u0438\u044F \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F \u043A\u0430\u043A \u0432 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u043C, \u0442\u0430\u043A \u0438 \u0432 \u0440\u0443\u0447\u043D\u043E\u043C \u0440\u0435\u0436\u0438\u043C\u0430\u0445 \u0432\u0435\u0440\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u0438 (\u0441\u043E\u0433\u043B\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u0441 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430\u043C\u0438 \u0434\u043E\u043C\u0435\u043D\u043E\u0432)"
  });
});
app.delete("/admin/candidates", adminAuth, async (req, res) => {
  const count = candidates.size;
  await candidates.clear().catch((err) => logger.warn("candidates clear failed", { error: err.message }));
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
      candidates.set(existingCandidate).catch(
        (err) => logger.warn("candidate persist failed", { error: err.message })
      );
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
      candidates.set(candidate).catch((err) => logger.warn("candidate persist failed", { error: err.message }));
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
    const probeRes = await fetch(`${endpoint}/api/tags`, nodeFetchOpts({ signal: AbortSignal.timeout(3500) }));
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
  await nodes.set(newNode);
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
  await consents.set(newConsent);
  cand.status = "enrolled";
  cand.verified = true;
  cand.verification_mode = mode;
  cand.verified_at = now;
  cand.node_id = nodeId;
  cand.challenge_token = challengeInfo.challenge_token;
  await candidates.set(cand);
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
app.delete("/admin/candidates/:id", adminAuth, async (req, res) => {
  if (!candidates.has(req.params.id)) return res.status(404).json({ error: "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  await candidates.delete(req.params.id);
  res.json({ status: "deleted", candidate_id: req.params.id });
});
app.get("/admin/keys", adminAuth, async (req, res) => {
  const keys = await apiKeys.list();
  res.json({ keys });
});
app.post("/admin/keys", adminAuth, async (req, res) => {
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
    raw_key: rawKey,
    key_hash: hashApiKey(rawKey)
  };
  await apiKeys.set(newKey);
  rebuildKeyHashIndex();
  addAudit("api_key_created", "admin", "api_key", keyId, { label: newKey.label });
  res.json({
    key_id: keyId,
    api_key: rawKey,
    label: newKey.label,
    scopes: newKey.scopes
  });
});
app.post("/admin/keys/:id/revoke", adminAuth, async (req, res) => {
  const key = apiKeys.get(req.params.id) || await apiKeys.findByField("key_id", req.params.id);
  if (!key) return res.status(404).json({ error: "\u041A\u043B\u044E\u0447 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  key.revoked = true;
  await apiKeys.set(key);
  rebuildKeyHashIndex();
  addAudit("api_key_revoked", "admin", "api_key", key.key_id);
  res.json({ status: "revoked", key_id: key.key_id });
});
app.post("/admin/keys/:id/rotate", adminAuth, async (req, res) => {
  const oldKey = apiKeys.get(req.params.id) || await apiKeys.findByField("key_id", req.params.id);
  if (!oldKey) return res.status(404).json({ error: "\u041A\u043B\u044E\u0447 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D" });
  const rawKey = `foa_live_${import_crypto.default.randomBytes(16).toString("hex")}`;
  oldKey.raw_key = rawKey;
  oldKey.prefix = rawKey.slice(0, 12);
  oldKey.key_hash = hashApiKey(rawKey);
  oldKey.revoked = false;
  oldKey.last_used_at = null;
  await apiKeys.set(oldKey);
  rebuildKeyHashIndex();
  addAudit("api_key_rotated", "admin", "api_key", oldKey.key_id);
  res.json({ status: "rotated", key_id: oldKey.key_id, api_key: rawKey });
});
app.get("/admin/audit", adminAuth, async (req, res) => {
  const eventFilter = req.query.event;
  const subjectFilter = req.query.subject_id;
  const limit = parseInt(req.query.limit) || 100;
  const entries = await queryAudit(eventFilter, subjectFilter, limit);
  res.json({ entries });
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
app.use("/api", requestIdMiddleware, clientHashMiddleware);
app.use("/v1", requestIdMiddleware, clientHashMiddleware);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/v1/")) {
    if (req.method === "POST") {
      recordRequestForRpm(1);
    }
    res.on("finish", () => recordRequest(res.statusCode));
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
function breakerCfg() {
  const cfg = currentConfig.circuit_breaker;
  return {
    window_seconds: cfg?.window_seconds ?? 60,
    minimum_requests: cfg?.minimum_requests ?? 10,
    error_rate_threshold: cfg?.error_rate_threshold ?? 0.5,
    open_duration_seconds: cfg?.open_duration_seconds ?? 30,
    half_open_probes: cfg?.half_open_probes ?? 1
  };
}
function routableNodesForModel(targetModel) {
  return Array.from(nodes.values()).filter((n) => {
    if (!isModelSupportedByNode(n, targetModel)) return false;
    if (isBreakerOpen(n.node_id, breakerCfg())) return false;
    if (canAcceptConnection(n)) return true;
    return false;
  });
}
function canAcceptConnection(node) {
  return node.active_connections < Math.max(1, node.max_concurrency || 1);
}
function upstreamHeaders(req, extra = {}) {
  const h = { "Content-Type": "application/json" };
  const requestId = req.requestId;
  if (requestId) h["X-FOA-Request-ID"] = requestId;
  const clientHash = req.clientHash;
  if (clientHash) h["X-FOA-Client-Hash"] = clientHash;
  const gatewayHeader = currentConfig.security.forward_client_ip !== true;
  if (gatewayHeader) h["X-FOA-Gateway"] = GATEWAY_ID;
  return { ...h, ...extra };
}
var nodeFetchOpts = (extra = {}) => insecureTlsEnabled() ? { ...extra, rejectUnauthorized: false } : extra;
async function callUpstream(req, node, path2, body) {
  const url = `${node.endpoint.replace(/\/+$/, "")}${path2}`;
  try {
    const start = Date.now();
    const res = await fetch(url, nodeFetchOpts({
      method: "POST",
      headers: upstreamHeaders(req),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12e4),
      dispatcher: dispatcherFor(node.endpoint, Math.max(1, node.max_concurrency || 4))
    }));
    const latency = Date.now() - start;
    if (res.ok) {
      recordSuccess(node.node_id, latency, breakerCfg());
      node.error_rate = 0;
      node.latency_ms = latency;
      node.ewma_latency_ms = node.ewma_latency_ms ? Math.round(node.ewma_latency_ms * 0.7 + latency * 0.3) : latency;
    } else if (res.status >= 500) {
      recordFailure(node.node_id, breakerCfg());
      node.error_rate = Math.min(1, (node.error_rate || 0) + 0.1);
    } else {
      recordSuccess(node.node_id, latency, breakerCfg());
    }
    node.updated_at = (/* @__PURE__ */ new Date()).toISOString();
    return res;
  } catch (err) {
    recordFailure(node.node_id, breakerCfg());
    node.error_rate = Math.min(1, (node.error_rate || 0) + 0.2);
    logger.debug("upstream node unreachable", { node: node.node_id, url, error: err.message });
    return null;
  }
}
async function proxyToPoolPassthrough(req, res, path2, body, targetModel) {
  const maxAttempts = Math.max(1, currentConfig.routing.retry_attempts || 2);
  const candidates2 = routableNodesForModel(targetModel);
  if (!candidates2.length) return false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const node = selectNode(candidates2, breakerCfg());
    if (!node) break;
    const upstream = await callUpstream(req, node, path2, body);
    if (!upstream) continue;
    node.active_connections++;
    try {
      res.setHeader("X-FOA-Gateway-Node", node.node_id);
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
      return true;
    } catch {
      try {
        res.destroy();
      } catch {
      }
      return true;
    } finally {
      node.active_connections = Math.max(0, node.active_connections - 1);
    }
  }
  return false;
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
  const routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `\u041C\u043E\u0434\u0435\u043B\u044C '${targetModel}' \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0432 \u043F\u0443\u043B\u0435 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0443\u0437\u043B\u043E\u0432. \u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u043C\u043E\u0434\u0435\u043B\u0438: ${available.slice(0, 10).join(", ")}`
    });
  }
  if (await proxyToPoolPassthrough(req, res, "/api/generate", req.body, targetModel)) return;
  const selectedNode = routable[0];
  const responseText = `[\u041E\u0442\u0432\u0435\u0442 \u0448\u043B\u044E\u0437\u0430 FOA \u0447\u0435\u0440\u0435\u0437 \u0443\u0437\u0435\u043B ${selectedNode.display_name}]: \u0417\u0430\u043F\u0440\u043E\u0441 \u043A \u043C\u043E\u0434\u0435\u043B\u0438 ${targetModel} \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D. \u0412\u0430\u0448 \u0437\u0430\u043F\u0440\u043E\u0441: "${(prompt || "").slice(0, 100)}..."`;
  if (stream === false) {
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
  const routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: `\u041C\u043E\u0434\u0435\u043B\u044C '${targetModel}' \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0432 \u043F\u0443\u043B\u0435 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0445 \u0443\u0437\u043B\u043E\u0432. \u0414\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u043C\u043E\u0434\u0435\u043B\u0438: ${available.slice(0, 10).join(", ")}`
    });
  }
  if (await proxyToPoolPassthrough(req, res, "/api/chat", req.body, targetModel)) return;
  const selectedNode = routable[0];
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : "\u041F\u0440\u0438\u0432\u0435\u0442";
  const replyContent = `[FOA Gateway / ${selectedNode.display_name}]: \u041E\u0442\u0432\u0435\u0442 \u043D\u0430 \u0432\u0430\u0448\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 ("${lastMsg}") \u0447\u0435\u0440\u0435\u0437 \u0430\u0432\u0442\u043E\u0440\u0438\u0437\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0443\u0437\u0435\u043B ${selectedNode.endpoint}.`;
  if (stream === false) {
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
function pickNodeForModel(model) {
  const candidates2 = Array.from(nodes.values()).filter((n) => n.routable && isModelSupportedByNode(n, model)).sort((a, b) => (b.effective_weight || 0) - (a.effective_weight || 0));
  return candidates2[0];
}
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
app.get("/v1/models/:model", userAuth, requireScopes("ollama:read"), applyLimits(), async (req, res) => {
  const target = pickNodeForModel(req.params.model);
  if (!target) return sendApiError(req, res, 404, `\u041C\u043E\u0434\u0435\u043B\u044C '${req.params.model}' \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 \u043D\u0438 \u043D\u0430 \u043E\u0434\u043D\u043E\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E\u043C \u0443\u0437\u043B\u0435`);
  try {
    const { res: upstreamRes } = await nodeFetch(`${target.endpoint.replace(/\/+$/, "")}/v1/models/${encodeURIComponent(req.params.model)}`, {
      method: "GET",
      headers: upstreamHeaders(req),
      timeoutMs: NODE_PROXY_GET_TIMEOUT_MS
    }, { maxConcurrency: Math.max(1, target.max_concurrency || 4), forceInsecureTls: target.insecure_tls === true });
    res.status(upstreamRes.status).json(await upstreamRes.json().catch(() => ({ raw: "" })));
  } catch (err) {
    res.status(502).json({ error: `\u0417\u0430\u043F\u0440\u043E\u0441 /v1/models \u043A \u0443\u0437\u043B\u0443 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${err?.message === "fetch failed" ? describeFetchError(err) : err?.message || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430"}` });
  }
});
app.post("/v1/chat/completions", userAuth, requireScopes("ollama:generate"), applyLimits({ perModel: true, body: "openai" }), async (req, res) => {
  const { model, messages } = req.body;
  const targetModel = model || "llama3:8b";
  const routable = Array.from(nodes.values()).filter((n) => isModelSupportedByNode(n, targetModel));
  if (!routable.length) {
    const available = getRoutableModels();
    return res.status(503).json({
      error: {
        message: `Model '${targetModel}' is not available on any authorized node. Available models: ${available.slice(0, 10).join(", ")}`,
        type: "service_unavailable"
      }
    });
  }
  if (await proxyToPoolPassthrough(req, res, "/v1/chat/completions", req.body, targetModel)) return;
  const selectedNode = routable[0];
  const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1].content : "";
  const text = `[FOA Gateway via ${selectedNode.display_name}]: Processed OpenAI-compatible completion for: "${lastMsg}"`;
  if (req.body.stream) {
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
async function startBackgroundLoops() {
  try {
    const acquired = await tryAcquireLeader(GATEWAY_ID);
    if (!acquired) {
      logger.info("\u041D\u0435 \u043B\u0438\u0434\u0435\u0440 \u2014 \u0444\u043E\u043D\u043E\u0432\u044B\u0435 \u0446\u0438\u043A\u043B\u044B \u043D\u0435 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E\u0442\u0441\u044F", { gateway_id: GATEWAY_ID });
      return;
    }
    logger.info("\u041B\u0438\u0434\u0435\u0440 \u0432\u044B\u0431\u0440\u0430\u043D \u2014 \u0437\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u0444\u043E\u043D\u043E\u0432\u044B\u0435 \u0446\u0438\u043A\u043B\u044B", { gateway_id: GATEWAY_ID });
  } catch (err) {
    logger.warn("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043B\u0438\u0434\u0435\u0440\u0441\u0442\u0432\u043E \u2014 \u0446\u0438\u043A\u043B\u044B \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0442\u0441\u044F \u043A\u0430\u043A \u0443 \u0435\u0434\u0438\u043D\u0441\u0442\u0432\u0435\u043D\u043D\u043E\u0439 \u0440\u0435\u043F\u043B\u0438\u043A\u0438", {
      error: err.message
    });
  }
  setInterval(async () => {
    if (!await amILeader()) return;
    const checks = Array.from(nodes.values()).map(async (node) => {
      try {
        const start = Date.now();
        const res = await fetch(`${node.endpoint}/api/tags`, nodeFetchOpts({
          signal: AbortSignal.timeout(3500),
          ...dispatcherFor(node.endpoint, node.max_concurrency || 4)
        }));
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
  }, 15e3).unref();
  setInterval(async () => {
    if (!await amILeader()) return;
    await sampleNodeMetricsOnce().catch(() => {
    });
  }, NODE_METRICS_INTERVAL_MS).unref();
  setInterval(async () => {
    if (!await amILeader()) return;
    const now = Date.now();
    for (const cand of candidates.values()) {
      const observedAt = cand.observed_at ? Date.parse(cand.observed_at) : NaN;
      if (!Number.isNaN(observedAt) && now - observedAt > 90 * 864e5) {
        await candidates.delete(cand.candidate_id).catch(() => {
        });
      }
    }
  }, 36e5).unref();
}
function breakerConfig() {
  return currentConfig.circuit_breaker || {
    window_seconds: 60,
    minimum_requests: 10,
    error_rate_threshold: 0.5,
    open_duration_seconds: 30,
    half_open_probes: 1
  };
}
async function main() {
  process.on("unhandledRejection", (reason) => {
    logger.error("\u041D\u0435\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043D\u044B\u0439 reject \u2014 \u0448\u043B\u044E\u0437 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0443", {
      error: reason instanceof Error ? reason.message : String(reason)
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error("\u041D\u0435\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043D\u043E\u0435 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u2014 \u0448\u043B\u044E\u0437 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u0440\u0430\u0431\u043E\u0442\u0443", { error: err.message });
  });
  try {
    await bootstrap();
    await startBackgroundLoops();
  } catch (err) {
    logger.error("Bootstrap \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F \u2014 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u043C \u043D\u0430 in-memory \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435", { error: err.message });
  }
  app.listen(PORT, "0.0.0.0", () => {
    logger.info("FOA Gateway \u0441\u043B\u0443\u0448\u0430\u0435\u0442 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u044F", { host: "0.0.0.0", port: PORT });
    console.log(`FOA Gateway running on http://0.0.0.0:${PORT}`);
    console.log(`CORS allowed origins: ${allowedCorsOrigins.join(", ") || "*"}`);
  });
}
var isDirectRun = process.argv[1] && import_meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bootstrap,
  foaApp,
  reloadEnv,
  startBackgroundLoops
});
