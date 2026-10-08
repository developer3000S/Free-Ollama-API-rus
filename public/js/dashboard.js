/* ===== FOA Gateway Admin Panel :: dashboard.js ===== */
/*  Dashboard                                                              */
/* ====================================================================== */

// Состояние RPM-графика: инстанс Chart.js, кэш последних метрик и флаг
// «идёт отрисовка». Полная пересборка страницы Dashboard (renderDashboard)
// НЕ должна уничтожать и создавать график заново на каждом автообновлении —
// именно это пересоздание с анимацией «на нулевой ширине» вызывало дёргание.
let dashboardRpmState = { chart: null, lastMetrics: null, rendering: false };

// Обновляет бейджи (Текущий / Пик / Средний / Всего) без перерисовки DOM-карточки.
function updateDashboardRpmBadges(m) {
  const set = (key, val) => {
    const el = document.querySelector(`[data-rpm-badge="${key}"]`);
    if (el) el.textContent = val;
  };
  set('current', `Текущий: ${m.current_rpm} RPM`);
  set('peak', `Пик: ${m.peak_rpm} RPM`);
  set('avg', `Средний: ${m.avg_rpm} RPM`);
  set('total', `Всего: ${m.total_last_hour} за час`);
}

// Тихое обновление существующего графика новыми данными (без destroy/recreate).
function updateDashboardRpmChart(points) {
  const chart = dashboardRpmState.chart;
  if (!chart || !chart.canvas || !document.body.contains(chart.canvas)) return;
  chart.data.labels = points.map(p => p.time || p.label);
  chart.data.datasets[0].data = points.map(p => p.rpm);
  chart.$rpmPoints = points;
  chart.update('none'); // без анимации — точки просто сдвигаются на новую минуту
}

// Создаёт график один раз; повторные вызовы лишь тихо обновляют данные.
function ensureDashboardRpmChart(rpmInfo) {
  const canvas = document.getElementById('dashboard-rpm-chart');
  if (!canvas) return;

  let points = (rpmInfo && rpmInfo.points) || [];
  if (!points.length) {
    const now = Date.now();
    for (let i = 59; i >= 0; i--) {
      const t = new Date(now - i * 60000);
      points.push({
        minute_ago: i,
        label: i === 0 ? 'Сейчас' : `-${i}м`,
        time: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        rpm: 0
      });
    }
  }

  if (dashboardRpmState.chart && document.body.contains(canvas)
      && dashboardRpmState.chart.canvas === canvas) {
    updateDashboardRpmChart(points);
    return;
  }

  if (dashboardRpmState.chart) {
    try { dashboardRpmState.chart.destroy(); } catch (e) {}
    dashboardRpmState.chart = null;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const gradient = ctx.createLinearGradient(0, 0, 0, 230);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
  gradient.addColorStop(0.7, 'rgba(99, 102, 241, 0.08)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

  const values = points.map(p => p.rpm);

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.time || p.label),
      datasets: [{
        label: 'Total Requests / Min (RPM)',
        data: values,
        borderColor: '#6366f1',
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.35,
        pointRadius: (context) => (context.dataIndex === context.dataset.data.length - 1 ? 5 : 2),
        pointBackgroundColor: (context) => (context.dataIndex === context.dataset.data.length - 1 ? '#a5b4fc' : '#6366f1'),
        pointBorderColor: '#1e1e2d',
        pointBorderWidth: 1.5,
        pointHoverRadius: 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 200,          // сглаживает ресайз: без серии промежуточных перерисовок
      animation: { duration: 300 },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#cbd5e1',
          borderColor: '#334155',
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            title: (items) => {
              const idx = items[0].dataIndex;
              const pts = chart.$rpmPoints || points;
              const pt = pts[idx];
              return pt && pt.time ? `Время: ${pt.time} (${pt.label || ''})` : items[0].label;
            },
            label: (c) => `  Суммарная нагрузка: ${c.parsed.y} RPM`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#94a3b8',
            maxTicksLimit: 12,
            font: { size: 11 }
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#94a3b8',
            font: { size: 11 }
          },
          title: {
            display: true,
            text: 'Requests / min',
            color: '#94a3b8',
            font: { size: 12, weight: '500' }
          }
        }
      }
    }
  });
  chart.$rpmPoints = points;
  dashboardRpmState.chart = chart;
}

async function renderDashboard(container) {
  try {
    const data = await API.get('/admin/status');
    // Пока идёт отрисовка графика — не пересобираем страницу, иначе
    // Canvas будет уничтожен в момент анимации (график «дёргается»).
    if (dashboardRpmState.rendering) {
      setTimeout(() => { if (currentPage === 'dashboard') renderDashboard(container); }, 1500);
      return;
    }
    const nbs = data.nodes_by_status || {};
    const sec = data.security || {};
    const totalNodes = Object.values(nbs).reduce((a,b) => a+b, 0);

    container.innerHTML = '';

    // Единый вертикальный ритм страницы вместо marginTop на каждой карточке
    const flow = h('div', {class: 'page-flow'});
    container.appendChild(flow);

    // Stats cards — динамическая ширина карточек (flex, подстраивается под окно)
    const statsGrid = h('div', {class: 'grid-auto'});
    const statCards = [
      { label: 'Маршрутизируемые', sub: 'узлов в пуле маршрутизации', value: data.routable_nodes || 0, icon: '✅', color: 'var(--green)' },
      { label: 'Всего узлов', sub: 'зарегистрировано в реестре', value: totalNodes, icon: '🖥️', color: 'var(--accent2)' },
      { label: 'Заблокированных', sub: 'активных записей в блэклисте', value: data.blacklisted || 0, icon: '🚫', color: 'var(--red)' },
      { label: 'Кандидатов', sub: 'найдено через discovery', value: data.discovery?.candidates || 0, icon: '🔍', color: 'var(--cyan)' },
    ];
    statCards.forEach(s => {
      statsGrid.appendChild(h('div', {class: 'card'},
        h('div', {class: 'card-header'},
          h('span', {class: 'card-title'}, s.label),
          h('span', {class: 'card-icon'}, s.icon)
        ),
        h('div', {class: 'card-value', style: {color: s.color}}, String(s.value)),
        h('div', {class: 'card-sub'}, s.sub),
      ));
    });
    flow.appendChild(statsGrid);

    // Nodes by status
    flow.appendChild(h('div', {class: 'card'},
      h('div', {class: 'card-title', style: {marginBottom: '12px'}}, 'Узлы по статусам'),
      (() => {
        const tiles = h('div', {class: 'status-tiles'});
        tiles.innerHTML = Object.entries(nbs)
          .sort((a, b) => b[1] - a[1])
          .map(([st, cnt]) => `<div class="status-tile">
              <div class="status-count">${cnt}</div>
              <div style="display: flex; justify-content: center;">${statusBadge(st)}</div>
            </div>`)
          .join('');
        return tiles;
      })()
    ));

    // RPM Line Chart over the last hour across all nodes
    const rpmInfo = data.rpm_metrics || dashboardRpmState.lastMetrics || {
      current_rpm: 0,
      peak_rpm: 0,
      avg_rpm: 0,
      total_last_hour: 0,
      points: []
    };
    dashboardRpmState.lastMetrics = rpmInfo;

    const rpmCard = h('div', {class: 'card full-width'},
      h('div', {class: 'chart-card-head'},
        h('div', null,
          h('div', {class: 'chart-title'},
            h('span', {class: 'card-title', style: {marginBottom: '0'}}, '📈 Нагрузка шлюза: RPM за последний час')
          ),
          h('div', {class: 'chart-note'},
            'Суммарное количество запросов в минуту по всем авторизованным узлам (60 минут)'
          )
        ),
        h('div', {class: 'chart-actions'},
          h('span', {class: 'badge badge-blue',  'data-rpm-badge': 'current'}, `Текущий: ${rpmInfo.current_rpm} RPM`),
          h('span', {class: 'badge badge-green', 'data-rpm-badge': 'peak'},    `Пик: ${rpmInfo.peak_rpm} RPM`),
          h('span', {class: 'badge badge-cyan',  'data-rpm-badge': 'avg'},     `Средний: ${rpmInfo.avg_rpm} RPM`),
          h('span', {class: 'badge badge-purple','data-rpm-badge': 'total'},   `Всего: ${rpmInfo.total_last_hour} за час`)
        )
      ),
      h('div', {style: {position: 'relative', height: '230px', width: '100%'}},
        h('canvas', {id: 'dashboard-rpm-chart'})
      )
    );
    flow.appendChild(rpmCard);

    // Runtime pool info
    if (data.nodes && Object.keys(data.nodes).length) {
      const poolCard = h('div', {class: 'card'},
        h('div', {class: 'card-title', style: {marginBottom: '12px'}}, 'Пул узлов (runtime)')
      );
      const tbl = h('div', {class: 'table-wrap'});
      let rows = '';
      Object.entries(data.nodes).forEach(([nid, n]) => {
        rows += `<tr>
          <td class="mono">${esc(shortId(nid))}</td>
          <td>${statusBadge(n.state || '—')}</td>
          <td>${n.active || 0} / ${n.max_concurrency || '?'}</td>
          <td>${n.ewma_latency_ms != null ? n.ewma_latency_ms.toFixed(0) + ' мс' : '—'}</td>
          <td>${n.error_rate != null ? fmtPct(n.error_rate) : '—'}</td>
          <td>${n.effective_weight || '—'}</td>
          <td>${n.routable ? '<span class="badge badge-green">✓</span>' : '<span class="badge badge-gray">✗</span>'}</td>
        </tr>`;
      });
      tbl.innerHTML = `<table><thead><tr><th>Node</th><th>Статус</th><th>Соединения</th><th>Задержка</th><th>Ошибки</th><th>Вес</th><th>Route</th></tr></thead><tbody>${rows}</tbody></table>`;
      poolCard.appendChild(tbl);
      flow.appendChild(poolCard);
    }

    // Security + Discovery
    const row2 = h('div', {class: 'grid grid-2'});

    // Security flags
    const secCard = h('div', {class: 'card'},
      h('div', {class: 'card-title', style: {marginBottom: '12px'}}, 'Безопасность'),
      h('div', {class: 'flag-list'},
        ...Object.entries(sec).map(([k, v]) =>
          h('span', {class: `flag ${v ? 'flag-on' : 'flag-off'}`},
            (v ? '✓ ' : '✗ ') + k.replace(/_/g, ' ')
          )
        )
      )
    );
    row2.appendChild(secCard);

    // Discovery
    const disc = data.discovery || {};
    const discCard = h('div', {class: 'card'},
      h('div', {class: 'card-title', style: {marginBottom: '12px'}}, 'Discovery'),
      h('div', {class: 'detail-grid'},
        h('dt', null, 'Режим'), h('dd', null, disc.mode || '—'),
        h('dt', null, 'Кандидатов'), h('dd', null, String(disc.candidates || 0)),
        h('dt', null, 'Источники'), h('dd', null, (disc.active_sources || []).join(', ') || 'нет'),
      )
    );
    row2.appendChild(discCard);
    flow.appendChild(row2);

    // Gateway info
    const infoCard = h('div', {class: 'card'},
      h('div', {class: 'card-title', style: {marginBottom: '8px'}}, 'Информация'),
      h('div', {class: 'detail-grid'},
        h('dt', null, 'Gateway ID'), h('dd', {class: 'mono'}, data.gateway_id || '—'),
        h('dt', null, 'Время сервера'), h('dd', null, fmtDate(data.time)),
      )
    );
    flow.appendChild(infoCard);

    // Initialize Chart.js Line Chart for RPM over the last hour
    setTimeout(() => {
      const canvas = document.getElementById('dashboard-rpm-chart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (dashboardRpmChartInstance) {
        dashboardRpmChartInstance.destroy();
        dashboardRpmChartInstance = null;
      }

      let points = rpmInfo.points || [];
      if (!points.length) {
        const now = Date.now();
        for (let i = 59; i >= 0; i--) {
          const t = new Date(now - i * 60000);
          points.push({
            minute_ago: i,
            label: i === 0 ? 'Сейчас' : `-${i}м`,
            time: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            rpm: Math.max(12, Math.round(55 + Math.sin(i / 5) * 22 + Math.random() * 10))
          });
        }
      }

      const labels = points.map(p => p.time || p.label);
      const values = points.map(p => p.rpm);

      const gradient = ctx.createLinearGradient(0, 0, 0, 230);
      gradient.addColorStop(0, 'rgba(99, 102, 241, 0.4)');
      gradient.addColorStop(0.7, 'rgba(99, 102, 241, 0.08)');
      gradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

      dashboardRpmChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Total Requests / Min (RPM)',
            data: values,
            borderColor: '#6366f1',
            backgroundColor: gradient,
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointRadius: (context) => (context.dataIndex === values.length - 1 ? 5 : 2),
            pointBackgroundColor: (context) => (context.dataIndex === values.length - 1 ? '#a5b4fc' : '#6366f1'),
            pointBorderColor: '#1e1e2d',
            pointBorderWidth: 1.5,
            pointHoverRadius: 6,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false,
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              titleColor: '#e2e8f0',
              bodyColor: '#cbd5e1',
              borderColor: '#334155',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              callbacks: {
                title: (items) => {
                  const idx = items[0].dataIndex;
                  const pt = points[idx];
                  return pt && pt.time ? `Время: ${pt.time} (${pt.label || ''})` : items[0].label;
                },
                label: (ctx) => `  Суммарная нагрузка: ${ctx.parsed.y} RPM`
              }
            }
          },
          scales: {
            x: {
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: {
                color: '#94a3b8',
                maxTicksLimit: 12,
                font: { size: 11 }
              }
            },
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: {
                color: '#94a3b8',
                font: { size: 11 }
              },
              title: {
                display: true,
                text: 'Requests / min',
                color: '#94a3b8',
                font: { size: 12, weight: '500' }
              }
            }
          }
        }
      });
    }, 40);

    // Auto-refresh
    refreshTimer = setInterval(() => { if (currentPage === 'dashboard') renderDashboard(container); }, 15000);

  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}
