/* ===== FOA Gateway Admin Panel :: blacklist.js ===== */
/* ====================================================================== */
/*  Blacklist                                                              */
/* ====================================================================== */
async function renderBlacklist(container) {
  $('#topbar-actions').innerHTML = '';
  try {
    const data = await API.get('/admin/blacklist', {include_expired: true});
    const list = data.blacklist || [];
    container.innerHTML = '';

    const info = h('div', {class: 'card', style: {marginBottom: '16px', padding: '12px 16px'}},
      h('span', null, `Активных блокировок: `),
      h('strong', {style: {color: 'var(--red)'}}, String(data.active_total || 0))
    );
    container.appendChild(info);

    if (!list.length) {
      container.appendChild(h('div', {class: 'empty-state'}, h('span', {class: 'icon'}, '🚫'), h('p', null, 'Чёрный список пуст')));
      return;
    }

    const tbl = h('div', {class: 'table-wrap'});
    let rows = '';
    list.forEach(b => {
      const active = !b.lifted_at && (!b.expires_at || new Date(b.expires_at) > new Date());
      rows += `<tr>
        <td class="mono">${esc(shortId(b.node_id))}</td>
        <td class="mono truncate">${esc(b.endpoint || '—')}</td>
        <td>${esc(b.reason || '—')}</td>
        <td>${b.permanent ? '<span class="badge badge-red">permanent</span>' : '<span class="badge badge-yellow">temporary</span>'}</td>
        <td>${esc(b.actor || '—')}</td>
        <td>${fmtDate(b.created_at)}</td>
        <td>${fmtDate(b.expires_at)}</td>
        <td>${b.lifted_at ? '<span class="badge badge-green">снята</span>' : (active ? '<span class="badge badge-red">активна</span>' : '<span class="badge badge-gray">истекла</span>')}</td>
        <td>${active ? `<button class="btn btn-sm btn-success unbl-btn" data-id="${esc(b.node_id)}">Снять</button>` : '—'}</td>
      </tr>`;
    });
    tbl.innerHTML = `<table><thead><tr>
      <th>Node</th><th>Endpoint</th><th>Причина</th><th>Тип</th><th>Actor</th><th>Создана</th><th>Истекает</th><th>Статус</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    container.appendChild(tbl);

    tbl.addEventListener('click', async e => {
      const btn = e.target.closest('.unbl-btn');
      if (!btn) return;
      try {
        await API.post(`/admin/nodes/${btn.dataset.id}/unblacklist`);
        toast('Блокировка снята', 'success');
        renderBlacklist(container);
      } catch (err) { toast(err.message, 'error'); }
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}
