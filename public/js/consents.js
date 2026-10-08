/* ===== FOA Gateway Admin Panel :: consents.js ===== */
/* ====================================================================== */
/*  Consents                                                               */
/* ====================================================================== */
async function renderConsents(container) {
  try {
    const data = await API.get('/admin/consents');
    const list = data.consents || [];
    container.innerHTML = '';

    if (!list.length) {
      container.innerHTML = '<div class="empty-state"><span class="icon">✅</span><p>Нет записей согласий</p></div>';
      return;
    }

    const tbl = h('div', {class: 'table-wrap'});
    let rows = '';
    list.forEach(c => {
      rows += `<tr>
        <td><a href="#" class="mono consent-link" data-id="${esc(c.consent_id)}">${esc(shortId(c.consent_id))}</a></td>
        <td class="mono">${esc(shortId(c.node_id))}</td>
        <td class="mono">${esc(c.owner_id || '—')}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${esc(c.method || '—')}</td>
        <td>${modelChips(c.allowed_models)}</td>
        <td>${fmtDate(c.issued_at)}</td>
        <td>${fmtDate(c.expires_at)}</td>
      </tr>`;
    });
    tbl.innerHTML = `<table><thead><tr>
      <th>ID</th><th>Node</th><th>Owner</th><th>Статус</th><th>Метод</th><th>Модели</th><th>Выдано</th><th>Истекает</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    container.appendChild(tbl);

    tbl.addEventListener('click', async e => {
      const link = e.target.closest('.consent-link');
      if (!link) return;
      e.preventDefault();
      await showConsentDetail(link.dataset.id);
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

async function showConsentDetail(consentId) {
  try {
    const data = await API.get(`/admin/consents/${consentId}`);
    const el = h('div', null,
      h('div', {class: 'detail-grid'},
        h('dt', null, 'Consent ID'), h('dd', {class: 'mono'}, data.consent_id),
        h('dt', null, 'Node ID'), h('dd', {class: 'mono'}, data.node_id),
        h('dt', null, 'Owner'), h('dd', null, data.owner_id || '—'),
        h('dt', null, 'Статус'), h('dd', null, data.status),
        h('dt', null, 'Метод'), h('dd', null, data.method || '—'),
        h('dt', null, 'Выдано'), h('dd', null, fmtDate(data.issued_at)),
        h('dt', null, 'Истекает'), h('dd', null, fmtDate(data.expires_at)),
        h('dt', null, 'Отозвано'), h('dd', null, fmtDate(data.revoked_at)),
        h('dt', null, 'Причина отзыва'), h('dd', null, data.revoke_reason || '—'),
        h('dt', null, 'Модели'), h('dd', null, (data.allowed_models || []).join(', ') || '—'),
        h('dt', null, 'Max Concurrency'), h('dd', null, String(data.max_concurrency || '—')),
        h('dt', null, 'Версия'), h('dd', null, String(data.version || '—')),
      ),
      data.history && data.history.length ? h('div', {style: {marginTop: '16px'}},
        h('div', {class: 'card-title', style: {marginBottom: '8px'}}, 'История'),
        ...data.history.map(hi => h('div', {style: {padding: '8px', background: 'var(--bg3)', borderRadius: '4px', marginBottom: '4px', fontSize: '12px'}},
          h('strong', null, hi.event), ' — ', hi.actor || '?', ' (', fmtDate(hi.created_at), ')',
          hi.detail ? h('pre', {style: {fontSize: '11px', marginTop: '4px', color: 'var(--text3)'}}, JSON.stringify(hi.detail)) : null
        ))
      ) : null,
      h('div', {class: 'modal-footer'}, h('button', {class: 'btn', onClick: closeModal}, 'Закрыть'))
    );
    showModal(`Согласие ${shortId(consentId)}`, el);
  } catch (e) { toast(e.message, 'error'); }
}
