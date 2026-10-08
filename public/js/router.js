/* ===== FOA Gateway Admin Panel :: router.js ===== */
/* ====================================================================== */
/*  Router                                                                 */
/* ====================================================================== */
let currentPage = '';
let refreshTimer = null;
let dashboardRpmChartInstance = null;

const pages = {
  dashboard: { title: 'Dashboard', icon: '📊', render: renderDashboard },
  monitor:   { title: 'Monitor', icon: '📈', render: renderMonitor },
  nodes:     { title: 'Узлы', icon: '🖥️', render: renderNodes },
  consents:  { title: 'Согласия', icon: '✅', render: renderConsents },
  blacklist: { title: 'Чёрный список', icon: '🚫', render: renderBlacklist },
  discovery: { title: 'Discovery', icon: '🔍', render: renderDiscovery },
  keys:      { title: 'API-ключи', icon: '🔑', render: renderKeys },
  audit:     { title: 'Журнал аудита', icon: '📋', render: renderAudit },
  config:    { title: 'Конфигурация', icon: '⚙️', render: renderConfig },
  apidocs:   { title: 'API Docs & OpenAPI', icon: '📖', render: renderApiDocs },
  help:      { title: 'Помощь', icon: '❓', render: renderHelp },
};

function navigate(page) {
  if (!pages[page]) page = 'dashboard';
  currentPage = page;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  const bt = document.getElementById('bulk-toolbar');
  if (bt) bt.remove();
  if (page !== 'nodes') selectedNodes.clear();
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
  pages[page].render(content);
}

function initRouter() {
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1).split('/')[0]));
  navigate(location.hash.slice(1).split('/')[0] || 'dashboard');
}

