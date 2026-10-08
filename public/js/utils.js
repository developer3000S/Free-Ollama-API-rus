/* ===== FOA Gateway Admin Panel :: utils.js ===== */
/* ====================================================================== */
/*  Utils                                                                  */
/* ====================================================================== */
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  });
  children.flat(9).forEach(c => {
    if (c == null) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

function shortId(id) { return id ? (id.length > 12 ? id.slice(0, 10) + '…' : id) : '—'; }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
}
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

function exportToCsv(filename, columns, dataRows) {
  if (!dataRows || !dataRows.length) return false;

  const escapeCell = (val) => {
    if (val === null || val === undefined) return '""';
    let str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    str = str.replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerLine = columns.map(c => escapeCell(c.label || c.key)).join(',');
  const rowLines = dataRows.map(row => {
    return columns.map(c => {
      let val = row[c.key];
      if (typeof c.format === 'function') {
        val = c.format(val, row);
      }
      return escapeCell(val);
    }).join(',');
  });

  const csvContent = '\uFEFF' + [headerLine, ...rowLines].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

function statusBadge(status) {
  const map = {
    healthy: 'green', verified: 'green', active: 'green',
    degraded: 'yellow', pending: 'yellow', pending_consent: 'yellow',
    consent_challenge_sent: 'yellow', challenge_sent: 'yellow',
    unhealthy: 'red', blacklisted: 'red', revoked: 'red', quarantined: 'red',
    failed: 'red', expired: 'red',
    draining: 'blue', candidate: 'cyan', none: 'gray',
    enrolled: 'blue', rejected: 'red', out_of_scope: 'gray', requires_manual_review: 'yellow',
  };
  const color = map[status] || 'gray';
  return `<span class="badge badge-${color}">${status || 'unknown'}</span>`;
}

function modelChips(models) {
  if (!models || !models.length) return '<span class="chip">—</span>';
  return models.slice(0, 5).map(m => `<span class="chip">${esc(m)}</span>`).join('') +
    (models.length > 5 ? `<span class="chip">+${models.length - 5}</span>` : '');
}

function esc(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toast(msg, type = 'info') {
  const el = h('div', {class: `toast toast-${type}`}, msg);
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showModal(title, contentEl, opts = {}) {
  const overlay = h('div', {class: 'modal-overlay', onClick: e => { if (e.target === overlay) overlay.remove(); }},
    h('div', {class: 'modal'},
      h('h3', null, title),
      contentEl
    )
  );
  $('#modals').appendChild(overlay);
  return overlay;
}

function closeModal() { const m = $('.modal-overlay'); if (m) m.remove(); }

function confirmAction(msg) { return window.confirm(msg); }

function showConfirmModal({ title, icon = '⚠️', message, details = [], confirmText = 'Подтвердить', confirmClass = 'btn-danger', onConfirm }) {
  closeModal();
  const content = h('div', null);

  const warnBox = h('div', {
    style: {
      background: 'rgba(239, 68, 68, 0.12)',
      border: '1px solid rgba(239, 68, 68, 0.3)',
      borderRadius: '8px',
      padding: '14px 16px',
      marginBottom: '16px',
      color: '#fca5a5',
      fontSize: '13px',
      lineHeight: '1.5'
    }
  });
  warnBox.innerHTML = message;
  content.appendChild(warnBox);

  if (details && details.length) {
    const listWrap = h('div', {style: {marginBottom: '16px'}});
    listWrap.innerHTML = `
      <div style="font-size: 12px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px;">
        Выбранные узлы (${details.length}):
      </div>
      <div style="max-height: 140px; overflow-y: auto; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-family: var(--font-mono); font-size: 12px;">
        ${details.map(d => `<div style="padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; justify-content: space-between; align-items: center;">
          <span class="mono" style="font-weight: 600;">${esc(d.id)}</span>
          <span style="color: var(--text-dim); font-size: 11px;">${esc(d.name || '')}</span>
        </div>`).join('')}
      </div>
    `;
    content.appendChild(listWrap);
  }

  const footer = h('div', {class: 'modal-footer'},
    h('button', {class: 'btn', onClick: closeModal}, 'Отмена'),
    h('button', {
      class: `btn ${confirmClass}`,
      onClick: async () => {
        closeModal();
        if (typeof onConfirm === 'function') {
          await onConfirm();
        }
      }
    }, confirmText)
  );
  content.appendChild(footer);

  return showModal(`${icon} ${title}`, content);
}

// ======================================================================
//  Theme Switcher (Dark / Light / System)
// ======================================================================
const THEME_STORAGE_KEY = 'foa_theme_mode';

function getThemePreference() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'system';
  } catch (e) {
    return 'system';
  }
}

function applyTheme(mode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (e) {}

  let effective = mode;
  if (mode === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    effective = prefersDark ? 'dark' : 'light';
  }

  if (effective === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  updateThemeSelectorUI(mode);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemePreference() === 'system') {
    applyTheme('system');
  }
});

applyTheme(getThemePreference());

function updateThemeSelectorUI(currentMode) {
  ['dark', 'light', 'system'].forEach(m => {
    const btn = document.getElementById(`theme-btn-${m}`);
    if (btn) {
      if (m === currentMode) {
        btn.className = 'btn btn-primary btn-sm';
      } else {
        btn.className = 'btn btn-outline btn-sm';
      }
    }
  });
}
