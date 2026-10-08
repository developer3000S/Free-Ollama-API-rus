// Пул соединений к узлам Ollama (§7.1 ТЗ).
//
// Раньше каждый запрос открывал новое соединение через глобальный fetch.
// Теперь на каждый endpoint узла создаётся undici Agent с keep-alive и
// ограничением числа одновременных соединений: соединения переиспользуются,
// а превышение max_concurrency не приводит к исчерпанию сокетов.

import { Agent, Dispatcher } from 'undici';

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
