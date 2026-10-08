// PostgreSQL — основное хранилище состояния шлюза (§14.1, §11.1–11.3).
//
// До этого слоя состояние жилo в памяти каждого процесса, и две реплики шлюза
// за nginx расходились: ключ, созданный на реплике A, не был виден на реплике B
// (это и было причиной пустого списка API-ключей в панели).
//
// Модель:
// * PG — источник правды, таблицы хранят сущности целиком в JSONB.
// * Каждый процесс держит кэш (Map) для быстрого чтения в hot-path
//   (маршрутизация, аутентификация).
// * Запись сквозная: мутация обновляет кэш и тут же пишет в PG — ответ клиенту
//   возвращается только после подтверждения записи.
// * Между репликами кэши синхронизируются через LISTEN/NOTIFY (канал foa_changes):
//   после коммита PG уведомляет все реплики, и они перечитывают изменённую
//   таблицу. Дополнительно раз в 30 секунд идёт полное обновление — страховка
//   от потерянных уведомлений и откатов транзакций.
// * Если PG не сконфигурирован (запуск без Docker), хранилище деградирует до
//   чистой in-memory работы — шлюз остаётся функциональным.

import { Pool, Client, PoolClient } from 'pg';
import { logger } from './logger.js';

// --- Соединение -------------------------------------------------------------

function normalizeUrl(url: string): string {
  // .env historically uses the SQLAlchemy-style scheme `postgresql+asyncpg://`,
  // а драйвер `pg` понимает только `postgresql://`.
  return url.replace(/^postgres(?:sql)?\+[a-z0-9]+:\/\//i, 'postgresql://');
}

function resolveDbUrl(): string | null {
  const candidates = [
    process.env.FOA_STORAGE__DATABASE_URL,
    process.env.GATEWAY_DB_URL,
    process.env.DATABASE_URL,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return normalizeUrl(c.trim());
  }
  return null;
}

let pool: Pool | null = null;
let listener: Client | null = null;
let enabled = false;
let connected = false;

export function dbEnabled(): boolean {
  return enabled;
}

export function dbConnected(): boolean {
  return connected;
}

const NOTIFY_CHANNEL = 'foa_changes';

// Таблицы: name -> колонка первичного ключа. Все таблицы имеют одинаковую
// структуру (id + JSONB data), что позволяет использовать generic-репозиторий.
export const TABLES = {
  nodes: 'nodes',
  apiKeys: 'api_keys',
  consents: 'consents',
  blacklist: 'blacklist',
  candidates: 'candidates',
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

const SCHEMA_STATEMENTS = [
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
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC)`,
];

export async function initDb(): Promise<boolean> {
  const url = resolveDbUrl();
  if (!url) {
    logger.warn('GATEWAY_DB_URL/FOA_STORAGE__DATABASE_URL не задан — состояние живёт в памяти процесса', {
      storage: 'in-memory',
    });
    return false;
  }

  try {
    pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
    await pool.query('SELECT 1');
    for (const stmt of SCHEMA_STATEMENTS) {
      await pool.query(stmt);
    }

    listener = new Client({ connectionString: url });
    await listener.connect();
    await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);
    listener.on('notification', (msg) => {
      const payload = safeParsePayload(msg.payload);
      if (payload && reloadHandlers[payload.table]) {
        scheduleReload(payload.table);
      }
    });
    listener.on('error', (err) => {
      logger.warn('PG listener error', { error: err.message });
    });

    enabled = true;
    connected = true;
    logger.info('PostgreSQL подключен', { storage: 'postgres' });
    return true;
  } catch (err: any) {
    connected = false;
    logger.error('PostgreSQL недоступен — работа в in-memory режиме', {
      error: err.message,
      storage: 'in-memory-fallback',
    });
    // Не обрываем запуск: шлюз останется функциональным на in-memory хранилище.
    enabled = false;
    return false;
  }
}

function safeParsePayload(payload: string | undefined): { table: TableName } | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed.table === 'string' && reloadHandlers[parsed.table as TableName]) {
      return { table: parsed.table as TableName };
    }
  } catch {
    // payload может быть именем таблицы без JSON-обёртки
    if (reloadHandlers[payload as TableName]) return { table: payload as TableName };
  }
  return null;
}

// --- Generic write-through store -------------------------------------------

type ReloadHandler = () => Promise<void>;

const reloadHandlers: Partial<Record<TableName, ReloadHandler>> = {};
const pendingReloads = new Set<TableName>();
let reloadTimer: NodeJS.Timeout | null = null;

// Уведомления приходят пакетами; коalesцируем перезагрузки, чтобы не дёргать
// таблицу на каждое изменение в потоке мутаций.
function scheduleReload(table: TableName): void {
  pendingReloads.add(table);
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const tables = Array.from(pendingReloads);
    pendingReloads.clear();
    for (const t of tables) {
      const handler = reloadHandlers[t];
      if (handler) {
        handler().catch((err) => logger.warn('Не удалось перечитать таблицу из PG', { table: t, error: err.message }));
      }
    }
  }, 200);
}

async function notifyTable(table: TableName, client?: PoolClient): Promise<void> {
  if (!enabled) return;
  const payload = JSON.stringify({ table, from: process.env.GATEWAY_ID || 'foa-gw' });
  if (client) {
    await client.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, payload]);
  } else if (pool) {
    await pool.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, payload]);
  }
}

export async function query(text: string, params?: unknown[]) {
  if (!pool) throw new Error('БД не инициализирована');
  return pool.query(text, params as any);
}

// Транзакция для многосущностных операций (регистрация узла + согласие +
// аудит должны быть атомарны).
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('БД не инициализирована');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Поля, которые живут только в памяти конкретной реплики и не должны
// перетираться при синхронизации с PG.
const VOLATILE_FIELDS: Record<TableName, string[]> = {
  nodes: ['active_connections'],
  api_keys: ['raw_key', 'last_used_at'],
  consents: [],
  blacklist: [],
  candidates: [],
};

export class Store<T extends Record<string, any>> {
  private cache = new Map<string, T>();
  private idField: string;

  constructor(
    private table: TableName,
    private idGetter: (item: T) => string
  ) {
    this.idField = 'id';
  }

  // --- синхронное чтение из кэша (hot-path) ---
  get(id: string): T | undefined {
    return this.cache.get(id);
  }
  has(id: string): boolean {
    return this.cache.has(id);
  }
  get size(): number {
    return this.cache.size;
  }
  values(): IterableIterator<T> {
    return this.cache.values();
  }
  entries(): IterableIterator<[string, T]> {
    return this.cache.entries();
  }
  keys(): IterableIterator<string> {
    return this.cache.keys();
  }
  forEach(cb: (value: T, key: string, map: Map<string, T>) => void): void {
    this.cache.forEach(cb);
  }

  private extractId(item: T): string {
    return this.idGetter(item);
  }

  // Запись: кэш обновляется оптимально (перезапишется перезагрузкой, если
  // транзакция откатится), затем идёт запись в PG.
  async set(item: T, client?: PoolClient): Promise<void> {
    const id = this.extractId(item);
    this.cache.set(id, item);
    if (!enabled) return;
    const row = this.serialize(item);
    const q = `INSERT INTO ${this.table} (id, data) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = now()`;
    if (client) {
      await client.query(q, [id, row]);
    } else if (pool) {
      await pool.query(q, [id, row]);
    }
  }

  async delete(id: string, client?: PoolClient): Promise<void> {
    this.cache.delete(id);
    if (!enabled) return;
    const q = `DELETE FROM ${this.table} WHERE id = $1`;
    if (client) {
      await client.query(q, [id]);
    } else if (pool) {
      await pool.query(q, [id]);
    }
  }

  // Обновление только кэша (без записи в PG) — используется, например, при
  // восстановлении ключа аутентификации после промаха кэша: PG уже авторитет.
  cacheUpsert(item: T): void {
    this.cache.set(this.extractId(item), item);
  }

  cacheDelete(id: string): void {
    this.cache.delete(id);
  }

  async clear(): Promise<void> {
    this.cache.clear();
    if (!enabled) return;
    if (pool) await pool.query(`DELETE FROM ${this.table}`);
  }

  // Список читается напрямую из PG — это гарантирует, что панель видит
  // свежие данные независимо от того, какой реплике достался запрос.
  async list(): Promise<T[]> {
    if (!enabled) return Array.from(this.cache.values());
    const res = await query(`SELECT data FROM ${this.table}`);
    const items = res.rows.map((r) => this.deserialize(r.data));
    this.replaceCache(items);
    return items;
  }

  // Перезагрузка из PG с сохранением volatile-полей текущего кэша.
  async reload(): Promise<void> {
    if (!enabled) return;
    const res = await query(`SELECT data FROM ${this.table}`);
    const items = res.rows.map((r) => this.deserialize(r.data));
    this.replaceCache(items);
  }

  private replaceCache(items: T[]): void {
    const volatileFields = VOLATILE_FIELDS[this.table] || [];
    const next = new Map<string, T>();
    for (const item of items) {
      const id = this.extractId(item);
      if (volatileFields.length) {
        const local = this.cache.get(id);
        if (local) {
          for (const field of volatileFields) {
            if (local[field] !== undefined) (item as any)[field] = local[field];
          }
        }
      }
      next.set(id, item);
    }
    this.cache = next;
  }

  registerReloadHandler(handler: ReloadHandler): void {
    reloadHandlers[this.table] = handler;
  }

  // Для api_keys — отдельный путь: сериализация не должна вытаскивать raw_key
  // (сырой ключ хранится только в памяти создания/ротации).
  private serialize(item: T): string {
    const table = this.table;
    if (table === TABLES.apiKeys) {
      const copy: Record<string, any> = { ...(item as any) };
      delete copy.raw_key;
      return JSON.stringify(copy);
    }
    return JSON.stringify(item);
  }

  private deserialize(data: any): T {
    return data as T;
  }

  // Поиск по произвольному полю (используется для lookup ключа по key_hash).
  async findByField(field: string, value: string): Promise<T | null> {
    if (!enabled) {
      for (const item of this.cache.values()) {
        if ((item as any)[field] === value) return item;
      }
      return null;
    }
    const res = await query(`SELECT data FROM ${this.table} WHERE data @> $1::jsonb`, [
      JSON.stringify({ [field]: value }),
    ]);
    if (res.rows.length === 0) return null;
    return this.deserialize(res.rows[0].data);
  }

  table_name(): TableName {
    return this.table;
  }
}

// --- Аудит ------------------------------------------------------------------

export async function insertAuditRow(id: string, data: Record<string, any>, createdAt: string): Promise<void> {
  if (!enabled || !pool) return;
  try {
    await pool.query(
      'INSERT INTO audit_logs (id, data, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, JSON.stringify(data), createdAt]
    );
  } catch (err: any) {
    logger.warn('Не удалось записать событие аудита в PG', { error: err.message, event: data.event });
  }
}

export async function queryAudit(event?: string, subjectId?: string, limit = 100): Promise<Record<string, any>[]> {
  if (!enabled) return [];
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (event) {
    params.push(`%"event":"${event.replace(/"/g, '\\"')}"%`);
    conditions.push(`data::text LIKE $${params.length}`);
  }
  if (subjectId) {
    params.push(`%"subject_id":"${subjectId.replace(/"/g, '\\"')}"%`);
    conditions.push(`data::text LIKE $${params.length}`);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);
  const res = await query(
    `SELECT data FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return res.rows.map((r) => r.data as Record<string, any>);
}

export async function clearAudit(): Promise<void> {
  if (!enabled || !pool) return;
  await pool.query('DELETE FROM audit_logs');
}

// Периодическая страховка: полное обновление кэшей всех таблиц.
export function startFullReloadLoop(getTables: () => TableName[]): void {
  setInterval(() => {
    for (const table of getTables()) {
      const handler = reloadHandlers[table];
      if (handler) {
        handler().catch((err) =>
          logger.warn('Периодический перерасчёт кэша не удался', { table, error: err.message })
        );
      }
    }
  }, 30_000);
}

export async function closeDb(): Promise<void> {
  if (listener) {
    await listener.end().catch(() => {});
    listener = null;
  }
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  enabled = false;
  connected = false;
}
