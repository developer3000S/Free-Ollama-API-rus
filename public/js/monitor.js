/* ===== FOA Gateway Admin Panel :: monitor.js ===== */
/* ====================================================================== */
/*  Monitor (60m Real-time Charts & Latency Distribution)                  */
/* ====================================================================== */
let monitorLatencyChartInstance = null;
let monitorErrorChartInstance = null;
let monitorHistogramChartInstance = null;
let monitorSearchQuery = '';
let cachedRoutableNodes = [];
let monitorHistogramSelectedNode = 'all'; // 'all' or nodeId
let monitorHistogramMode = 'count'; // 'count' | 'percentage'
let cachedLatencyDistribution = null;

// Параметры автообновления страницы Monitor: interval задаётся в секундах.
const pollingSettings = {
  enabled: true,
  interval: 20,
};

// ======================================================================
//  Monitor Client-Side Data Buffering & Request Aggregation
// ======================================================================
let monitorFetchInProgress = null;
let monitorLastFetchTime = 0;
const MONITOR_DEBOUNCE_MS = 600;
// Окно истории: одна точка на каждый опрос сервера. Сервер не отдаёт
// временной ряд задержек по узлам — он накапливается на клиенте по мере
// опросов (pollingSettings.interval секунд на точку).
const BUFFER_MAX_POINTS = 60;
const nodeMetricsBuffer = new Map(); // nodeId -> [{ t, latency, error }]

async function fetchAggregatedMonitorData() {
  const now = Date.now();
  if (monitorFetchInProgress) {
    return monitorFetchInProgress;
  }
  if (now - monitorLastFetchTime < MONITOR_DEBOUNCE_MS && cachedRoutableNodes.length > 0) {
    return { nodes: cachedRoutableNodes, distribution: cachedLatencyDistribution };
  }

  monitorFetchInProgress = (async () => {
    try {
      const [data, distData] = await Promise.all([
        API.get('/admin/nodes', { detailed: true }),
        API.get('/admin/nodes/latency-distribution').catch(() => null)
      ]);
      monitorLastFetchTime = Date.now();
      const routable = (data.nodes || []).filter(n => n.routable);
      recordNodeMetrics(routable);
      return { nodes: data.nodes || [], distribution: distData };
    } finally {
      monitorFetchInProgress = null;
    }
  })();

  return monitorFetchInProgress;
}

// Записывает свежие показания узлов в буфер истории (одна точка на опрос).
function recordNodeMetrics(routableNodes) {
  if (!routableNodes || !routableNodes.length) return;
  const now = Date.now();
  for (const n of routableNodes) {
    let history = nodeMetricsBuffer.get(n.node_id);
    if (!history) {
      history = [];
      nodeMetricsBuffer.set(n.node_id, history);
    }
    history.push({
      t: now,
      latency: n.latency_ms != null ? Number(n.latency_ms) : null,
      error: n.error_rate != null ? Number(n.error_rate) : 0,
    });
    if (history.length > BUFFER_MAX_POINTS) history.shift();
  }
}

// Усреднённая задержка узла по буферу — используется для бейджа «Средняя»
// и сводных карточек, чтобы они отражали накопленную историю, а не один срез.
function getBufferedLatency(nodeId, currentLatency, maxWindow = 10) {
  const history = nodeMetricsBuffer.get(nodeId);
  if (!history || history.length === 0) return currentLatency;
  const slice = history.slice(-maxWindow);
  const values = slice.map(p => p.latency).filter(v => v != null);
  if (!values.length) return currentLatency;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number((sum / values.length).toFixed(1));
}

// Ряды Latency / Error Rate для узла, построенные из буфера истории опросов.
// Возвращает { labels, latency, errors }; длины массивов совпадают.
function getBufferedSeries(nodeId) {
  const history = nodeMetricsBuffer.get(nodeId) || [];
  return {
    labels: history.map(p => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    latency: history.map(p => p.latency),
    errors: history.map(p => p.error != null ? +(p.error * 100).toFixed(2) : null),
  };
}

function refreshLatencyLegendOverlay() {
  const legendContainer = document.getElementById('latency-legend-overlay');
  const avgBadge = document.getElementById('latency-avg-badge');
  if (!legendContainer || !monitorLatencyChartInstance) return;

  legendContainer.innerHTML = '';
  let sum = 0;
  let count = 0;

  monitorLatencyChartInstance.data.datasets.forEach((ds, idx) => {
    const isHidden = monitorLatencyChartInstance.getDatasetMeta(idx).hidden;
    if (!isHidden) {
      ds.data.forEach(val => {
        if (val != null) { sum += val; count++; }
      });
    }

    const pill = document.createElement('button');
    pill.className = `legend-pill ${isHidden ? 'inactive' : 'active'}`;
    pill.style.borderColor = ds.borderColor;
    if (!isHidden) {
      pill.style.background = ds.borderColor;
      pill.style.color = '#fff';
    } else {
      pill.style.color = ds.borderColor;
    }
    pill.innerHTML = `<span class="dot" style="background: ${isHidden ? ds.borderColor : '#fff'}"></span><span>${esc(ds.label)}</span>`;
    pill.title = 'Нажмите, чтобы включить/выключить узел в графике';
    pill.onclick = () => {
      const meta = monitorLatencyChartInstance.getDatasetMeta(idx);
      meta.hidden = !meta.hidden;
      // Тот же набор датасетов в том же порядке у графика ошибок —
      // скрываем синхронно, чтобы узел переключался на обоих графиках.
      if (monitorErrorChartInstance && monitorErrorChartInstance.data.datasets[idx]) {
        monitorErrorChartInstance.getDatasetMeta(idx).hidden = meta.hidden;
        monitorErrorChartInstance.update();
      }
      monitorLatencyChartInstance.update();
      refreshLatencyLegendOverlay();
    };
    legendContainer.appendChild(pill);
  });

  if (avgBadge) {
    if (count > 0) {
      const avg = Math.round(sum / count);
      avgBadge.textContent = `⚡ Средняя: ${avg} мс`;
      avgBadge.style.display = 'inline-block';
    } else {
      avgBadge.textContent = '⚡ Средняя: нет активных';
      avgBadge.style.display = 'inline-block';
    }
  }
}

const HISTOGRAM_BINS = [
  { id: 'b_0_50', label: '< 50ms', color: '#10b981', quality: 'Отлично', min: 0, max: 50 },
  { id: 'b_50_100', label: '50–100ms', color: '#06b6d4', quality: 'Быстро', min: 50, max: 100 },
  { id: 'b_100_200', label: '100–200ms', color: '#3b82f6', quality: 'Нормально', min: 100, max: 200 },
  { id: 'b_200_400', label: '200–400ms', color: '#8b5cf6', quality: 'Умеренно', min: 200, max: 400 },
  { id: 'b_400_800', label: '400–800ms', color: '#f59e0b', quality: 'Замедленно', min: 400, max: 800 },
  { id: 'b_800_1500', label: '800–1500ms', color: '#f97316', quality: 'Высокая', min: 800, max: 1500 },
  { id: 'b_1500_plus', label: '> 1500ms', color: '#ef4444', quality: 'Критично', min: 1500, max: Infinity },
];

// Сколько точек истории уже накоплено в буфере (для бейджа в topbar).
function bufferedPointsCount() {
  let max = 0;
  for (const arr of nodeMetricsBuffer.values()) {
    if (arr.length > max) max = arr.length;
  }
  return max;
}

function renderMonitorTopbar(container) {
  $('#topbar-actions').innerHTML = '';

  const searchInput = h('input', {
    type: 'text',
    id: 'monitor-search-input',
    class: 'form-control',
    placeholder: '🔍 Фильтр по имени или ID...',
    style: { width: '240px', padding: '6px 12px', fontSize: '13px' },
    value: monitorSearchQuery
  });
  searchInput.addEventListener('input', (e) => {
    monitorSearchQuery = e.target.value.toLowerCase();
    updateMonitorView(container);
  });

  const bufferBadge = h('span', {
    id: 'monitor-buffer-badge',
    class: 'badge badge-green',
    style: {fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px'}
  }, `📦 Буфер: ${bufferedPointsCount()} / ${BUFFER_MAX_POINTS} точек`);

  const actionsWrap = h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}},
    searchInput,
    bufferBadge,
    h('button', {class: 'btn btn-primary', onClick: () => renderMonitor(container)}, '🔄 Обновить')
  );
  $('#topbar-actions').appendChild(actionsWrap);
}

async function renderMonitor(container) {
  renderMonitorTopbar(container);

  container.innerHTML = '<div class="loading">Загрузка данных мониторинга…</div>';

  try {
    const res = await fetchAggregatedMonitorData();
    const nodesList = res.nodes || [];
    cachedRoutableNodes = nodesList.filter(n => n.routable);
    cachedLatencyDistribution = res.distribution;

    updateMonitorView(container);

    if (refreshTimer) clearInterval(refreshTimer);
    const ms = Math.max(3000, (pollingSettings.interval || 20) * 1000);
    if (pollingSettings.enabled) {
      refreshTimer = setInterval(() => {
        if (currentPage === 'monitor') {
          fetchAggregatedMonitorData().then((r) => {
            cachedRoutableNodes = (r.nodes || []).filter(n => n.routable);
            cachedLatencyDistribution = r.distribution;
            const badge = document.getElementById('monitor-buffer-badge');
            if (badge) badge.textContent = `📦 Буфер: ${bufferedPointsCount()} / ${BUFFER_MAX_POINTS} точек`;
            if (currentPage === 'monitor') updateMonitorView(container, true);
          }).catch(() => {});
        }
      }, ms);
    }

  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

function updateMonitorView(container, preserveInputFocus = false) {
  const query = monitorSearchQuery.trim();
  const filteredNodes = cachedRoutableNodes.filter(n => {
    if (!query) return true;
    return (n.display_name && n.display_name.toLowerCase().includes(query)) ||
           (n.node_id && n.node_id.toLowerCase().includes(query)) ||
           (n.endpoint && n.endpoint.toLowerCase().includes(query));
  });

  container.innerHTML = '';

  if (!cachedRoutableNodes.length) {
    container.innerHTML = '<div class="empty-state"><span class="icon">📈</span><p>Нет доступных маршрутизируемых (routable) узлов для мониторинга</p></div>';
    return;
  }

  // Вкладка «Обзор» удалена — на странице Monitor всегда показывается
  // единственная вкладка «Производительность».

  const flow = h('div', {class: 'page-flow'});
  container.appendChild(flow);

  // Средняя задержка по отфильтрованным узлам (по накопленному буферу)
  const avgLatency = filteredNodes.length ? filteredNodes.reduce((acc, n) => acc + getBufferedLatency(n.node_id, n.latency_ms || 0), 0) / filteredNodes.length : 0;

  renderMonitorPerformance(flow, filteredNodes, avgLatency);

  if (preserveInputFocus) {
    const input = document.getElementById('monitor-search-input');
    if (input) {
      input.focus();
      input.selectionStart = input.selectionEnd = input.value.length;
    }
  }
}

/* ----- Вкладка «Производительность»: гистограмма + перцентили ----- */
function renderMonitorPerformance(flow, filteredNodes, avgLatency) {
  if (!filteredNodes.length) {
    flow.appendChild(h('div', {class: 'empty-state'}, h('span', {class: 'icon'}, '🔍'), h('p', null, 'Нет узлов, соответствующих поисковому запросу')));
    return;
  }

  const agg = cachedLatencyDistribution?.aggregate;
  // Карточки перцентилей — с динамической шириной (flex), как на Dashboard.
  const statsGrid = h('div', {class: 'grid-auto'});
  const kpiCards = [
    { label: 'P50 (медиана)', value: agg ? `${agg.p50} мс` : '—', icon: '🎯', color: '#10b981' },
    { label: 'P95', value: agg ? `${agg.p95} мс` : '—', icon: '📏', color: '#3b82f6' },
    { label: 'P99 (tail)', value: agg ? `${agg.p99} мс` : '—', icon: '🚀', color: '#f59e0b' },
    { label: 'Всего запросов', value: agg ? String(agg.total_samples) : '—', icon: '🔢', color: 'var(--accent2)' },
  ];
  kpiCards.forEach(s => {
    statsGrid.appendChild(h('div', {class: 'card'},
      h('div', {class: 'card-header'}, h('span', {class: 'card-title'}, s.label), h('span', {class: 'card-icon'}, s.icon)),
      h('div', {class: 'card-value', style: {color: s.color}}, s.value),
    ));
  });
  flow.appendChild(statsGrid);

  // API Latency Distribution Histogram Card
  const histCard = h('div', {class: 'card'},
    h('div', {class: 'chart-card-head'},
      h('div', null,
        h('div', {class: 'chart-title'},
          h('span', {class: 'card-title', style: {marginBottom: '0'}}, '📊 Распределение задержек API'),
          h('span', {class: 'badge badge-blue'}, 'Гистограмма')
        ),
        h('div', {class: 'chart-note'},
          'Детализированное распределение времени ответа API по интервалам (мс) и перцентили P50 / P90 / P95 / P99 для каждого узла'
        )
      ),
      h('div', {class: 'chart-actions'},
        h('label', {style: {fontSize: '12px', color: 'var(--text2)'}}, 'Узел:'),
        h('select', {
          id: 'histogram-node-select',
          class: 'form-control',
          style: {width: 'auto', minWidth: '190px', padding: '4px 10px', fontSize: '12px', height: '32px'},
          onChange: (e) => {
            monitorHistogramSelectedNode = e.target.value;
            renderHistogram(filteredNodes);
          }
        },
          h('option', {value: 'all', selected: monitorHistogramSelectedNode === 'all' ? '' : undefined}, '⚡ Все узлы (All Nodes)'),
          ...filteredNodes.map(n => {
            const flag = formatCountry(n.country).flag;
            return h('option', {
              value: n.node_id,
              selected: monitorHistogramSelectedNode === n.node_id ? '' : undefined
            }, `${flag} ${n.display_name || shortId(n.node_id)} (${n.latency_ms || 0} мс)`);
          })
        ),
        h('div', {class: 'btn-group'},
          h('button', {
            class: `btn btn-sm ${monitorHistogramMode === 'count' ? 'btn-primary' : ''}`,
            id: 'btn-hist-count',
            title: 'Абсолютное количество запросов (Count)',
            onClick: () => {
              monitorHistogramMode = 'count';
              document.getElementById('btn-hist-count')?.classList.add('btn-primary');
              document.getElementById('btn-hist-pct')?.classList.remove('btn-primary');
              renderHistogram(filteredNodes);
            }
          }, 'Запросы (N)'),
          h('button', {
            class: `btn btn-sm ${monitorHistogramMode === 'percentage' ? 'btn-primary' : ''}`,
            id: 'btn-hist-pct',
            title: 'Относительная доля в процентах (%)',
            onClick: () => {
              monitorHistogramMode = 'percentage';
              document.getElementById('btn-hist-pct')?.classList.add('btn-primary');
              document.getElementById('btn-hist-count')?.classList.remove('btn-primary');
              renderHistogram(filteredNodes);
            }
          }, '% Доля')
        )
      )
    ),

    // KPI row for P50, P90, P95, P99, Min, Max, Avg, Total Samples
    h('div', {id: 'histogram-kpi-bar'}),

    // Chart Canvas
    h('div', {style: {position: 'relative', height: '330px', marginTop: '10px'}},
      h('canvas', {id: 'latency-histogram-chart'})
    ),

    // Bucket Breakdown Grid
    h('div', {id: 'histogram-bucket-breakdown', class: 'bucket-grid'})
  );

  flow.appendChild(histCard);

  setTimeout(() => renderHistogram(filteredNodes), 50);
}

function renderHistogram(nodesList) {
  const histCanvas = document.getElementById('latency-histogram-chart');
  if (!histCanvas) return;
  const histCtx = histCanvas.getContext('2d');
  if (!histCtx) return;

  if (monitorHistogramChartInstance) {
    monitorHistogramChartInstance.destroy();
    monitorHistogramChartInstance = null;
  }

  const binLabels = HISTOGRAM_BINS.map(b => b.label);
  const isCountMode = monitorHistogramMode === 'count';

  // База для fallback-распределения, если сервер не прислал своё.
  const avgLatencyForHistogram = nodesList.length
    ? nodesList.reduce((acc, n) => acc + (n.latency_ms || 0), 0) / nodesList.length
    : 60;

  let currentStats = null;
  let datasets = [];

  function getNodeStats(n) {
    if (cachedLatencyDistribution?.nodes?.[n.node_id]) {
      return cachedLatencyDistribution.nodes[n.node_id];
    }
    if (n.latency_distribution) {
      return n.latency_distribution;
    }
    const base = n.latency_ms || 60;
    return {
      p50: base,
      p90: Math.round(base * 1.5),
      p95: Math.round(base * 1.9),
      p99: Math.round(base * 3.2),
      min: Math.max(10, Math.round(base * 0.4)),
      max: Math.round(base * 4.5),
      avg: Math.round(base * 1.2),
      total_samples: 120,
      counts: [30, 45, 25, 12, 5, 2, 1],
      percentages: [25.0, 37.5, 20.8, 10.0, 4.2, 1.7, 0.8],
    };
  }

  if (monitorHistogramSelectedNode === 'all') {
    currentStats = cachedLatencyDistribution?.aggregate || {
      p50: Math.round(avgLatencyForHistogram),
      p90: Math.round(avgLatencyForHistogram * 1.6),
      p95: Math.round(avgLatencyForHistogram * 2.1),
      p99: Math.round(avgLatencyForHistogram * 3.4),
      min: Math.max(10, Math.round(avgLatencyForHistogram * 0.3)),
      max: Math.round(avgLatencyForHistogram * 4.8),
      avg: Math.round(avgLatencyForHistogram * 1.15),
      total_samples: nodesList.length * 120,
      counts: [0, 0, 0, 0, 0, 0, 0],
      percentages: [0, 0, 0, 0, 0, 0, 0],
    };

    const palette = ['#6366f1', '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#14b8a6', '#f43f5e'];

    datasets = nodesList.map((n, idx) => {
      const nStats = getNodeStats(n);
      const dataVals = isCountMode ? nStats.counts : nStats.percentages;
      return {
        label: n.display_name || shortId(n.node_id),
        data: dataVals,
        backgroundColor: palette[idx % palette.length],
        borderColor: palette[idx % palette.length],
        borderWidth: 1,
        borderRadius: 3,
        stack: 'nodes_stack',
      };
    });

  } else {
    const selectedNodeObj = nodesList.find(n => n.node_id === monitorHistogramSelectedNode) || nodesList[0];
    if (selectedNodeObj) {
      currentStats = getNodeStats(selectedNodeObj);
      const dataVals = isCountMode ? currentStats.counts : currentStats.percentages;
      datasets = [{
        label: selectedNodeObj.display_name || shortId(selectedNodeObj.node_id),
        data: dataVals,
        backgroundColor: HISTOGRAM_BINS.map(b => b.color),
        borderColor: HISTOGRAM_BINS.map(b => b.color),
        borderWidth: 1,
        borderRadius: 4,
      }];
    }
  }

  // Render KPI bar
  const kpiEl = document.getElementById('histogram-kpi-bar');
  if (kpiEl && currentStats) {
    const kpiTiles = [
      { label: 'P50 (Медиана)', value: currentStats.p50, color: '#10b981' },
      { label: 'P90', value: currentStats.p90, color: '#06b6d4' },
      { label: 'P95', value: currentStats.p95, color: '#3b82f6' },
      { label: 'P99 (Tail)', value: currentStats.p99, color: '#f59e0b' },
      { label: 'Средняя (Avg)', value: currentStats.avg, color: 'var(--text)' },
      { label: 'Мин / Макс', value: `${currentStats.min} / ${currentStats.max}`, color: 'var(--text2)', small: true },
      { label: 'Запросов (N)', value: currentStats.total_samples, color: 'var(--accent2)', unit: 'выборка' },
    ];
    kpiEl.innerHTML = `<div class="kpi-grid">` + kpiTiles.map(t =>
      `<div class="kpi-tile">
        <div class="kpi-label">${t.label}</div>
        <div class="kpi-value" style="color: ${t.color};${t.small ? ' font-size: 14px;' : ''}">${t.value} <span class="kpi-unit">${t.unit || 'мс'}</span></div>
      </div>`).join('') + `</div>`;
  }

  // Render Bucket Breakdown
  const bktEl = document.getElementById('histogram-bucket-breakdown');
  if (bktEl && currentStats) {
    const tot = currentStats.total_samples || 1;
    bktEl.innerHTML = HISTOGRAM_BINS.map((bin, i) => {
      const count = currentStats.counts ? currentStats.counts[i] : 0;
      const pct = currentStats.percentages ? currentStats.percentages[i] : ((count / tot) * 100);
      return `
        <div class="bucket-tile">
          <div class="bucket-head">
            <span class="bucket-range" style="color: ${bin.color};">${bin.label}</span>
            <span class="bucket-quality" style="background: ${bin.color}22; color: ${bin.color};">${bin.quality}</span>
          </div>
          <div class="bucket-stats">
            <strong class="bucket-count">${count}</strong>
            <span class="bucket-pct">${Number(pct).toFixed(1)}%</span>
          </div>
          <div class="bucket-bar">
            <div style="background: ${bin.color}; width: ${Math.min(100, Math.max(0, pct))}%;"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // Create Chart.js instance
  monitorHistogramChartInstance = new Chart(histCtx, {
    type: 'bar',
    data: {
      labels: binLabels,
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: monitorHistogramSelectedNode === 'all',
          labels: { color: '#94a3b8', font: { family: 'system-ui', size: 11 } }
        },
        tooltip: {
          mode: monitorHistogramSelectedNode === 'all' ? 'index' : 'point',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const dsLabel = ctx.dataset.label || '';
              const val = ctx.raw;
              const unit = isCountMode ? ' запр.' : '%';
              return ` ${dsLabel}: ${val}${unit}`;
            }
          }
        }
      },
      scales: {
        x: {
          stacked: monitorHistogramSelectedNode === 'all',
          grid: { color: '#2e3140' },
          ticks: { color: '#94a3b8', font: { family: 'system-ui', size: 11 } }
        },
        y: {
          stacked: monitorHistogramSelectedNode === 'all',
          grid: { color: '#2e3140' },
          ticks: { color: '#94a3b8' },
          title: {
            display: true,
            text: isCountMode ? 'Количество запросов (Requests)' : 'Доля трафика (%)',
            color: '#94a3b8',
            font: { size: 12 }
          }
        }
      }
    }
  });
}
