/* ===== FOA Gateway Admin Panel :: keys.js ===== */
/*  API Keys                                                               */
/* ====================================================================== */
let keysSort = { col: 'created_at', dir: 'desc' };
let currentKeysList = [];

function sortKeys(list, col, dir) {
  return [...list].sort((a, b) => {
    let va = a[col];
    let vb = b[col];
    if (col === 'scopes') {
      va = (a.scopes || []).length;
      vb = (b.scopes || []).length;
    } else if (col === 'created_at' || col === 'expires_at' || col === 'last_used_at') {
      va = a[col] ? new Date(a[col]).getTime() : 0;
      vb = b[col] ? new Date(b[col]).getTime() : 0;
    } else if (col === 'revoked') {
      va = a.revoked ? 1 : 0;
      vb = b.revoked ? 1 : 0;
    } else if (col === 'rate_limit_per_minute') {
      va = a.rate_limit_per_minute != null ? a.rate_limit_per_minute : -1;
      vb = b.rate_limit_per_minute != null ? b.rate_limit_per_minute : -1;
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

function updateKeysTable(tbl) {
  tbl.querySelectorAll('th.sortable').forEach(th => {
    const col = th.dataset.col;
    const isSorted = keysSort.col === col;
    th.classList.toggle('sorted', isSorted);
    const iconEl = th.querySelector('.sort-icon');
    if (iconEl) iconEl.textContent = isSorted ? (keysSort.dir === 'asc' ? '▲' : '▼') : '↕';
  });
  const tbody = tbl.querySelector('tbody');
  if (!tbody) return;
  const sorted = sortKeys(currentKeysList, keysSort.col, keysSort.dir);
  let rows = '';
  sorted.forEach(k => {
    rows += `<tr style="${k.revoked ? 'opacity:.5' : ''}">
      <td class="mono">${esc(shortId(k.key_id))}</td>
      <td>${esc(k.label || '—')}</td>
      <td class="mono">${esc(k.prefix || '')}…</td>
      <td>${(k.scopes || []).map(s => `<span class="chip">${esc(s)}</span>`).join('')}</td>
      <td>${fmtDate(k.created_at)}</td>
      <td>${fmtDate(k.expires_at)}</td>
      <td>${k.revoked ? '<span class="badge badge-red">отозван</span>' : '<span class="badge badge-green">активен</span>'}</td>
      <td>${fmtDate(k.last_used_at)}</td>
      <td>${k.rate_limit_per_minute || '—'}</td>
      <td>
        ${!k.revoked ? `<div class="btn-group">
          <button class="btn btn-sm key-rotate" data-id="${esc(k.key_id)}" title="Ротация">🔄</button>
          <button class="btn btn-sm btn-danger key-revoke" data-id="${esc(k.key_id)}" title="Отозвать">⛔</button>
        </div>` : '—'}
      </td>
    </tr>`;
  });
  tbody.innerHTML = rows;
}

async function renderKeys(container) {
  $('#topbar-actions').innerHTML = '';
  $('#topbar-actions').appendChild(
    h('button', {class: 'btn btn-primary', onClick: showCreateKeyModal}, '+ Создать ключ')
  );

  try {
    const data = await API.get('/admin/keys', {include_revoked: true});
    currentKeysList = data.keys || [];
    container.innerHTML = '';

    if (!currentKeysList.length) {
      container.innerHTML = '<div class="empty-state"><span class="icon">🔑</span><p>Нет API-ключей</p></div>';
      return;
    }

    const keyColumns = [
      { key: 'key_id', label: 'ID' },
      { key: 'label', label: 'Label' },
      { key: 'prefix', label: 'Prefix' },
      { key: 'scopes', label: 'Scopes' },
      { key: 'created_at', label: 'Создан' },
      { key: 'expires_at', label: 'Истекает' },
      { key: 'revoked', label: 'Статус' },
      { key: 'last_used_at', label: 'Использован' },
      { key: 'rate_limit_per_minute', label: 'Rate/min' },
    ];

    const ths = keyColumns.map(c => {
      const isSorted = keysSort.col === c.key;
      const icon = isSorted ? (keysSort.dir === 'asc' ? '▲' : '▼') : '↕';
      return `<th class="sortable ${isSorted ? 'sorted' : ''}" data-col="${c.key}" title="Сортировать по ${c.label}">${c.label}<span class="sort-icon">${icon}</span></th>`;
    }).join('') + '<th></th>';

    const tbl = h('div', {class: 'table-wrap'});
    tbl.innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody></tbody></table>`;
    container.appendChild(tbl);
    updateKeysTable(tbl);

    tbl.addEventListener('click', async e => {
      const th = e.target.closest('th.sortable');
      if (th) {
        const col = th.dataset.col;
        if (keysSort.col === col) {
          keysSort.dir = keysSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          keysSort.col = col;
          keysSort.dir = 'asc';
        }
        updateKeysTable(tbl);
        return;
      }

      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('key-revoke')) {
        if (!confirmAction('Отозвать ключ?')) return;
        try {
          await API.post(`/admin/keys/${btn.dataset.id}/revoke`);
          toast('Ключ отозван', 'success');
          renderKeys(container);
        } catch (err) { toast(err.message, 'error'); }
      } else if (btn.classList.contains('key-rotate')) {
        try {
          const res = await API.post(`/admin/keys/${btn.dataset.id}/rotate`);
          showKeyResult(res);
          renderKeys(container);
        } catch (err) { toast(err.message, 'error'); }
      }
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

function showCreateKeyModal() {
  const form = h('div', null,
    h('div', {class: 'form-group'},
      h('label', null, 'Label'),
      h('input', {class: 'form-control', id: 'key-label', placeholder: 'My API Key'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Scopes'),
      h('div', {class: 'checkbox-group'},
        ...['ollama:read', 'ollama:generate', 'ollama:embed'].map(s =>
          h('label', null,
            h('input', {type: 'checkbox', class: 'key-scope', value: s, ...(s !== 'ollama:embed' ? {checked: ''} : {})}),
            s
          )
        )
      )
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'Rate Limit (req/min)'),
      h('input', {class: 'form-control', id: 'key-rate', type: 'number', placeholder: 'по умолчанию'})
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'TTL (секунды, пусто = бессрочно)'),
      h('input', {class: 'form-control', id: 'key-ttl', type: 'number', placeholder: '86400'})
    ),
    h('div', {class: 'modal-footer'},
      h('button', {class: 'btn', onClick: closeModal}, 'Отмена'),
      h('button', {class: 'btn btn-primary', onClick: submitCreateKey}, 'Создать')
    )
  );
  showModal('Создание API-ключа', form);
}

async function submitCreateKey() {
  const scopes = $$('.key-scope:checked').map(cb => cb.value);
  const body = {
    label: $('#key-label').value.trim(),
    scopes: scopes,
  };
  const rate = parseInt($('#key-rate')?.value);
  if (rate) body.rate_limit_per_minute = rate;
  const ttl = parseInt($('#key-ttl')?.value);
  if (ttl) body.ttl_seconds = ttl;

  try {
    const res = await API.post('/admin/keys', body);
    closeModal();
    showKeyResult(res);
    renderKeys($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

function showKeyResult(data) {
  const el = h('div', null,
    h('div', {style: {background: 'rgba(239,68,68,.1)', border: '1px solid var(--red)', borderRadius: '8px', padding: '12px', marginBottom: '16px'}},
      h('strong', {style: {color: 'var(--red)'}}, '⚠️ Сохраните ключ сейчас! Повторно он не выдаётся.')
    ),
    h('div', {class: 'form-group'},
      h('label', null, 'API Key'),
      h('input', {class: 'form-control mono', value: data.api_key, readonly: '', id: 'new-key-value',
        style: {fontSize: '13px', background: 'var(--bg)', letterSpacing: '.5px'}})
    ),
    h('div', {class: 'modal-footer'},
      h('button', {class: 'btn', onClick: () => { navigator.clipboard.writeText(data.api_key); toast('Скопировано', 'success'); }}, '📋 Копировать'),
      h('button', {class: 'btn btn-primary', onClick: closeModal}, 'Готово')
    )
  );
  showModal('Новый API-ключ', el);
}

