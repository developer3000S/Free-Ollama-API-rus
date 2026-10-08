/* ===== FOA Gateway Admin Panel :: audit.js ===== */
/*  Audit Log                                                              */
/* ====================================================================== */
let currentAuditEntries = [];

function exportAuditCsv() {
  if (!currentAuditEntries || !currentAuditEntries.length) {
    toast('Нет записей аудита для экспорта', 'error');
    return;
  }

  const columns = [
    { label: 'Время (UTC)', key: 'created_at' },
    { label: 'Время (Локальное)', key: 'created_at', format: v => (v ? fmtDate(v) : '') },
    { label: 'Событие (Event)', key: 'event' },
    { label: 'Actor', key: 'actor' },
    { label: 'Тип (Subject Type)', key: 'subject_type' },
    { label: 'Subject ID', key: 'subject_id' },
    { label: 'Детали (Detail)', key: 'detail', format: v => (typeof v === 'object' ? JSON.stringify(v) : String(v != null ? v : '')) }
  ];

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `audit_log_export_${dateStr}.csv`;
  exportToCsv(filename, columns, currentAuditEntries);
  toast(`Экспорт CSV завершён (записей: ${currentAuditEntries.length})`, 'success');
}

async function renderAudit(container) {
  container.innerHTML = '';

  // Topbar actions
  $('#topbar-actions').innerHTML = '';
  const auditTopActions = h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center'}},
    h('button', {class: 'btn', onClick: () => loadAudit(container)}, '🔄 Обновить'),
    h('button', {class: 'btn', id: 'btn-export-audit-top', onClick: () => exportAuditCsv(), title: 'Экспорт текущих записей журнала аудита в формате CSV'}, '📥 Export CSV')
  );
  $('#topbar-actions').appendChild(auditTopActions);

  // Filters
  const toolbar = h('div', {class: 'toolbar', style: {display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}},
    h('input', {class: 'form-control', id: 'audit-event', placeholder: 'Фильтр по event…', style: {width: '200px'}}),
    h('input', {class: 'form-control', id: 'audit-subject', placeholder: 'subject_id…', style: {width: '200px'}}),
    h('select', {class: 'form-control', id: 'audit-limit', style: {width: '100px'}},
      h('option', {value: '50'}, '50'),
      h('option', {value: '100', selected: ''}, '100'),
      h('option', {value: '500'}, '500'),
    ),
    h('button', {class: 'btn btn-primary', onClick: () => loadAudit(container)}, '🔍 Найти'),
    h('button', {class: 'btn', id: 'btn-export-audit-toolbar', onClick: () => exportAuditCsv(), title: 'Экспорт текущих записей аудита в формате CSV'}, '📥 Export CSV')
  );
  container.appendChild(toolbar);

  const wrap = h('div', {id: 'audit-table-wrap'});
  container.appendChild(wrap);
  await loadAudit(container);
}

async function loadAudit(container) {
  const wrap = $('#audit-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="loading">Загрузка…</div>';
  try {
    const params = {
      limit: $('#audit-limit')?.value || 100,
    };
    const ev = $('#audit-event')?.value?.trim();
    if (ev) params.event = ev;
    const sub = $('#audit-subject')?.value?.trim();
    if (sub) params.subject_id = sub;

    const data = await API.get('/admin/audit', params);
    currentAuditEntries = data.entries || [];

    if (!currentAuditEntries.length) {
      wrap.innerHTML = '<div class="empty-state"><span class="icon">📋</span><p>Нет записей</p></div>';
      return;
    }

    let rows = '';
    currentAuditEntries.forEach(e => {
      rows += `<tr>
        <td style="white-space:nowrap">${fmtDate(e.created_at)}</td>
        <td><span class="chip">${esc(e.event)}</span></td>
        <td>${esc(e.actor || '—')}</td>
        <td>${esc(e.subject_type || '—')}</td>
        <td class="mono">${esc(shortId(e.subject_id || ''))}</td>
        <td class="mono" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(typeof e.detail === 'object' ? JSON.stringify(e.detail) : String(e.detail || '—'))}</td>
      </tr>`;
    });
    wrap.innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Время</th><th>Событие</th><th>Actor</th><th>Тип</th><th>Subject</th><th>Детали</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

