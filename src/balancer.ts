// Балансировщик нагрузки и защита узлов (§6.3, §6.5, §7.2–7.5 ТЗ).
//
// Поверх прежнего выбора «наименьшее число соединений» добавлены:
// * веса узлов и штраф за задержку (EWMA) — heavier и быстрые узлы получают
//   больше трафика (§7.2, §7.3);
// * circuit breaker — узел с высокой долей ошибок временно исключается из
//   маршрутизации и переводится в half-open для проверки (§6.5);
// * passive health-monitoring — ошибки реальных запросов учитываются при
//   выборе узла (§6.3).
//
// Состояние breaker-а живёт в памяти каждой реплики — это локальная защита
// маршрутизатора, а не разделяемые данные.

export interface BalancerNode {
  node_id: string;
  weight: number;
  ewma_latency_ms?: number;
  active_connections: number;
  max_concurrency: number;
  status: string;
  routable: boolean;
}

export interface CircuitBreakerConfig {
  window_seconds: number;
  minimum_requests: number;
  error_rate_threshold: number;
  open_duration_seconds: number;
  half_open_probes: number;
}

interface BreakerState {
  // временные метки ошибок в рамках окна
  failures: number[];
  successes: number[];
  openedAt: number | null;
  probesInflight: number;
}

const breakers = new Map<string, BreakerState>();

function getBreaker(nodeId: string): BreakerState {
  let state = breakers.get(nodeId);
  if (!state) {
    state = { failures: [], successes: [], openedAt: null, probesInflight: 0 };
    breakers.set(nodeId, state);
  }
  return state;
}

function prune(list: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return list.filter((t) => t > cutoff);
}

// Открыт ли breaker. Возвращает true, если узел нельзя использовать.
export function isBreakerOpen(nodeId: string, config: CircuitBreakerConfig, now = Date.now()): boolean {
  const state = getBreaker(nodeId);
  if (state.openedAt === null) return false;

  const elapsedSec = (now - state.openedAt) / 1000;
  if (elapsedSec < config.open_duration_seconds) {
    // окно ещё не прошло — узел недоступен (за исключением half-open проб)
    return state.probesInflight >= config.half_open_probes;
  }

  // окно прошло — переводим в half-open: разрешаем одну пробу
  state.openedAt = null;
  state.failures = [];
  state.successes = [];
  state.probesInflight = 0;
  return false;
}

// Резервирует слот half-open пробы. Возвращает false, если слоты заняты.
export function tryAcquireProbe(nodeId: string, config: CircuitBreakerConfig, now = Date.now()): boolean {
  const state = getBreaker(nodeId);
  if (state.openedAt !== null && (now - state.openedAt) / 1000 >= config.open_duration_seconds) {
    // время переоткрыть для пробы
    state.openedAt = null;
    state.failures = [];
    state.successes = [];
    state.probesInflight = 0;
  }
  if (state.openedAt === null && state.probesInflight < config.half_open_probes) {
    state.probesInflight++;
    return true;
  }
  return false;
}

export function recordSuccess(
  nodeId: string,
  latencyMs: number,
  config: CircuitBreakerConfig,
  now = Date.now()
): void {
  const state = getBreaker(nodeId);
  state.successes = prune(state.successes, config.window_seconds * 1000, now);
  state.successes.push(now);
  if (state.probesInflight > 0) state.probesInflight--;
  // успешный запрос закрывает цепь
  state.openedAt = null;
  state.failures = prune(state.failures, config.window_seconds * 1000, now);
}

export function recordFailure(nodeId: string, config: CircuitBreakerConfig, now = Date.now()): void {
  const state = getBreaker(nodeId);
  state.failures = prune(state.failures, config.window_seconds * 1000, now);
  state.failures.push(now);
  if (state.probesInflight > 0) state.probesInflight--;

  const windowMs = config.window_seconds * 1000;
  const successes = prune(state.successes, windowMs, now);
  const total = successes.length + state.failures.length;
  if (total >= config.minimum_requests && state.failures.length / total >= config.error_rate_threshold) {
    state.openedAt = now;
    state.probesInflight = 0;
  }
}

// Снимает состояние breaker-а (узел удалён/перевыпущен).
export function resetBreaker(nodeId: string): void {
  breakers.delete(nodeId);
}

// --- Выбор узла (§7.2–7.5) ---------------------------------------------------
//
// Оценка учитывает заявленный вес, штраф за задержку (EWMA) и текущую
// нагрузку. Узлы с открытым breaker-ом и превышенным max_concurrency не
// рассматриваются.

export function scoreNode(node: BalancerNode): number {
  const weight = node.weight > 0 ? node.weight : 1;
  const latency = node.ewma_latency_ms || node.active_connections > 0 ? Math.max(10, node.ewma_latency_ms || 50) : 50;
  // штраф за задержку: узел в 4 раза медленнее получает в 2 раза меньше трафика
  const latencyFactor = 1000 / (1000 + latency);
  // свободная ёмкость: узел, у которого уже заняты все слоты, не получает трафик
  const freeCapacity = Math.max(
    0.05,
    1 - node.active_connections / Math.max(1, node.max_concurrency || 1)
  );
  return weight * latencyFactor * freeCapacity;
}

export function selectNode<T extends BalancerNode>(
  candidates: T[],
  config: CircuitBreakerConfig,
  now = Date.now()
): T | null {
  const usable = candidates.filter((n) => {
    if (!n.routable) return false;
    if (n.status === 'blacklisted' || n.status === 'unhealthy') return false;
    if (n.active_connections >= Math.max(1, n.max_concurrency || 1)) return false;
    return !isBreakerOpen(n.node_id, config, now);
  });
  if (!usable.length) return null;

  // Взвешенный случайный выбор: вероятность пропорциональна оценке. Это
  // равномернее, чем всегда брать максимум, и устойчиво к шуму метрик.
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

// Резервирует слот соединения на узле (защита от превышения max_concurrency).
export function canAcceptConnection(node: BalancerNode): boolean {
  return node.active_connections < Math.max(1, node.max_concurrency || 1);
}
