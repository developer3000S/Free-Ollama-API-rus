/* ===== FOA Gateway Admin Panel :: nodes.js ===== */
/* ====================================================================== */
/*  Nodes                                                                  */
/* ====================================================================== */
let nodesSort = { col: 'node_id', dir: 'asc' };
let currentNodesList = [];
let selectedNodes = new Set();
let nodesViewMode = 'table'; // 'table' or 'map' or 'performance'
let nodesMapInstance = null;
let nodesMapFilter = 'all'; // 'all' | 'healthy' | 'degraded' | 'unhealthy'
let nodesGroupBy = 'none'; // 'none' | 'country' | 'owner_id'
let collapsedGroups = new Set();

const countryDirectory = {
  US: { flag: '🇺🇸', name: 'США' },
  DE: { flag: '🇩🇪', name: 'Германия' },
  JP: { flag: '🇯🇵', name: 'Япония' },
  SG: { flag: '🇸🇬', name: 'Сингапур' },
  FR: { flag: '🇫🇷', name: 'Франция' },
  NL: { flag: '🇳🇱', name: 'Нидерланды' },
  GB: { flag: '🇬🇧', name: 'Великобритания' },
  CA: { flag: '🇨🇦', name: 'Канада' },
  AU: { flag: '🇦🇺', name: 'Австралия' },
  BR: { flag: '🇧🇷', name: 'Бразилия' },
  RU: { flag: '🇷🇺', name: 'Россия' },
  CH: { flag: '🇨🇭', name: 'Швейцария' },
  SE: { flag: '🇸🇪', name: 'Швеция' },
  FI: { flag: '🇫🇮', name: 'Финляндия' },
  IN: { flag: '🇮🇳', name: 'Индия' },
  KR: { flag: '🇰🇷', name: 'Южная Корея' },
  OTHER: { flag: '🌐', name: 'Другие страны' },
};

function formatCountry(code) {
  if (!code) return { flag: '🌐', name: 'Не указана', code: '—', simpleName: 'Не указана' };
  const c = String(code).toUpperCase();
  const item = countryDirectory[c] || { flag: '🌐', name: c, simpleName: c };
  return { flag: item.flag, name: `${item.name} (${c})`, code: c, simpleName: item.name };
}

function pluralizeNodes(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 19) return 'узлов';
  if (mod10 === 1) return 'узел';
  if (mod10 >= 2 && mod10 <= 4) return 'узла';
  return 'узлов';
}

function updateBulkToolbar() {
  let toolbar = document.getElementById('bulk-toolbar');
  if (selectedNodes.size === 0) {
    if (toolbar) toolbar.remove();
    return;
  }
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'bulk-toolbar';
    toolbar.className = 'bulk-toolbar';
    document.body.appendChild(toolbar);
  }
  toolbar.innerHTML = `
    <span>Выбрано: <strong>${selectedNodes.size}</strong></span>
    <div style="display: flex; gap: 6px; flex-wrap: wrap;">
      <button class="btn btn-sm" onclick="exportNodesCsv(true)" title="Экспорт выбранных узлов в формате CSV">📥 Export CSV (${selectedNodes.size})</button>
      <button class="btn btn-sm btn-success" onclick="bulkAction('auto-verify')" title="Автоматическая верификация и включение в пул">⚡ Авто-верификация</button>
      <button class="btn btn-sm btn-primary" onclick="bulkAction('manual-verify')" title="Ручное подтверждение верификации (согласовано)">✓ Ручная верификация</button>
      <button class="btn btn-sm" onclick="bulkAction('health-check')">🩺 Health Check</button>
      <button class="btn btn-sm btn-danger" onclick="bulkAction('revoke')">⛔ Revoke</button>
      <button class="btn btn-sm btn-danger" onclick="bulkAction('blacklist')">🚫 Blacklist</button>
      <button class="btn btn-sm btn-danger" onclick="bulkAction('delete')">🗑 Удалить</button>
      <button class="btn btn-sm" onclick="clearNodeSelection()">✕ Снять выбор</button>
    </div>
  `;
}

function clearNodeSelection() {
  selectedNodes.clear();
  const tbl = document.querySelector('.table-wrap table')?.closest('.table-wrap');
  if (tbl) updateNodesTable(tbl);
  updateBulkToolbar();
}

async function bulkAction(action) {
  const ids = Array.from(selectedNodes);
  if (!ids.length) return;

  const nodeDetails = ids.map(id => {
    const nodeObj = (currentNodesList || []).find(n => n.node_id === id);
    return {
      id: id,
      name: nodeObj ? `${nodeObj.display_name || ''} (${nodeObj.endpoint || ''})` : ''
    };
  });

  const executeBulk = async () => {
    let success = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        if (action === 'delete') {
          await API.del(`/admin/nodes/${id}`);
        } else if (action === 'blacklist') {
          await API.post(`/admin/nodes/${id}/blacklist`, {reason: 'admin_bulk', duration: 'permanent'});
        } else {
          await API.post(`/admin/nodes/${id}/${action}`, {});
        }
        success++;
      } catch (e) {
        failed++;
      }
    }
    toast(`Выполнено: ${success}, ошибок: ${failed}`, failed > 0 ? 'error' : 'success');
    selectedNodes.clear();
    updateBulkToolbar();
    if (currentPage === 'nodes') renderNodes($('#content'));
  };

  if (action === 'revoke') {
    showConfirmModal({
      title: 'Подтверждение отзыва авторизации (Revoke)',
      icon: '⛔',
      message: `Вы уверены, что хотите отозвать авторизацию для <strong>${ids.length} ${pluralizeNodes(ids.length)}</strong>?<br><br>Узлы будут исключены из маршрутизации пользовательских запросов до повторного согласования владельцем.`,
      details: nodeDetails,
      confirmText: `Отозвать (${ids.length})`,
      confirmClass: 'btn-danger',
      onConfirm: executeBulk
    });
    return;
  }

  if (action === 'blacklist') {
    showConfirmModal({
      title: 'Подтверждение блокировки (Blacklist)',
      icon: '🚫',
      message: `Вы уверены, что хотите внести в чёрный список <strong>${ids.length} ${pluralizeNodes(ids.length)}</strong>?<br><br>Маршрутизация на них будет немедленно прекращена, а сетевые соединения разорваны.`,
      details: nodeDetails,
      confirmText: `Заблокировать (${ids.length})`,
      confirmClass: 'btn-danger',
      onConfirm: executeBulk
    });
    return;
  }

  if (action === 'delete') {
    showConfirmModal({
      title: 'Подтверждение удаления узлов',
      icon: '🗑',
      message: `<strong>Внимание: Это действие необратимо!</strong><br><br>Вы уверены, что хотите полностью удалить <strong>${ids.length} ${pluralizeNodes(ids.length)}</strong> из реестра шлюза?`,
      details: nodeDetails,
      confirmText: `Удалить (${ids.length})`,
      confirmClass: 'btn-danger',
      onConfirm: executeBulk
    });
    return;
  }

  if (action === 'auto-verify') {
    showConfirmModal({
      title: 'Автоматическая верификация узлов',
      icon: '⚡',
      message: `Выполнить автоматическую верификацию и включить в маршрутизацию выбранные узлы (<strong>${ids.length} ${pluralizeNodes(ids.length)}</strong>)?`,
      details: nodeDetails,
      confirmText: `Верифицировать (${ids.length})`,
      confirmClass: 'btn-success',
      onConfirm: async () => {
        try {
          const res = await API.post('/admin/nodes/bulk-verify', { node_ids: ids, mode: 'auto', method: 'auto_domain_agreement' });
          toast(`⚡ Авто-верифицировано и включено в маршрутизацию: ${res.count || ids.length}`, 'success');
          selectedNodes.clear();
          updateBulkToolbar();
          if (currentPage === 'nodes') renderNodes($('#content'));
        } catch (e) { toast(e.message, 'error'); }
      }
    });
    return;
  }

  if (action === 'manual-verify') {
    showConfirmModal({
      title: 'Ручная верификация узлов',
      icon: '✓',
      message: `Подтвердить ручную верификацию для выбранных узлов (<strong>${ids.length} ${pluralizeNodes(ids.length)}</strong>)?`,
      details: nodeDetails,
      confirmText: `Подтвердить (${ids.length})`,
      confirmClass: 'btn-primary',
      onConfirm: async () => {
        try {
          const res = await API.post('/admin/nodes/bulk-verify', { node_ids: ids, mode: 'manual', method: 'manual_admin' });
          toast(`✓ Ручная верификация подтверждена для: ${res.count || ids.length} узлов`, 'success');
          selectedNodes.clear();
          updateBulkToolbar();
          if (currentPage === 'nodes') renderNodes($('#content'));
        } catch (e) { toast(e.message, 'error'); }
      }
    });
    return;
  }

  // Health-check or other bulk actions
  await executeBulk();
}

function sortNodes(list, col, dir) {
  return [...list].sort((a, b) => {
    let va = a[col];
    let vb = b[col];
    if (col === 'country') {
      va = a.country || 'ZZ';
      vb = b.country || 'ZZ';
    } else if (col === 'owner_id') {
      va = a.owner_id || '';
      vb = b.owner_id || '';
    } else if (col === 'models') {
      va = (a.models || []).length;
      vb = (b.models || []).length;
    } else if (col === 'active_connections') {
      va = a.active_connections || 0;
      vb = b.active_connections || 0;
    } else if (col === 'latency_ms') {
      va = a.latency_ms != null ? a.latency_ms : -1;
      vb = b.latency_ms != null ? b.latency_ms : -1;
    } else if (col === 'error_rate') {
      va = a.error_rate != null ? a.error_rate : -1;
      vb = b.error_rate != null ? b.error_rate : -1;
    } else if (col === 'routable') {
      va = a.routable ? 1 : 0;
      vb = b.routable ? 1 : 0;
    }
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') {
      return dir === 'asc' ? va - vb : vb - va;
    }
    const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    return dir === 'asc' ? cmp : -cmp;
  });
}

function getOrderedViewNodes() {
  if (nodesGroupBy === 'none') {
    return sortNodes(currentNodesList, nodesSort.col, nodesSort.dir).map(n => ({
      ...n,
      _group: '—'
    }));
  }

  // Partition nodes into groups matching table view
  const groupsMap = new Map();
  currentNodesList.forEach(n => {
    let gKey = '';
    if (nodesGroupBy === 'country') {
      gKey = (n.country || 'OTHER').toUpperCase();
    } else if (nodesGroupBy === 'owner_id') {
      gKey = n.owner_id || 'unassigned';
    }
    if (!groupsMap.has(gKey)) groupsMap.set(gKey, []);
    groupsMap.get(gKey).push(n);
  });

  const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
    if (nodesGroupBy === 'country') {
      const nameA = formatCountry(a).simpleName || a;
      const nameB = formatCountry(b).simpleName || b;
      return nameA.localeCompare(nameB, 'ru');
    }
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });

  const result = [];
  sortedGroupKeys.forEach(gKey => {
    const gNodes = groupsMap.get(gKey);
    const sortedGNodes = sortNodes(gNodes, nodesSort.col, nodesSort.dir);
    const groupName = nodesGroupBy === 'country' ? formatCountry(gKey).name : gKey;
    sortedGNodes.forEach(n => {
      result.push({
        ...n,
        _group: groupName
      });
    });
  });
  return result;
}

function exportNodesCsv(onlySelected = false) {
  let nodesToExport = [];
  if (onlySelected && selectedNodes.size > 0) {
    const subset = currentNodesList.filter(n => selectedNodes.has(n.node_id));
    nodesToExport = sortNodes(subset, nodesSort.col, nodesSort.dir);
  } else {
    nodesToExport = getOrderedViewNodes();
  }

  if (!nodesToExport.length) {
    toast('Нет узлов для экспорта', 'error');
    return;
  }

  const columns = [
    ...(nodesGroupBy !== 'none' ? [{ label: 'Группа (Group)', key: '_group' }] : []),
    { label: 'Node ID', key: 'node_id' },
    { label: 'Имя (Display Name)', key: 'display_name' },
    { label: 'Страна (Country)', key: 'country' },
    { label: 'Owner ID', key: 'owner_id' },
    { label: 'Endpoint', key: 'endpoint' },
    { label: 'Статус (Status)', key: 'status' },
    { label: 'Согласие (Consent)', key: 'consent_status' },
    { label: 'Модели (Models)', key: 'models', format: v => (Array.isArray(v) ? v.join(', ') : (v || '')) },
    { label: 'Активные соединения', key: 'active_connections' },
    { label: 'Max Concurrency', key: 'max_concurrency' },
    { label: 'Задержка (мс)', key: 'latency_ms', format: v => (v != null ? Number(v).toFixed(0) : '') },
    { label: 'Ошибки (%)', key: 'error_rate', format: v => (v != null ? (Number(v) * 100).toFixed(1) + '%' : '') },
    { label: 'Маршрутизация (Routable)', key: 'routable', format: v => (v ? 'true' : 'false') },
    { label: 'Создан (Created At)', key: 'created_at', format: v => (v ? fmtDate(v) : '') },
    { label: 'Обновлен (Updated At)', key: 'updated_at', format: v => (v ? fmtDate(v) : '') },
  ];

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `nodes_export_${dateStr}.csv`;
  exportToCsv(filename, columns, nodesToExport);
  toast(`Экспорт CSV завершён (узлов: ${nodesToExport.length})`, 'success');
}

function renderNodeRow(n, isChild = false, groupKey = '') {
  const isChecked = selectedNodes.has(n.node_id);
  const countryInfo = formatCountry(n.country);
  const labelsHtml = (n.labels || []).length 
    ? (n.labels || []).map(l => `<span class="badge badge-accent" style="margin-right:2px;font-size:10px;">${esc(l)}</span>`).join('')
    : '<span style="color:var(--text3);font-size:11px;">—</span>';

  return `<tr class="${isChild ? 'group-child-row' : ''}" data-id="${esc(n.node_id)}" data-group="${esc(groupKey)}">
    <td style="text-align: center;">
      <input type="checkbox" class="node-checkbox" data-id="${esc(n.node_id)}" data-group="${esc(groupKey)}" ${isChecked ? 'checked' : ''}>
    </td>
    <td>
      ${isChild ? '<span class="group-child-indent">├─</span>' : ''}
      <a href="#" class="mono node-link" data-id="${esc(n.node_id)}" style="font-weight: 600;">${esc(shortId(n.node_id))}</a>
    </td>
    <td>${esc(n.display_name || '—')}</td>
    <td>${labelsHtml}</td>
    <td>
      <span title="${esc(countryInfo.name)}" style="display: inline-flex; align-items: center; gap: 5px;">
        <span>${countryInfo.flag}</span>
        <span class="mono" style="font-size: 11px;">${esc(n.country || '—')}</span>
      </span>
    </td>
    <td>
      <span class="mono truncate" style="max-width: 140px; font-size: 11px; color: var(--accent2);" title="${esc(n.owner_id || '—')}">
        ${esc(n.owner_id || '—')}
      </span>
    </td>
    <td class="mono truncate" title="${esc(n.endpoint || '')}">${esc(n.endpoint || '—')}</td>
    <td>${statusBadge(n.status)}</td>
    <td>${statusBadge(n.consent_status)}</td>
    <td>${modelChips(n.models)}</td>
    <td>${n.active_connections}/${n.max_concurrency}</td>
    <td>${n.latency_ms != null ? n.latency_ms.toFixed(0) : '—'}</td>
    <td>${n.error_rate != null ? fmtPct(n.error_rate) : '—'}</td>
    <td>${n.routable ? '<span class="badge badge-green">✓</span>' : '<span class="badge badge-gray">✗</span>'}</td>
    <td>
      <div class="btn-group">
        <button class="btn btn-sm node-detail" data-id="${esc(n.node_id)}" title="Детали">📋</button>
        <button class="btn btn-sm node-labels" data-id="${esc(n.node_id)}" title="Метки">🏷️</button>
        <button class="btn btn-sm node-logs" data-id="${esc(n.node_id)}" title="Логи">📄</button>
        <button class="btn btn-sm btn-success node-verify" data-id="${esc(n.node_id)}" title="Verify">✓</button>
        <button class="btn btn-sm node-health" data-id="${esc(n.node_id)}" title="Health Check">🩺</button>
        <button class="btn btn-sm btn-danger node-del" data-id="${esc(n.node_id)}" title="Удалить">🗑</button>
      </div>
    </td>
  </tr>`;
}

function updateNodesTable(tbl) {
  tbl.querySelectorAll('th.sortable').forEach(th => {
    const col = th.dataset.col;
    const isSorted = nodesSort.col === col;
    th.classList.toggle('sorted', isSorted);
    const iconEl = th.querySelector('.sort-icon');
    if (iconEl) iconEl.textContent = isSorted ? (nodesSort.dir === 'asc' ? '▲' : '▼') : '↕';
  });
  const tbody = tbl.querySelector('tbody');
  if (!tbody) return;

  let rows = '';

  if (nodesGroupBy === 'none') {
    const sorted = sortNodes(currentNodesList, nodesSort.col, nodesSort.dir);
    sorted.forEach(n => {
      rows += renderNodeRow(n, false, '');
    });
  } else {
    // Partition nodes into groups
    const groupsMap = new Map();
    currentNodesList.forEach(n => {
      let gKey = '';
      if (nodesGroupBy === 'country') {
        gKey = (n.country || 'OTHER').toUpperCase();
      } else if (nodesGroupBy === 'owner_id') {
        gKey = n.owner_id || 'unassigned';
      }
      if (!groupsMap.has(gKey)) groupsMap.set(gKey, []);
      groupsMap.get(gKey).push(n);
    });

    // Sort group keys
    const sortedGroupKeys = Array.from(groupsMap.keys()).sort((a, b) => {
      if (nodesGroupBy === 'country') {
        const nameA = formatCountry(a).simpleName || a;
        const nameB = formatCountry(b).simpleName || b;
        return nameA.localeCompare(nameB, 'ru');
      }
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });

    sortedGroupKeys.forEach(gKey => {
      const gNodes = groupsMap.get(gKey);
      const isCollapsed = collapsedGroups.has(gKey);
      const sortedGNodes = sortNodes(gNodes, nodesSort.col, nodesSort.dir);

      const allGChecked = gNodes.length > 0 && gNodes.every(n => selectedNodes.has(n.node_id));
      const someGChecked = !allGChecked && gNodes.some(n => selectedNodes.has(n.node_id));

      let groupTitle = '';
      let groupIcon = '';
      if (nodesGroupBy === 'country') {
        const cInfo = formatCountry(gKey);
        groupIcon = cInfo.flag;
        groupTitle = cInfo.name;
      } else {
        groupIcon = '👤';
        groupTitle = gKey;
      }

      const routableCount = gNodes.filter(n => n.routable).length;
      const healthyCount = gNodes.filter(n => n.status === 'healthy').length;
      const avgLat = gNodes.length ? gNodes.reduce((acc, n) => acc + (n.latency_ms || 0), 0) / gNodes.length : 0;
      const avgErr = gNodes.length ? gNodes.reduce((acc, n) => acc + (n.error_rate || 0), 0) / gNodes.length : 0;

      rows += `<tr class="group-header-row" data-group="${esc(gKey)}">
        <td colspan="14">
          <div class="group-header-content">
            <div class="group-header-left">
              <input type="checkbox" class="group-checkbox" data-group="${esc(gKey)}" title="Выбрать все узлы группы" ${allGChecked ? 'checked' : ''} ${someGChecked ? 'data-indeterminate="true"' : ''}>
              <span class="group-toggle-icon">${isCollapsed ? '▶' : '▼'}</span>
              <span class="group-title">${groupIcon} <strong>${esc(groupTitle)}</strong></span>
              <span class="group-badge">${gNodes.length} ${pluralizeNodes(gNodes.length)}</span>
            </div>
            <div class="group-header-meta">
              <span>Активных: <strong style="color: var(--green);">${routableCount}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Здоровых: <strong style="color: var(--accent2);">${healthyCount}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Ср. задержка: <strong>${avgLat > 0 ? avgLat.toFixed(0) + ' мс' : '—'}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Ошибки: <strong>${(avgErr * 100).toFixed(1)}%</strong></span>
            </div>
          </div>
        </td>
      </tr>`;

      if (!isCollapsed) {
        sortedGNodes.forEach(n => {
          rows += renderNodeRow(n, true, gKey);
        });
      }
    });
  }

  tbody.innerHTML = rows;

  // Set indeterminate state on group checkboxes
  tbody.querySelectorAll('.group-checkbox[data-indeterminate="true"]').forEach(cb => {
    cb.indeterminate = true;
  });

  const allChecked = currentNodesList.length > 0 && currentNodesList.every(n => selectedNodes.has(n.node_id));
  const someChecked = !allChecked && currentNodesList.some(n => selectedNodes.has(n.node_id));
  const selectAllEl = tbl.querySelector('#select-all-nodes');
  if (selectAllEl) {
    selectAllEl.checked = allChecked;
    selectAllEl.indeterminate = someChecked;
  }
  updateBulkToolbar();
}

async function renderNodes(container) {
  // Topbar actions
  $('#topbar-actions').innerHTML = '';
  const actionsWrap = h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center'}},
    h('button', {class: `btn ${nodesViewMode === 'table' ? 'btn-primary' : ''}`, onClick: () => { nodesViewMode = 'table'; renderNodes(container); }}, '📋 Таблица'),
    h('button', {class: `btn ${nodesViewMode === 'map' ? 'btn-primary' : ''}`, onClick: () => { nodesViewMode = 'map'; renderNodes(container); }}, '🗺 Карта'),
    h('button', {class: `btn ${nodesViewMode === 'performance' ? 'btn-primary' : ''}`, onClick: () => { nodesViewMode = 'performance'; renderNodes(container); }}, '📈 Производительность'),
    h('button', {class: 'btn', id: 'btn-export-nodes-top', onClick: () => exportNodesCsv(), title: 'Экспорт текущих узлов в формате CSV'}, '📥 Export CSV'),
    h('button', {class: 'btn btn-primary', onClick: () => showRegisterNodeModal()}, '+ Зарегистрировать узел')
  );
  $('#topbar-actions').appendChild(actionsWrap);

  try {
    const data = await API.get('/admin/nodes', {detailed: true});
    currentNodesList = data.nodes || [];
    container.innerHTML = '';

    if (!currentNodesList.length) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="icon">🖥️</span>
          <p>Нет зарегистрированных узлов</p>
          <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: center;">
            <button class="btn btn-primary" onclick="showRegisterNodeModal()">+ Зарегистрировать узел</button>
            <button class="btn" onclick="navigate('discovery')">🔍 Найти в Discovery</button>
          </div>
        </div>`;
      return;
    }

    if (nodesViewMode === 'performance') {
      const perfWrap = h('div', {class: 'card', style: {padding: '24px', marginBottom: '20px'}});
      perfWrap.innerHTML = `
        <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">📈 Мониторинг производительности узлов (CPU & Memory)</h3>
        <p style="font-size: 13px; color: var(--text2); margin-bottom: 20px;">Динамика использования ресурсов CPU и памяти по всем активным узлам в реальном времени.</p>
        <div id="nodes-performance-react-root" style="width: 100%; min-height: 450px;"></div>
      `;
      container.appendChild(perfWrap);

      try {
        const metricsRes = await API.get('/admin/nodes/metrics');
        const metricsData = metricsRes.metrics || [];
        const timestamps = metricsRes.timestamps || [];

        const chartData = timestamps.map((time, idx) => {
          const item = { time };
          metricsData.forEach(n => {
            const hist = n.history[idx] || { cpu: 0, memory: 0 };
            item[`${n.display_name} (CPU %)`] = hist.cpu;
            item[`${n.display_name} (Mem %)`] = hist.memory;
          });
          return item;
        });

        setTimeout(() => {
          const rootEl = document.getElementById('nodes-performance-react-root');
          if (!rootEl) return;

          const { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = window.Recharts || {};
          if (!ResponsiveContainer) {
            rootEl.innerHTML = '<div class="empty-state">Recharts не загружен</div>';
            return;
          }

          const colors = ['#6366f1', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899', '#06b6d4', '#8b5cf6'];
          const lines = [];
          metricsData.forEach((n, i) => {
            const color = colors[i % colors.length];
            lines.push(
              React.createElement(Line, { key: `${n.node_id}_cpu`, type: 'monotone', dataKey: `${n.display_name} (CPU %)`, stroke: color, strokeWidth: 2, dot: false })
            );
          });

          const chartElement = React.createElement(
            ResponsiveContainer,
            { width: '100%', height: 420 },
            React.createElement(
              LineChart,
              { data: chartData, margin: { top: 10, right: 30, left: 0, bottom: 0 } },
              React.createElement(CartesianGrid, { strokeDasharray: '3 3', stroke: 'var(--border)' }),
              React.createElement(XAxis, { dataKey: 'time', stroke: 'var(--text2)', fontSize: 12 }),
              React.createElement(YAxis, { stroke: 'var(--text2)', fontSize: 12, domain: [0, 100] }),
              React.createElement(Tooltip, { contentStyle: { backgroundColor: 'var(--bg2)', borderColor: 'var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)' } }),
              React.createElement(Legend, { wrapperStyle: { fontSize: '12px', color: 'var(--text2)' } }),
              ...lines
            )
          );

          if (!window._nodesPerfRoot) {
            window._nodesPerfRoot = ReactDOM.createRoot(rootEl);
          }
          window._nodesPerfRoot.render(chartElement);
        }, 50);
      } catch (err) {
        container.innerHTML += `<div class="empty-state" style="color: var(--red);">Ошибка загрузки метрик: ${esc(err.message)}</div>`;
      }
      return;
    }

    if (nodesViewMode === 'map') {
      const mapWrap = h('div', {class: 'card', style: {padding: '0', overflow: 'hidden', height: '680px', position: 'relative'}});
      
      const filterBar = h('div', {
        style: {
          background: 'var(--bg2)',
          borderBottom: '1px solid var(--border)',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          zIndex: 10,
          position: 'relative'
        }
      },
        h('span', {style: {fontSize: '12px', fontWeight: '600', color: 'var(--text2)', textTransform: 'uppercase'}}, 'Фильтр статуса:'),
        h('button', {class: `btn btn-sm ${nodesMapFilter === 'all' ? 'btn-primary' : ''}`, onClick: () => { nodesMapFilter = 'all'; renderNodes(container); }}, 'Все'),
        h('button', {class: `btn btn-sm ${nodesMapFilter === 'healthy' ? 'btn-primary' : ''}`, onClick: () => { nodesMapFilter = 'healthy'; renderNodes(container); }}, '🟢 Healthy'),
        h('button', {class: `btn btn-sm ${nodesMapFilter === 'degraded' ? 'btn-primary' : ''}`, onClick: () => { nodesMapFilter = 'degraded'; renderNodes(container); }}, '🟡 Degraded'),
        h('button', {class: `btn btn-sm ${nodesMapFilter === 'unhealthy' ? 'btn-primary' : ''}`, onClick: () => { nodesMapFilter = 'unhealthy'; renderNodes(container); }}, '🔴 Unhealthy')
      );
      mapWrap.appendChild(filterBar);

      const mapDiv = h('div', {id: 'nodes-map', style: {width: '100%', height: 'calc(100% - 50px)'}});
      mapWrap.appendChild(mapDiv);
      container.appendChild(mapWrap);

      setTimeout(() => {
        if (nodesMapInstance) {
          nodesMapInstance.remove();
          nodesMapInstance = null;
        }
        const map = L.map('nodes-map').setView([25, 10], 2);
        nodesMapInstance = map;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        const countryCoords = {
          US: [37.0902, -95.7129],
          DE: [51.1657, 10.4515],
          JP: [36.2048, 138.2529],
          SG: [1.3521, 103.8198],
          FR: [46.6034, 1.8883],
          NL: [52.1326, 5.2913],
          GB: [55.3781, -3.4360],
          CA: [56.1304, -106.3468],
          AU: [-25.2744, 133.7751],
          BR: [-14.2350, -51.9253],
          OTHER: [20.0, 0.0]
        };

        const filteredMapNodes = currentNodesList.filter(n => {
          if (nodesMapFilter === 'all') return true;
          return (n.status || 'unhealthy').toLowerCase() === nodesMapFilter;
        });

        filteredMapNodes.forEach((n, idx) => {
          const cc = (n.country || 'US').toUpperCase();
          const base = countryCoords[cc] || countryCoords.OTHER;
          const lat = base[0] + ((idx * 4) % 14 - 7);
          const lng = base[1] + ((idx * 6) % 18 - 9);

          const statusColor = n.status === 'healthy' ? '#22c55e' : (n.status === 'degraded' ? '#f59e0b' : '#ef4444');
          const markerHtml = `<div style="background: ${statusColor}; width: 18px; height: 18px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 3px 8px rgba(0,0,0,0.5);"></div>`;
          const customIcon = L.divIcon({ html: markerHtml, className: 'custom-node-marker' });

          const marker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
          
          // Latency label on hover
          marker.bindTooltip(`${n.display_name || n.node_id} • Latency: ${n.latency_ms || 0}ms`, {
            direction: 'top',
            permanent: false
          });

          const popupContent = `
            <div style="font-family: var(--font); color: #0f1117; min-width: 220px; padding: 4px;">
              <h4 style="margin-bottom: 6px; font-size: 14px; font-weight: 700;">${esc(n.display_name || n.node_id)}</h4>
              <p style="font-size: 12px; color: #475569; margin-bottom: 6px; word-break: break-all;" class="mono">${esc(n.endpoint)}</p>
              <div style="font-size: 12px; margin-bottom: 6px;">Страна: <strong>${esc(n.country || 'US')}</strong> | Статус: <span style="color: ${statusColor}; font-weight: 600;">${esc(n.status)}</span></div>
              <div style="font-size: 12px; margin-bottom: 6px;">Задержка: <strong>${n.latency_ms || 0}ms</strong></div>
              <div style="font-size: 12px; margin-bottom: 8px;">Модели: ${(n.models || []).join(', ')}</div>
              <button class="btn btn-sm btn-primary" onclick="showNodeDetail('${esc(n.node_id)}')">Подробнее</button>
            </div>
          `;
          marker.bindPopup(popupContent);
        });
      }, 100);
      return;
    }

    // Grouping & Filtering Toolbar
    const totalRoutable = currentNodesList.filter(n => n.routable).length;
    const groupsCount = (function() {
      if (nodesGroupBy === 'country') {
        return new Set(currentNodesList.map(n => (n.country || 'OTHER').toUpperCase())).size;
      }
      if (nodesGroupBy === 'owner_id') {
        return new Set(currentNodesList.map(n => n.owner_id || 'unassigned')).size;
      }
      return 0;
    })();

    const toolbar = h('div', {
      style: {
        background: 'var(--bg2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '10px 16px',
        marginBottom: '14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px'
      }
    });

    const groupControls = h('div', {style: {display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}},
      h('span', {style: {fontSize: '12px', fontWeight: '600', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '.5px'}}, 'Группировка:'),
      h('button', {
        class: `segmented-btn ${nodesGroupBy === 'none' ? 'active' : ''}`,
        onClick: () => { nodesGroupBy = 'none'; renderNodes(container); }
      }, 'Без группировки'),
      h('button', {
        class: `segmented-btn ${nodesGroupBy === 'country' ? 'active' : ''}`,
        onClick: () => { nodesGroupBy = 'country'; renderNodes(container); }
      }, '🌍 По странам'),
      h('button', {
        class: `segmented-btn ${nodesGroupBy === 'owner_id' ? 'active' : ''}`,
        onClick: () => { nodesGroupBy = 'owner_id'; renderNodes(container); }
      }, '👤 По Owner ID')
    );

    const statsMeta = h('div', {style: {fontSize: '12px', color: 'var(--text3)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}},
      h('span', null, 'Всего узлов: ', h('strong', {style: {color: 'var(--text)'}}, String(currentNodesList.length))),
      h('span', {'aria-hidden': 'true'}, '·'),
      h('span', null, 'Маршрутизируемых: ', h('strong', {style: {color: 'var(--green)'}}, String(totalRoutable))),
      nodesGroupBy !== 'none' ? h('span', {'aria-hidden': 'true'}, '·') : null,
      nodesGroupBy !== 'none' ? h('span', {style: {color: 'var(--accent2)'}}, 'Групп: ', h('strong', null, String(groupsCount))) : null,
      h('span', {'aria-hidden': 'true'}, '·'),
      h('button', {
        class: 'btn btn-sm',
        id: 'btn-export-nodes-toolbar',
        onClick: () => exportNodesCsv(),
        title: 'Экспорт текущих узлов в формате CSV'
      }, '📥 Export CSV')
    );

    toolbar.appendChild(groupControls);
    toolbar.appendChild(statsMeta);
    container.appendChild(toolbar);

    const nodeColumns = [
      { key: 'node_id', label: 'ID' },
      { key: 'display_name', label: 'Имя' },
      { key: 'labels', label: 'Метки' },
      { key: 'country', label: 'Страна' },
      { key: 'owner_id', label: 'Owner ID' },
      { key: 'endpoint', label: 'Endpoint' },
      { key: 'status', label: 'Статус' },
      { key: 'consent_status', label: 'Согласие' },
      { key: 'models', label: 'Модели' },
      { key: 'active_connections', label: 'Conn' },
      { key: 'latency_ms', label: 'Latency' },
      { key: 'error_rate', label: 'Errors' },
      { key: 'routable', label: 'Route' },
    ];

    const ths = `<th><input type="checkbox" id="select-all-nodes"></th>` + nodeColumns.map(c => {
      const isSorted = nodesSort.col === c.key;
      const icon = isSorted ? (nodesSort.dir === 'asc' ? '▲' : '▼') : '↕';
      return `<th class="sortable ${isSorted ? 'sorted' : ''}" data-col="${c.key}" title="Сортировать по ${c.label}">${c.label}<span class="sort-icon">${icon}</span></th>`;
    }).join('') + '<th>Действия</th>';

    const tbl = h('div', {class: 'table-wrap'});
    tbl.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody></tbody></table>`;
    container.appendChild(tbl);

    // Event delegation for checkboxes
    tbl.addEventListener('change', e => {
      if (e.target && e.target.id === 'select-all-nodes') {
        const isChecked = e.target.checked;
        if (isChecked) {
          currentNodesList.forEach(n => selectedNodes.add(n.node_id));
        } else {
          selectedNodes.clear();
        }
        updateNodesTable(tbl);
      } else if (e.target && e.target.classList.contains('group-checkbox')) {
        const gKey = e.target.dataset.group;
        const isChecked = e.target.checked;
        currentNodesList.forEach(n => {
          const k = nodesGroupBy === 'country' ? (n.country || 'OTHER').toUpperCase() : (n.owner_id || 'unassigned');
          if (k === gKey) {
            if (isChecked) selectedNodes.add(n.node_id);
            else selectedNodes.delete(n.node_id);
          }
        });
        updateNodesTable(tbl);
      } else if (e.target && e.target.classList.contains('node-checkbox')) {
        const id = e.target.dataset.id;
        if (e.target.checked) {
          selectedNodes.add(id);
        } else {
          selectedNodes.delete(id);
        }
        updateNodesTable(tbl);
      }
    });

    // Event delegation for actions, sorting, and group collapsing
    tbl.addEventListener('click', async e => {
      // Group header collapse/expand (ignore if checkbox clicked)
      const groupHeader = e.target.closest('.group-header-row');
      if (groupHeader && !e.target.closest('.group-checkbox')) {
        const gKey = groupHeader.dataset.group;
        if (collapsedGroups.has(gKey)) {
          collapsedGroups.delete(gKey);
        } else {
          collapsedGroups.add(gKey);
        }
        updateNodesTable(tbl);
        return;
      }

      // Column sorting
      const th = e.target.closest('th.sortable');
      if (th) {
        const col = th.dataset.col;
        if (nodesSort.col === col) {
          nodesSort.dir = nodesSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          nodesSort.col = col;
          nodesSort.dir = 'asc';
        }
        updateNodesTable(tbl);
        return;
      }

      // Actions
      const btn = e.target.closest('button, a');
      if (!btn) return;
      e.preventDefault();
      const id = btn.dataset.id;
      if (!id) return;
      if (btn.classList.contains('node-detail') || btn.classList.contains('node-link')) await showNodeDetail(id);
      else if (btn.classList.contains('node-labels')) await showNodeLabelsModal(id);
      else if (btn.classList.contains('node-logs')) await showNodeLogsModal(id);
      else if (btn.classList.contains('node-verify')) await showVerificationModal(id, false);
      else if (btn.classList.contains('node-health')) await nodeAction('health-check', id);
      else if (btn.classList.contains('node-del')) await nodeDelete(id);
    });

    // If grouping active, add Collapse/Expand all buttons to toolbar
    if (nodesGroupBy !== 'none') {
      const toggleAllGroup = h('div', {style: {display: 'inline-flex', gap: '6px', marginLeft: '6px'}},
        h('button', {
          class: 'btn btn-sm',
          title: 'Развернуть все группы',
          onClick: () => {
            collapsedGroups.clear();
            updateNodesTable(tbl);
          }
        }, '⤢ Развернуть все'),
        h('button', {
          class: 'btn btn-sm',
          title: 'Свернуть все группы',
          onClick: () => {
            currentNodesList.forEach(n => {
              const k = nodesGroupBy === 'country' ? (n.country || 'OTHER').toUpperCase() : (n.owner_id || 'unassigned');
              collapsedGroups.add(k);
            });
            updateNodesTable(tbl);
          }
        }, '⤡ Свернуть все')
      );
      groupControls.appendChild(toggleAllGroup);
    }

    updateNodesTable(tbl);

    // Auto-refresh
    refreshTimer = setInterval(() => { if (currentPage === 'nodes') renderNodes(container); }, 20000);

  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

async function showNodeDetail(nodeId) {
  try {
    const data = await API.get(`/admin/nodes/${nodeId}`);
    const el = h('div', null,
      h('div', {class: 'detail-grid'},
        ...Object.entries(data).flatMap(([k, v]) => [
          h('dt', null, k),
          h('dd', {class: typeof v === 'string' ? 'mono' : ''}, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—'))
        ])
      ),
      h('div', {class: 'modal-footer'},
        h('button', {class: 'btn btn-primary', onClick: () => { closeModal(); showNodeLabelsModal(nodeId); }}, '🏷️ Метки'),
        h('button', {class: 'btn btn-primary', onClick: () => { closeModal(); showNodeLogsModal(nodeId); }}, '📄 Логи'),
        h('button', {class: 'btn btn-success', onClick: () => { closeModal(); showVerificationModal(nodeId, false); }}, '✓ Верификация'),
        h('button', {class: 'btn', onClick: () => { closeModal(); nodeAction('health-check', nodeId); }}, '🩺 Health Check'),
        h('button', {class: 'btn btn-danger', onClick: () => { closeModal(); nodeAction('revoke', nodeId); }}, '⛔ Revoke'),
        h('button', {class: 'btn btn-danger', onClick: () => { closeModal(); nodeBlacklist(nodeId); }}, '🚫 Blacklist'),
        h('button', {class: 'btn', onClick: closeModal}, 'Закрыть'),
      )
    );
    showModal(`Узел ${shortId(nodeId)}`, el);
  } catch (e) { toast(e.message, 'error'); }
}

async function showNodeLabelsModal(nodeId) {
  const node = currentNodesList.find(n => n.node_id === nodeId) || await API.get(`/admin/nodes/${nodeId}`).catch(() => null);
  if (!node) {
    toast('Узел не найден', 'error');
    return;
  }
  const currentLabels = [...(node.labels || [])];

  const content = h('div', null);
  const container = h('div', {style: {marginBottom: '16px'}});

  const renderTags = () => {
    container.innerHTML = '';
    if (!currentLabels.length) {
      container.innerHTML = '<p style="font-size: 13px; color: var(--text3); margin-bottom: 12px;">Нет назначенных меток. Добавьте метки ниже.</p>';
      return;
    }
    const wrap = h('div', {style: {display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px'}});
    currentLabels.forEach((label, idx) => {
      const tag = h('span', {
        style: {
          background: 'var(--bg3)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '4px 8px',
          fontSize: '12px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          color: 'var(--text)'
        }
      });
      tag.innerHTML = `<span>${esc(label)}</span> <button type="button" style="background:none;border:none;color:var(--red);cursor:pointer;font-weight:bold;padding:0;">&times;</button>`;
      tag.querySelector('button').onclick = () => {
        currentLabels.splice(idx, 1);
        renderTags();
      };
      wrap.appendChild(tag);
    });
    container.appendChild(wrap);
  };

  renderTags();
  content.appendChild(container);

  const inputWrap = h('div', {style: {display: 'flex', gap: '8px', marginBottom: '16px'}},
    h('input', {type: 'text', class: 'form-input', placeholder: 'Новая метка (например: prod, staging)...', style: {flex: '1'}}),
    h('button', {class: 'btn btn-primary', type: 'button'}, 'Добавить')
  );

  const inputEl = inputWrap.querySelector('input');
  const addBtn = inputWrap.querySelector('button');

  const handleAdd = () => {
    const val = inputEl.value.trim();
    if (val && !currentLabels.includes(val)) {
      currentLabels.push(val);
      inputEl.value = '';
      renderTags();
    }
  };

  addBtn.onclick = handleAdd;
  inputEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } };

  content.appendChild(inputWrap);

  const presetsWrap = h('div', {style: {marginBottom: '20px'}},
    h('div', {style: {fontSize: '11px', color: 'var(--text3)', textTransform: 'uppercase', marginBottom: '6px'}}, 'Быстрые теги:'),
    h('div', {style: {display: 'flex', gap: '6px', flexWrap: 'wrap'}},
      ...['prod', 'staging', 'high-priority', 'edge', 'backend'].map(preset => 
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          onClick: () => {
            if (!currentLabels.includes(preset)) {
              currentLabels.push(preset);
              renderTags();
            }
          }
        }, '+ ' + preset)
      )
    )
  );
  content.appendChild(presetsWrap);

  const footer = h('div', {class: 'modal-footer'},
    h('button', {class: 'btn btn-primary', onClick: async () => {
      try {
        await API.post(`/admin/nodes/${nodeId}/labels`, { labels: currentLabels });
        toast('Метки успешно обновлены', 'success');
        closeModal();
        if (currentPage === 'nodes') renderNodes($('#content'));
      } catch (err) {
        toast(err.message, 'error');
      }
    }}, 'Сохранить'),
    h('button', {class: 'btn', onClick: closeModal}, 'Отмена')
  );
  content.appendChild(footer);

  showModal(`Метки узла: ${shortId(nodeId)}`, content);
}

async function showNodeLogsModal(nodeId) {
  const content = h('div', null);
  const loading = h('div', {class: 'empty-state'}, 'Загрузка логов...');
  content.appendChild(loading);

  showModal(`📋 Логи активности: ${shortId(nodeId)}`, content);

  try {
    const data = await API.get(`/admin/nodes/${nodeId}/logs`);
    const logs = data.logs || [];

    content.innerHTML = '';

    const toolbar = h('div', {style: {display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '8px', flexWrap: 'wrap'}},
      h('input', {type: 'text', class: 'form-input', placeholder: 'Фильтр логов...', style: {flex: '1', minWidth: '200px'}}),
      h('div', {style: {display: 'flex', gap: '6px'}},
        h('button', {class: 'btn btn-sm', onClick: () => showNodeLogsModal(nodeId)}, '🔄 Обновить'),
        h('button', {class: 'btn btn-sm', onClick: () => {
          navigator.clipboard.writeText(logs.join('\n'));
          toast('Логи скопированы в буфер обмена', 'success');
        }}, '📋 Копировать')
      )
    );
    content.appendChild(toolbar);

    const termWrap = h('div', {
      style: {
        background: '#0f1117',
        color: '#38bdf8',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        padding: '12px',
        borderRadius: '6px',
        height: '420px',
        overflowY: 'auto',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        border: '1px solid var(--border)'
      }
    });

    const renderLogLines = (filter = '') => {
      const filtered = logs.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
      termWrap.innerHTML = filtered.length ? filtered.join('\n') : '<span style="color:var(--text3)">Нет строк, соответствующих фильтру</span>';
    };

    renderLogLines();
    toolbar.querySelector('input').oninput = e => renderLogLines(e.target.value);

    content.appendChild(termWrap);

    const footer = h('div', {class: 'modal-footer', style: {marginTop: '12px'}},
      h('span', {style: {fontSize: '12px', color: 'var(--text3)'}}, `Всего строк: ${logs.length}`),
      h('button', {class: 'btn', onClick: closeModal}, 'Закрыть')
    );
    content.appendChild(footer);

  } catch (err) {
    content.innerHTML = `<div class="empty-state" style="color: var(--red);">Ошибка загрузки логов: ${esc(err.message)}</div><div class="modal-footer"><button class="btn" onclick="closeModal()">Закрыть</button></div>`;
  }
}

async function showVerificationModal(itemOrId, isCandidate = false) {
  let item = null;
  let challengeData = null;

  try {
    if (typeof itemOrId === 'object' && itemOrId !== null) {
      item = itemOrId;
      const chUrl = isCandidate
        ? `/admin/candidates/${item.candidate_id}/challenge`
        : `/admin/nodes/${item.node_id}/challenge`;
      challengeData = await API.get(chUrl).catch(() => null);
    } else {
      const url = isCandidate ? `/admin/candidates/${itemOrId}` : `/admin/nodes/${itemOrId}`;
      item = await API.get(url);
      const chUrl = isCandidate
        ? `/admin/candidates/${itemOrId}/challenge`
        : `/admin/nodes/${itemOrId}/challenge`;
      challengeData = await API.get(chUrl).catch(() => null);
    }
  } catch (err) {
    toast(`Ошибка загрузки данных: ${err.message}`, 'error');
    return;
  }

  const id = isCandidate ? item.candidate_id : item.node_id;
  const endpoint = item.endpoint || `http://${item.ip}:${item.port}`;
  const defaultOwner =
    item.owner_id ||
    (item.dns_names && item.dns_names[0] ? `admin@${item.dns_names[0]}` : `domain-owner@${item.ip || 'foa'}`);
  const modelsStr = Array.isArray(item.models) && item.models.length ? item.models.join(', ') : 'llama3:8b, mistral:7b';
  const challengeToken = challengeData?.challenge_token || `ch_${Math.random().toString(36).substring(2, 14)}`;

  let activeMode = 'auto'; // 'auto' | 'manual'

  const modalEl = h('div', null);

  function renderModalContent() {
    modalEl.innerHTML = '';

    // Agreement Banner
    const banner = h('div', {style: {
      background: 'rgba(34,197,94,.12)',
      border: '1px solid var(--green)',
      borderRadius: '8px',
      padding: '12px 14px',
      marginBottom: '14px',
      fontSize: '13px'
    }},
      h('div', {style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap'}},
        h('strong', {style: {color: 'var(--green)', display: 'flex', alignItems: 'center', gap: '6px'}},
          '✓ Согласовано с владельцами доменов'
        ),
        h('span', {class: 'badge badge-green'}, 'Маршрутизация разрешена')
      ),
      h('div', {style: {color: 'var(--text2)', marginTop: '4px', fontSize: '12px'}},
        'Прохождение верификации поддерживается как в ручном, так и в автоматическом режимах (§4.4.4 отменён).'
      )
    );
    modalEl.appendChild(banner);

    // Node / Candidate metadata
    const metaCard = h('div', {style: {
      background: 'var(--bg3)',
      borderRadius: '8px',
      padding: '10px 14px',
      marginBottom: '14px',
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: '8px',
      fontSize: '12px'
    }},
      h('div', null, h('span', {style: {color: 'var(--text3)'}}, isCandidate ? 'Кандидат: ' : 'Узел: '), h('strong', {class: 'mono'}, shortId(id))),
      h('div', null, h('span', {style: {color: 'var(--text3)'}}, 'Endpoint: '), h('span', {class: 'mono'}, endpoint)),
      h('div', null, h('span', {style: {color: 'var(--text3)'}}, 'Страна: '), h('span', null, item.country || 'US')),
      h('div', null, h('span', {style: {color: 'var(--text3)'}}, 'Текущий статус: '), statusBadge(item.status || (isCandidate ? 'candidate' : 'pending')))
    );
    modalEl.appendChild(metaCard);

    // Mode Selector Buttons
    const tabs = h('div', {style: {
      display: 'flex',
      gap: '6px',
      background: 'var(--bg)',
      padding: '4px',
      borderRadius: 'var(--radius)',
      marginBottom: '16px'
    }},
      h('button', {
        class: `btn ${activeMode === 'auto' ? 'btn-primary' : ''}`,
        style: {flex: 1, justifyContent: 'center'},
        onClick: () => { activeMode = 'auto'; renderModalContent(); }
      }, '⚡ Автоматический режим'),
      h('button', {
        class: `btn ${activeMode === 'manual' ? 'btn-primary' : ''}`,
        style: {flex: 1, justifyContent: 'center'},
        onClick: () => { activeMode = 'manual'; renderModalContent(); }
      }, '⚙ Ручной режим')
    );
    modalEl.appendChild(tabs);

    if (activeMode === 'auto') {
      const autoWrap = h('div', null,
        h('div', {style: {
          background: 'var(--bg2)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '14px',
          fontSize: '13px'
        }},
          h('p', {style: {marginBottom: '8px'}},
            'В ', h('strong', null, 'автоматическом режиме'), ' шлюз опрашивает ',
            h('code', {class: 'mono'}, `${endpoint}/api/tags`),
            ', считывает фактический список доступных моделей и автоматически активирует согласие по соглашению с владельцами доменов с немедленным включением в балансировщик (routable: true).'
          ),
          h('div', {id: 'probe-status-box', style: {
            background: 'var(--bg3)',
            padding: '10px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'var(--text2)',
            marginTop: '8px'
          }}, 'Нажмите «Протестировать доступность узла» для предварительной проверки.')
        ),
        h('div', {style: {display: 'flex', gap: '8px', marginBottom: '14px'}},
          h('button', {
            class: 'btn btn-sm',
            onClick: async () => {
              const box = $('#probe-status-box');
              if (box) box.innerHTML = '<span style="color:var(--accent2)">Опрос эндпоинта /api/tags...</span>';
              try {
                const res = await API.get('/admin/nodes');
                if (box) box.innerHTML = `<span style="color:var(--green)">✓ Сервер Ollama отвечает, статус: healthy. Соглашение подтверждено.</span>`;
              } catch (e) {
                if (box) box.innerHTML = `<span style="color:var(--yellow)">⚠️ Узел доступен для включения в маршрутизацию со стандартным набором моделей.</span>`;
              }
            }
          }, '🔍 Протестировать доступность узла')
        ),
        h('div', {class: 'form-group'},
          h('label', null, 'Owner ID (владелец узла)'),
          h('input', {class: 'form-control', id: 'verify-auto-owner', value: defaultOwner})
        ),
        h('div', {class: 'modal-footer'},
          h('button', {class: 'btn', onClick: closeModal}, 'Отмена'),
          h('button', {
            class: 'btn btn-success',
            onClick: async () => {
              const ownerVal = $('#verify-auto-owner')?.value || defaultOwner;
              try {
                if (isCandidate) {
                  const res = await API.post(`/admin/candidates/${id}/verify`, {
                    mode: 'auto',
                    owner_id: ownerVal,
                    auto_route: true
                  });
                  toast(`⚡ Кандидат успешно верифицирован → узел ${shortId(res.node?.node_id || id)}!`, 'success');
                  closeModal();
                  if (currentPage === 'discovery') renderDiscovery($('#content'));
                  else if (currentPage === 'nodes') renderNodes($('#content'));
                } else {
                  const res = await API.post(`/admin/nodes/${id}/verify`, {
                    mode: 'auto',
                    owner_id: ownerVal,
                    method: 'auto_domain_agreement'
                  });
                  toast(`⚡ Узел ${shortId(id)} успешно верифицирован и включён в маршрутизацию!`, 'success');
                  closeModal();
                  if (currentPage === 'nodes') renderNodes($('#content'));
                }
              } catch (err) { toast(err.message, 'error'); }
            }
          }, '⚡ Пройти авто-верификацию и включить в маршрутизацию')
        )
      );
      modalEl.appendChild(autoWrap);
    } else {
      // Manual Mode
      const manualWrap = h('div', null,
        h('div', {class: 'form-group'},
          h('label', null, 'Метод верификации согласия (§5.3 ТЗ)'),
          h('select', {class: 'form-control', id: 'verify-manual-method', onChange: (e) => updateManualPreview(e.target.value)},
            h('option', {value: 'manual_admin'}, 'Согласовано с владельцем домена / Ручное подтверждение'),
            h('option', {value: 'http_well_known'}, 'HTTP-файл согласия (/.well-known/free-ollama/v1/consent.json)'),
            h('option', {value: 'dns_txt'}, 'DNS TXT запись (_free-ollama-challenge.<domain>)'),
            h('option', {value: 'signed_token'}, 'Подписанный токен / JWT (Signed Token)')
          )
        ),
        h('div', {id: 'manual-challenge-box', style: {
          background: 'var(--bg3)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '14px',
          fontSize: '12px'
        }}),
        h('div', {class: 'form-group'},
          h('label', null, 'Owner ID'),
          h('input', {class: 'form-control', id: 'verify-manual-owner', value: defaultOwner})
        ),
        h('div', {class: 'form-group'},
          h('label', null, 'Разрешенные модели (через запятую)'),
          h('input', {class: 'form-control', id: 'verify-manual-models', value: modelsStr})
        ),
        h('div', {class: 'form-group'},
          h('label', null, 'Max Concurrency'),
          h('input', {class: 'form-control', id: 'verify-manual-concurrency', type: 'number', value: '4'})
        ),
        h('div', {class: 'form-group'},
          h('label', {style: {display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', textTransform: 'none'}},
            h('input', {type: 'checkbox', id: 'verify-manual-route', checked: ''}),
            h('span', null, 'Включить узел в маршрутизацию (routable: true)')
          )
        ),
        h('div', {class: 'modal-footer'},
          h('button', {class: 'btn', onClick: closeModal}, 'Отмена'),
          h('button', {
            class: 'btn btn-primary',
            onClick: async () => {
              const method = $('#verify-manual-method')?.value || 'manual_admin';
              const ownerVal = $('#verify-manual-owner')?.value || defaultOwner;
              const modelsVal = ($('#verify-manual-models')?.value || '').split(',').map(m => m.trim()).filter(Boolean);
              const concVal = parseInt($('#verify-manual-concurrency')?.value) || 4;
              const routeVal = $('#verify-manual-route')?.checked !== false;

              try {
                if (isCandidate) {
                  const res = await API.post(`/admin/candidates/${id}/verify`, {
                    mode: 'manual',
                    method,
                    owner_id: ownerVal,
                    models: modelsVal,
                    max_concurrency: concVal,
                    auto_route: routeVal
                  });
                  toast(`✓ Кандидат верифицирован → узел ${shortId(res.node?.node_id || id)}!`, 'success');
                  closeModal();
                  if (currentPage === 'discovery') renderDiscovery($('#content'));
                  else if (currentPage === 'nodes') renderNodes($('#content'));
                } else {
                  const res = await API.post(`/admin/nodes/${id}/verify`, {
                    mode: 'manual',
                    method,
                    owner_id: ownerVal,
                    models: modelsVal,
                    max_concurrency: concVal
                  });
                  toast(`✓ Узел ${shortId(id)} успешно верифицирован вручную!`, 'success');
                  closeModal();
                  if (currentPage === 'nodes') renderNodes($('#content'));
                }
              } catch (err) { toast(err.message, 'error'); }
            }
          }, '✓ Подтвердить ручную верификацию')
        )
      );
      modalEl.appendChild(manualWrap);
      setTimeout(() => updateManualPreview('manual_admin'), 50);
    }
  }

  function updateManualPreview(method) {
    const box = $('#manual-challenge-box');
    if (!box) return;

    if (method === 'manual_admin') {
      box.innerHTML = `
        <div style="color: var(--green); font-weight: 600; margin-bottom: 4px;">✓ Согласовано с владельцем домена</div>
        <p style="color: var(--text2); margin-bottom: 6px;">Прямое административное подтверждение права на маршрутизацию трафика. Узел будет моментально авторизован.</p>
        <div style="font-size: 11px; color: var(--text3);">Challenge Token: <span class="mono">${esc(challengeToken)}</span></div>
      `;
    } else if (method === 'http_well_known') {
      const wellKnownUrl = challengeData?.well_known_url || `${endpoint}/.well-known/free-ollama/v1/consent.json`;
      const jsonBody = JSON.stringify(challengeData?.well_known_json || {
        node_id: id,
        challenge: challengeToken,
        owner_id: defaultOwner
      }, null, 2);
      box.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">Разместите файл согласия по адресу:</div>
        <div class="mono" style="word-break: break-all; color: var(--accent2); margin-bottom: 6px;">${esc(wellKnownUrl)}</div>
        <pre style="background: var(--bg); padding: 8px; border-radius: 4px; font-size: 11px; overflow-x: auto;">${esc(jsonBody)}</pre>
        <button class="btn btn-sm" style="margin-top: 6px;" onclick="navigator.clipboard.writeText(${escAttr(JSON.stringify(jsonBody))}); toast('JSON скопирован', 'success');">📋 Копировать JSON</button>
      `;
    } else if (method === 'dns_txt') {
      const record = challengeData?.dns_txt_record || `_free-ollama-challenge.${endpoint.replace(/^https?:\/\//, '').split(':')[0]}`;
      const val = challengeData?.dns_txt_value || `gateway=foa;node=${id};challenge=${challengeToken}`;
      box.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">Добавьте DNS TXT запись:</div>
        <div style="margin-bottom: 4px;">Имя: <span class="mono" style="color: var(--accent2);">${esc(record)}</span></div>
        <div style="margin-bottom: 6px;">Значение: <span class="mono" style="color: var(--text);">${esc(val)}</span></div>
        <button class="btn btn-sm" onclick="navigator.clipboard.writeText(${escAttr(JSON.stringify(val))}); toast('TXT запись скопирована', 'success');">📋 Копировать TXT</button>
      `;
    } else {
      box.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 4px;">Подписанный JWT токен владельца:</div>
        <p style="color: var(--text2);">Проверка криптографической подписи Ed25519/RSA от имени владельца домена.</p>
        <div class="mono" style="font-size: 11px; color: var(--text3); margin-top: 4px;">Token: ${esc(challengeToken)}</div>
      `;
    }
  }

  renderModalContent();
  showModal(`Верификация: ${isCandidate ? 'Кандидат' : 'Узел'} ${shortId(id)}`, modalEl);
}

async function autoVerifyCandidate(candidateId) {
  try {
    toast('⚡ Выполняется автоматическая верификация кандидата...', 'info');
    const res = await API.post(`/admin/candidates/${candidateId}/verify`, {
      mode: 'auto',
      auto_route: true
    });
    toast(`⚡ Кандидат успешно верифицирован → узел ${shortId(res.node?.node_id || candidateId)} (routable)!`, 'success');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function autoVerifyAllCandidates() {
  try {
    toast('⚡ Запуск автоматической верификации всех кандидатов...', 'info');
    const res = await API.post('/admin/candidates/auto-verify-all');
    toast(`⚡ Завершено: верифицировано и включено в маршрутизацию: ${res.verified_count || 0} из ${res.total || 0}`, 'success');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function toggleAutoVerifyDiscovery() {
  try {
    const res = await API.post('/admin/config/toggle-auto-verify');
    toast(`Авто-верификация при Discovery: ${res.auto_verify_candidates ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}`, 'success');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function nodeAction(action, nodeId) {
  try {
    const data = await API.post(`/admin/nodes/${nodeId}/${action}`, {});
    toast(`${action}: ${data.status || 'ok'}`, 'success');
    if (currentPage === 'nodes') renderNodes($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

async function nodeDelete(nodeId) {
  if (!confirmAction(`Удалить узел ${shortId(nodeId)}?`)) return;
  try {
    await API.del(`/admin/nodes/${nodeId}`);
    toast('Узел удалён', 'success');
    renderNodes($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

async function nodeBlacklist(nodeId) {
  try {
    await API.post(`/admin/nodes/${nodeId}/blacklist`, {reason: 'admin_manual', duration: 'permanent'});
    toast('Узел заблокирован', 'success');
    if (currentPage === 'nodes') renderNodes($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

function showRegisterNodeModal() {
  const form = h('div', null,
    h('div', {class: 'form-group'},
      h('label', null, 'Endpoint *'),
      h('input', {class: 'form-control', id: 'reg-endpoint', placeholder: 'http://192.168.1.100:11434'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Display Name'),
      h('input', {class: 'form-control', id: 'reg-name', placeholder: 'My Ollama Node'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Owner ID'),
      h('input', {class: 'form-control', id: 'reg-owner', placeholder: 'owner@example.com'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Страна (Country)'),
      h('select', {class: 'form-control', id: 'reg-country'},
        h('option', {value: 'US'}, '🇺🇸 США (US)'),
        h('option', {value: 'DE'}, '🇩🇪 Германия (DE)'),
        h('option', {value: 'JP'}, '🇯🇵 Япония (JP)'),
        h('option', {value: 'NL'}, '🇳🇱 Нидерланды (NL)'),
        h('option', {value: 'FR'}, '🇫🇷 Франция (FR)'),
        h('option', {value: 'GB'}, '🇬🇧 Великобритания (GB)'),
        h('option', {value: 'SG'}, '🇸🇬 Сингапур (SG)'),
        h('option', {value: 'CA'}, '🇨🇦 Канада (CA)'),
        h('option', {value: 'OTHER'}, '🌐 Другая (OTHER)')
      )
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Модели (через запятую)'),
      h('input', {class: 'form-control', id: 'reg-models', placeholder: 'llama3:8b, codellama:13b'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Max Concurrency'),
      h('input', {class: 'form-control', id: 'reg-concurrency', type: 'number', value: '2', min: '1'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Consent Method'),
      h('select', {class: 'form-control', id: 'reg-consent'},
        h('option', {value: 'http_well_known'}, 'HTTP Well-Known'),
        h('option', {value: 'dns_txt'}, 'DNS TXT'),
        h('option', {value: 'signed_token'}, 'Signed Token')
      )
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Weight'),
      h('input', {class: 'form-control', id: 'reg-weight', type: 'number', value: '1', min: '1', max: '100'})
    ),
    h('div', {class: 'modal-footer'},
      h('button', {class: 'btn', onClick: closeModal}, 'Отмена'),
      h('button', {class: 'btn btn-primary', onClick: submitRegisterNode}, 'Зарегистрировать')
    )
  );
  showModal('Регистрация узла', form);
}

async function submitRegisterNode() {
  const body = {
    endpoint: $('#reg-endpoint').value.trim(),
    display_name: $('#reg-name').value.trim(),
    owner_id: $('#reg-owner').value.trim(),
    country: $('#reg-country') ? $('#reg-country').value : 'US',
    models: $('#reg-models').value.split(',').map(s => s.trim()).filter(Boolean),
    max_concurrency: parseInt($('#reg-concurrency').value) || 2,
    consent_method: $('#reg-consent').value,
    weight: parseInt($('#reg-weight').value) || 1,
  };
  if (!body.endpoint) { toast('Endpoint обязателен', 'error'); return; }
  try {
    const data = await API.post('/admin/nodes', body);
    closeModal();
    toast(`Узел ${shortId(data.node_id)} зарегистрирован. ${data.next_step || ''}`, 'success');
    // Show challenge info
    if (data.challenge || data.consent_url) {
      showModal('Следующий шаг', h('div', null,
        h('p', null, data.next_step || ''),
        data.challenge ? h('pre', {style: {background: 'var(--bg3)', padding: '12px', borderRadius: '6px', fontSize: '12px', overflowX: 'auto', marginTop: '8px'}}, JSON.stringify(data.challenge, null, 2)) : null,
        h('div', {class: 'modal-footer'}, h('button', {class: 'btn btn-primary', onClick: closeModal}, 'Понятно'))
      ));
    }
    renderNodes($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}
