// Пул соединений к узлам Ollama (§7.1 ТЗ).
//
// Раньше каждый запрос открывал новое соединение через глобальный fetch.
// Теперь на каждый endpoint узла создаётся undici Agent с keep-alive и
// ограничением числа одновременных соединений: соединения переиспользуются,
// а превышение max_concurrency не приводит к исчерпанию сокетов.

import https from 'https';
import { Agent, Dispatcher } from 'undici';

// Флаг «доверять самоподписанным сертификатам узлов» (FOA_INSECURE_TLS=true).
// Нужен для публичных Ollama-узлов за NAT с самоподписанным TLS: без него
// запросы падают с DEPTH_ZERO_SELF_SIGNED_CERT / HR_BAD_VERIFY.
export function insecureTlsEnabled(): boolean {
  const v = String(process.env.FOA_INSECURE_TLS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const agents = new Map<string, Agent>();

export interface PoolOptions {
  maxConnections?: number;
  connectTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
}

export function getAgentForEndpoint(
  endpoint: string,
  options: PoolOptions = {}
): Agent {
  const key = endpoint.replace(/\/+$/, '');
  const maxConnections = options.maxConnections && options.maxConnections > 0 ? options.maxConnections : 8;
  const existing = agents.get(key);
  if (existing) return existing;

  const agent = new Agent({
    connect: {
      timeout: options.connectTimeoutMs ?? 4_000,
      // Самоподписанный сертификат узла (FOA_INSECURE_TLS=true) — не отклонять.
      rejectUnauthorized: !insecureTlsEnabled(),
    },
    connections: maxConnections,
    keepAliveTimeout: options.keepAliveTimeoutMs ?? 30_000,
    keepAliveMaxTimeout: 60_000,
    pipelining: 1,
  });
  agents.set(key, agent);
  return agent;
}

// Закрыть все соединения к узлу (используется при отзыве/блокировке узла).
export function closeAgentForEndpoint(endpoint: string): void {
  const key = endpoint.replace(/\/+$/, '');
  const agent = agents.get(key);
  if (agent) {
    agent.close().catch(() => {});
    agents.delete(key);
  }
}

export function closeAllAgents(): Promise<void> {
  const all = Array.from(agents.values());
  agents.clear();
  return Promise.all(all.map((a) => a.close().catch(() => {}))).then(() => undefined);
}

// Создаёт fetch-опции с нужным dispatcher для узла.
export function dispatcherFor(
  endpoint: string,
  maxConcurrency: number,
  options: Omit<PoolOptions, 'maxConnections'> = {}
): { dispatcher: Dispatcher } {
  return { dispatcher: getAgentForEndpoint(endpoint, { ...options, maxConnections: Math.max(1, maxConcurrency) }) };
}

// TLS-ошибки при обращении к узлу (самоподписанный/просроченный сертификат).
export function isTlsCertError(err: any): boolean {
  const codes = [
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNKNOWN_CA',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HR_BAD_VERIFY',
    'CW_SYSKEY_NOT_FOUND',
  ];
  const chain = [err?.code, err?.cause?.code, err?.name, err?.cause?.name];
  if (chain.some((c: any) => c && codes.includes(String(c)))) return true;
  const msg = String(err?.message || '') + ' ' + String(err?.cause?.message || '');
  return /self[- ]signed|certificate|SSL routines|altname/i.test(msg);
}

// Запрос к узлу с автоматическим откатом на «непроверяющий» TLS-dispatcher.
// Если FOA_INSECURE_TLS=true — самоподписанные сертификаты узлов принимаются
// сразу; иначе при TLS-ошибке (DEPTH_ZERO_SELF_SIGNED_CERT / HR_BAD_VERIFY)
// выполняется один повтор с rejectUnauthorized:false и в ответ поднимается
// флаг tls_insecure_used (видно в панели и аудите).
export async function nodeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  opts: { maxConcurrency?: number; allowInsecureFallback?: boolean } = {}
): Promise<{ res: Response; tlsInsecureUsed: boolean }> {
  const endpoint = url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
  const { timeoutMs = 120_000, ...fetchInit } = init as any;

  // Мягкий dispatcher: без проверки CA (для самоподписанных сертификатов узлов).
  let soft: Agent | null = null;
  const getSoft = () => {
    if (!soft) {
      soft = new Agent({
        connect: { timeout: 4_000, rejectUnauthorized: false },
        connections: Math.max(1, opts.maxConcurrency || 4),
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        pipelining: 1,
      });
    }
    return soft!;
  };

  const run = (dispatcher?: Agent) =>
    fetch(url, {
      ...fetchInit,
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : dispatcherFor(endpoint, opts.maxConcurrency || 4)),
    } as any);

  try {
    if (opts.allowInsecureFallback !== false && insecureTlsEnabled()) {
      const res = await run(getSoft());
      return { res, tlsInsecureUsed: true };
    }
    const res = await run();
    return { res, tlsInsecureUsed: false };
  } catch (err: any) {
    // TLS-ошибка сертификата → один повтор без проверки CA.
    if (opts.allowInsecureFallback !== false && isTlsCertError(err)) {
      const res = await run(getSoft());
      return { res, tlsInsecureUsed: true };
    }
    throw err;
  } finally {
    // Мягкий агент одноразовый: закрываем, чтобы не копить сокеты.
    if (soft) { const s = soft; soft = null; s.close().catch(() => {}); }
  }
}
