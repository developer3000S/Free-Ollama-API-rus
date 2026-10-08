// Structured JSON logger (§11.4, §12.5).
//
// Все журналируемые события уходят в stdout одной строкой JSON, чтобы их мог
// собирать любой log-агрегатор (Loki/ELK). Секреты маскируются (§12.5.2):
// API-ключи foa_live_…, challenge-токены, пароли и значения полей с
// «секретными» именами никогда не попадают в журнал в открытом виде.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_NAMES = ['loglevel', 'FOA_OBSERVABILITY__LOG_LEVEL', 'LOG_LEVEL'];

function resolveLevel(): LogLevel {
  for (const name of LEVEL_NAMES) {
    const raw = process.env[name];
    if (raw) {
      const v = String(raw).trim().toLowerCase();
      if (v in LEVEL_WEIGHT) return v as LogLevel;
    }
  }
  return 'info';
}

let currentLevelWeight = LEVEL_WEIGHT[resolveLevel()];

export function setLogLevel(level: LogLevel): void {
  currentLevelWeight = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
}

export function getLogLevel(): LogLevel {
  return (Object.keys(LEVEL_WEIGHT).find((k) => LEVEL_WEIGHT[k as LogLevel] === currentLevelWeight) ||
    'info') as LogLevel;
}

// --- Маскирование секретов -------------------------------------------------

const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/foa_live_[a-f0-9]{8,}/g, 'foa_live_***'],
  [/foa_chk_[a-f0-9]{8,}/g, 'foa_chk_***'],
  [/ch_[a-f0-9]{16,}/g, 'ch_***'],
  [/Bearer\s+[^\s"']+/g, 'Bearer ***'],
];

const SECRET_KEY_HINTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'raw_key',
  'key_hash',
  'salt',
  'credential',
];

function maskString(input: string): string {
  let out = input;
  for (const [re, replacement] of SECRET_TEXT_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function isSecretKey(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lower.includes(hint));
}

// Рекурсивно маскирует секреты в любых структурах (объекты, массивы, вложенности).
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '***' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

// --- Вывод ------------------------------------------------------------------

export interface LogMeta {
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHT[level] < currentLevelWeight) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: 'foa-gateway',
    msg,
    ...(meta ? (maskSecrets(meta) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (msg: string, meta?: LogMeta) => emit('debug', msg, meta),
  info: (msg: string, meta?: LogMeta) => emit('info', msg, meta),
  warn: (msg: string, meta?: LogMeta) => emit('warn', msg, meta),
  error: (msg: string, meta?: LogMeta) => emit('error', msg, meta),
};
