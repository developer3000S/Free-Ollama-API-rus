/* ===== FOA Gateway Admin Panel :: config.js ===== */
/*  Config                                                                 */
/* ====================================================================== */
let cachedConfigData = null;
let configSearchQuery = '';

async function renderConfig(container) {
  $('#topbar-actions').innerHTML = '';

  const searchInput = h('input', {
    type: 'text',
    id: 'config-search-input',
    placeholder: '🔍 Поиск ключей или значений...',
    style: {
      padding: '6px 12px',
      background: 'var(--bg3)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      color: 'var(--text)',
      width: '260px',
      fontSize: '13px',
      outline: 'none'
    },
    value: configSearchQuery
  });
  searchInput.addEventListener('input', (e) => {
    configSearchQuery = e.target.value;
    const treeEl = document.getElementById('config-tree');
    if (treeEl && cachedConfigData) {
      treeEl.innerHTML = renderJsonTree(cachedConfigData, 0, configSearchQuery);
    }
  });

  const actionsWrap = h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center'}},
    searchInput,
    h('button', {class: 'btn btn-primary', onClick: reloadConfig}, '🔄 Перезагрузить')
  );
  $('#topbar-actions').appendChild(actionsWrap);

  try {
    cachedConfigData = await API.get('/admin/config');
    container.innerHTML = '';

    // Theme Switcher Card
    const themeCard = h('div', {class: 'card', style: {marginBottom: '20px'}},
      h('div', {class: 'card-title', style: {marginBottom: '8px'}}, '🎨 Оформление интерфейса (Theme Switcher)'),
      h('div', {style: {fontSize: '13px', color: 'var(--text2)', marginBottom: '14px'}},
        'Выберите тему оформления панели управления. Настройки применяются мгновенно и сохраняются на вашем устройстве.'
      ),
      h('div', {style: {display: 'flex', gap: '10px', flexWrap: 'wrap'}},
        h('button', {
          id: 'theme-btn-dark',
          class: `btn btn-sm ${getThemePreference() === 'dark' ? 'btn-primary' : 'btn-outline'}`,
          onClick: () => { applyTheme('dark'); toast('Тёмная тема активирована', 'success'); }
        }, '🌙 Тёмная (Dark)'),
        h('button', {
          id: 'theme-btn-light',
          class: `btn btn-sm ${getThemePreference() === 'light' ? 'btn-primary' : 'btn-outline'}`,
          onClick: () => { applyTheme('light'); toast('Светлая тема активирована', 'success'); }
        }, '☀️ Светлая (Light)'),
        h('button', {
          id: 'theme-btn-system',
          class: `btn btn-sm ${getThemePreference() === 'system' ? 'btn-primary' : 'btn-outline'}`,
          onClick: () => { applyTheme('system'); toast('Системная тема активирована', 'success'); }
        }, '🖥️ Системная (System)')
      )
    );
    container.appendChild(themeCard);

    const pre = h('div', {class: 'card'},
      h('div', {class: 'card-title', style: {marginBottom: '12px'}}, 'Текущая конфигурация (секреты скрыты)'),
      h('div', {class: 'json-tree', id: 'config-tree'})
    );
    container.appendChild(pre);
    $('#config-tree').innerHTML = renderJsonTree(cachedConfigData, 0, configSearchQuery);

    // Toggle collapsed
    $('#config-tree').addEventListener('click', e => {
      const toggle = e.target.closest('.json-toggle');
      if (!toggle) return;
      toggle.classList.toggle('collapsed');
      const content = toggle.nextElementSibling;
      if (content) content.style.display = content.style.display === 'none' ? '' : 'none';
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

async function reloadConfig() {
  try {
    const data = await API.post('/admin/config/reload');
    toast(`Конфигурация перезагружена: ${(data.reloaded || []).join(', ')}`, 'success');
    renderConfig($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

function renderJsonTree(obj, indent = 0, query = '') {
  const q = (query || '').toLowerCase().trim();

  if (obj === null || obj === undefined) {
    const str = 'null';
    const match = q && str.includes(q);
    return `<span class="json-null ${match ? 'json-match' : ''}">${str}</span>`;
  }
  if (typeof obj === 'boolean') {
    const str = String(obj);
    const match = q && str.includes(q);
    return `<span class="json-bool ${match ? 'json-match' : ''}">${str}</span>`;
  }
  if (typeof obj === 'number') {
    const str = String(obj);
    const match = q && str.includes(q);
    return `<span class="json-number ${match ? 'json-match' : ''}">${str}</span>`;
  }
  if (typeof obj === 'string') {
    const val = esc(obj);
    const match = q && (val.toLowerCase().includes(q) || String(obj).toLowerCase().includes(q));
    return `<span class="json-string ${match ? 'json-match' : ''}">"${val}"</span>`;
  }

  const pad = '  '.repeat(indent);
  const pad1 = '  '.repeat(indent + 1);

  if (Array.isArray(obj)) {
    if (!obj.length) return '[]';
    const items = obj.map(v => `${pad1}${renderJsonTree(v, indent + 1, query)}`).join(',\n');
    return `[<br>${items}<br>${pad}]`;
  }

  const entries = Object.entries(obj);
  if (!entries.length) return '{}';

  const inner = entries.map(([k, v]) => {
    const keyMatch = q && k.toLowerCase().includes(q);
    const keyClass = keyMatch ? 'json-key json-match' : 'json-key';
    const kEsc = `"${esc(k)}"`;
    const formattedKey = `<span class="${keyClass}">${kEsc}</span>`;

    const isComplex = typeof v === 'object' && v !== null;
    if (isComplex) {
      return `${pad1}<span class="json-toggle">${formattedKey}</span>: <span>${renderJsonTree(v, indent + 1, query)}</span>`;
    }
    return `${pad1}${formattedKey}: ${renderJsonTree(v, indent + 1, query)}`;
  }).join(',<br>');

  return `{<br>${inner}<br>${pad}}`;
}

