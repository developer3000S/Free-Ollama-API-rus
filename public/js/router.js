/* ===== FOA Gateway Admin Panel :: router.js ===== */
/* ====================================================================== */
/*  Router                                                                 */
/* ====================================================================== */
let currentPage = '';
let refreshTimer = null;
let dashboardRpmChartInstance = null;

/* Страницы регистрируются лениво: функции render* берутся из глобальной
   области видимости в момент навигации (initRouter вызывается из auth.js,
   когда все скрипты уже загружены). Это исключает ReferenceError при
   загрузке router.js раньше модулей страниц и позволяет в будущем
   подключать страницы динамически. */
const pages = {
  dashboard: { title: 'Dashboard', icon: '📊', renderName: 'renderDashboard' },
  monitor:   { title: 'Monitor', icon: '📈', renderName: 'renderMonitor' },
  nodes:     { title: 'Узлы', icon: '🖥️', renderName: 'renderNodes' },
  blacklist: { title: 'Чёрный список', icon: '🚫', renderName: 'renderBlacklist' },
  discovery: { title: 'Discovery', icon: '🔍', renderName: 'renderDiscovery' },
  keys:      { title: 'API-ключи', icon: '🔑', renderName: 'renderKeys' },
  audit:     { title: 'Журнал аудита', icon: '📋', renderName: 'renderAudit' },
  config:    { title: 'Конфигурация', icon: '⚙️', renderName: 'renderConfig' },
  apidocs:   { title: 'API Docs & OpenAPI', icon: '📖', renderName: 'renderApiDocs' },
  help:      { title: 'Помощь', icon: '❓', renderName: 'renderHelp' },
};

function getPageRender(page) {
  const fn = window[pages[page].renderName];
  if (typeof fn !== 'function') {
    throw new Error(`Страница "${page}" не загружена: ${pages[page].renderName} не определена`);
  }
  return fn;
}

function navigate(page) {
  if (!pages[page]) page = 'dashboard';
  currentPage = page;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  const bt = document.getElementById('bulk-toolbar');
  if (bt) bt.remove();
  if (typeof selectedNodes !== 'undefined' && page !== 'nodes') selectedNodes.clear();
  if (page !== 'dashboard' && dashboardRpmChartInstance) {
    dashboardRpmChartInstance.destroy();
    dashboardRpmChartInstance = null;
  }

  // Update sidebar
  $$('.sidebar-nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  // Update title
  $('#page-title').textContent = pages[page].title;
  // Clear actions
  $('#topbar-actions').innerHTML = '';
  // Render
  const content = $('#content');
  content.innerHTML = '<div class="loading">Загрузка…</div>';
  try {
    getPageRender(page)(content);
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

/* Инициализация маршрутизатора. Вызывается из auth.js после входа,
   когда все скрипты страниц уже загружены и их функции доступны. */
function initRouter() {
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1).split('/')[0]));
  navigate(location.hash.slice(1).split('/')[0] || 'dashboard');
}

