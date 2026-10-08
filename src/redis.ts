// Redis — разделяемое между репликами состояние счётчиков (§12.4, §11.1–11.3).
//
// Лимиты, RPM-история и active-счётчики живут в Redis, поэтому две реплики
// шлюза за nginx работают как единое целое: пользователь не может обойти
// лимит, раскидывая запросы по репликам. Если Redis не сконфигурирован,
// всё падает на in-memory-реализацию — шлюз остаётся функциональным.

import { Redis } from 'ioredis';
import { logger } from './logger.js';

// ioredis экспортирует класс двумя способами: `export default` и
// `export { default as Redis }`. Именованный импорт даёт и конструктор, и тип
// без шума с esModuleInterop.
type RedisInstance = InstanceType<typeof Redis>;

// --- Соединение -------------------------------------------------------------

function resolveRedisUrl(): string | null {
  const candidates = [
    process.env.FOA_STORAGE__REDIS_URL,
    process.env.GATEWAY_REDIS_URL,
    process.env.REDIS_URL,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return null;
}

let client: RedisInstance | null = null;
let enabled = false;

export function redisEnabled(): boolean {
  return enabled;
}

export function redisClient(): RedisInstance | null {
  return client;
}

export async function initRedis(): Promise<boolean> {
  const url = resolveRedisUrl();
  if (!url) {
    logger.warn('GATEWAY_REDIS_URL/FOA_STORAGE__REDIS_URL не задан — лимиты считаются в памяти процесса', {
      storage: 'in-memory',
    });
    return false;
  }

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    await client.ping();
    client.on('error', (err) => {
      logger.warn('Redis error', { error: err.message });
    });
    enabled = true;
    logger.info('Redis подключен', { storage: 'redis' });
    return true;
  } catch (err: any) {
    logger.error('Redis недоступен — лимиты считаются в памяти процесса', {
      error: err.message,
      storage: 'in-memory-fallback',
    });
    enabled = false;
    client = null;
    return false;
  }
}

// --- Sliding-window rate limit (§12.4.1) ------------------------------------
//
// Сортированное множество хранит временные метки обращений. Окно чистится от
// устаревших меток, после чего проверяется количество. Атомарность даёт Lua:
// между репликами нет гонки «две одновременно пропустили лимит».

const LUA_SLIDING_WINDOW = `local key = KEYS[1]
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

let slidingSha: string | null = null;

async function evalSliding(
  key: string,
  windowMs: number,
  limit: number,
  now: number
): Promise<[number, number, number]> {
  if (!client) throw new Error('redis not initialized');
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  let res: any;
  if (slidingSha) {
    try {
      res = await client.evalsha(slidingSha, 1, key, now, windowMs, limit, member);
    } catch (err: any) {
      // NOSCRIPT — скрипт мог выгрузиться, перевыполняем обычным eval
      if (!String(err.message || '').includes('NOSCRIPT')) throw err;
      res = await client.eval(LUA_SLIDING_WINDOW, 1, key, now, windowMs, limit, member);
    }
  } else {
    res = await client.eval(LUA_SLIDING_WINDOW, 1, key, now, windowMs, limit, member);
    if (Array.isArray(res)) slidingSha = String(await client.script('LOAD', LUA_SLIDING_WINDOW).catch(() => null as any));
  }
  return [Number(res[0]), Number(res[1]), Number(res[2])];
}

// In-memory fallback для режима без Redis.
const localWindows = new Map<string, number[]>();

function localSliding(key: string, windowMs: number, limit: number, now: number): [number, number, number] {
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

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfter: number;
}

export async function checkRateLimit(
  scope: string,
  id: string,
  limit: number,
  windowMs: number,
  now = Date.now()
): Promise<RateLimitResult> {
  if (!enabled || !client) {
    const [allowed, count, oldest] = localSliding(`${scope}:${id}`, windowMs, limit, now);
    return { allowed: allowed === 1, count, retryAfter: oldest ? Math.ceil((oldest + windowMs - now) / 1000) : 0 };
  }
  try {
    const key = `foa:rl:${scope}:${id}`;
    const [allowed, count, oldest] = await evalSliding(key, windowMs, limit, now);
    return {
      allowed: allowed === 1,
      count,
      retryAfter: oldest ? Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) : 0,
    };
  } catch (err: any) {
    logger.warn('Redis rate-limit недоступен — переключение на in-memory', { error: err.message });
    const [allowed, count, oldest] = localSliding(`${scope}:${id}`, windowMs, limit, now);
    return { allowed: allowed === 1, count, retryAfter: oldest ? Math.ceil((oldest + windowMs - now) / 1000) : 0 };
  }
}

// --- Счётчики параллельных запросов (§12.4.2) -------------------------------
//
// INCR + EXPIRE: если реплика упала, не отпустив счётчик, он обнулится сам.
// Релиз делает DECR с защитой от ухода в минус.

const LUA_INCR_LIMIT = `local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = redis.call('GET', key)
if cur ~= nil and tonumber(cur) >= limit then
  return 0
end
local n = redis.call('INCR', key)
redis.call('EXPIRE', key, ttl)
return 1`;

let incrSha: string | null = null;

const localInflight = new Map<string, number>();

export async function acquireInflight(id: string, limit: number, ttlSec = 60): Promise<boolean> {
  if (!enabled || !client) {
    const cur = localInflight.get(id) || 0;
    if (cur >= limit) return false;
    localInflight.set(id, cur + 1);
    return true;
  }
  try {
    const key = `foa:inflight:${id}`;
    if (incrSha) {
      try {
        const res = await client.evalsha(incrSha, 1, key, limit, ttlSec);
        return Number(res) === 1;
      } catch (err: any) {
        if (!String(err.message || '').includes('NOSCRIPT')) throw err;
      }
    }
    const res = await client.eval(LUA_INCR_LIMIT, 1, key, limit, ttlSec);
    incrSha = String(await client.script('LOAD', LUA_INCR_LIMIT).catch(() => null as any));
    return Number(res) === 1;
  } catch (err: any) {
    logger.warn('Redis inflight недоступен — in-memory', { error: err.message });
    const cur = localInflight.get(id) || 0;
    if (cur >= limit) return false;
    localInflight.set(id, cur + 1);
    return true;
  }
}

export async function releaseInflight(id: string): Promise<void> {
  if (!enabled || !client) {
    const cur = localInflight.get(id) || 0;
    localInflight.set(id, Math.max(0, cur - 1));
    return;
  }
  try {
    const key = `foa:inflight:${id}`;
    const next = await client.decr(key);
    if (next < 0) await client.set(key, 0, 'EX', 60);
  } catch (err: any) {
    const cur = localInflight.get(id) || 0;
    localInflight.set(id, Math.max(0, cur - 1));
  }
}

// --- RPM-история (60 минут) -------------------------------------------------
//
// Ключ foa:rpm:<минута> инкрементируется на каждый запрос и истекает через
// час. Чтение собирает последние 60 минут.

const RPM_BUCKETS = 60;

export async function recordRpm(count = 1): Promise<void> {
  if (!enabled || !client) {
    rpmLocalFallback.record(count);
    return;
  }
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `foa:rpm:${minute}`;
    const pipeline = client.multi();
    pipeline.incrby(key, count);
    pipeline.expire(key, RPM_BUCKETS * 70);
    await pipeline.exec();
  } catch (err: any) {
    rpmLocalFallback.record(count);
  }
}

export async function getRpmBuckets(): Promise<number[]> {
  if (!enabled || !client) {
    return rpmLocalFallback.read();
  }
  try {
    const now = Date.now();
    const currentMin = Math.floor(now / 60000);
    const pipeline = client.multi();
    for (let i = RPM_BUCKETS - 1; i >= 0; i--) {
      pipeline.get(`foa:rpm:${currentMin - i}`);
    }
    const results = await pipeline.exec();
    if (!results) return new Array(RPM_BUCKETS).fill(0);
    return results.map((r) => Number((r[1] as string | null) || 0));
  } catch (err: any) {
    return rpmLocalFallback.read();
  }
}

// In-memory RPM fallback: кольцевой буфер на 60 минут.
class RpmLocalFallback {
  private buckets = new Array(RPM_BUCKETS).fill(0);
  private lastMinute = Math.floor(Date.now() / 60000);

  private shift(currentMin: number): void {
    const diff = Math.min(RPM_BUCKETS, currentMin - this.lastMinute);
    for (let i = 0; i < diff; i++) {
      this.buckets.shift();
      this.buckets.push(0);
    }
    this.lastMinute = currentMin;
  }

  record(count: number): void {
    this.shift(Math.floor(Date.now() / 60000));
    this.buckets[RPM_BUCKETS - 1] += count;
  }

  read(): number[] {
    this.shift(Math.floor(Date.now() / 60000));
    return [...this.buckets];
  }
}

const rpmLocalFallback = new RpmLocalFallback();

// --- Реестр живых реплик шлюза ----------------------------------------------
//
// Каждая реплика продлевает свой ключ с TTL — /admin/status показывает,
// какие реплики сейчас живы (§14.1: «минимум 2 реплики»).

const GATEWAY_TTL_SEC = 30;

export async function registerGateway(gatewayId: string, meta: Record<string, unknown> = {}): Promise<void> {
  if (!enabled || !client) return;
  try {
    await client.set(`foa:gw:${gatewayId}`, JSON.stringify({ ...meta, at: Date.now() }), 'EX', GATEWAY_TTL_SEC);
  } catch {
    // non-fatal
  }
}

export async function listGateways(): Promise<Array<Record<string, any>>> {
  if (!enabled || !client) return [];
  try {
    const keys = await client.keys('foa:gw:*');
    if (!keys.length) return [];
    const values = await client.mget(...keys);
    return values
      .filter((v): v is string => !!v)
      .map((v) => {
        try {
          return JSON.parse(v);
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

// --- Leader election для фоновых задач --------------------------------------
//
// Чтобы периодические health-checks и перепроверка согласий не дублировались
// всеми репликами, их выполняет только лидер. Аренда короткая — если реплика
// упала, лидерство тут же перехватывает другая.

const LEADER_KEY = 'foa:leader:scheduler';
const LEADER_TTL_SEC = 20;
let leaderRenewTimer: NodeJS.Timeout | null = null;
let isLeader = false;

export async function tryAcquireLeader(gatewayId: string): Promise<boolean> {
  if (!enabled || !client) return true; // без Redis единственная реплика — лидер
  try {
    const res = await client.set(LEADER_KEY, gatewayId, 'EX', LEADER_TTL_SEC, 'NX');
    const acquired = res === 'OK';
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
          // keep current state
        }
      }, LEADER_TTL_SEC * 500);
    }
    isLeader = acquired;
    return acquired;
  } catch {
    return true;
  }
}

export function amILeader(): boolean {
  return isLeader;
}

export async function closeRedis(): Promise<void> {
  if (leaderRenewTimer) {
    clearInterval(leaderRenewTimer);
    leaderRenewTimer = null;
  }
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
  enabled = false;
}
