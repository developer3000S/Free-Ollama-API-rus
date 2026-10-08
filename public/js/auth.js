/* ===== FOA Gateway Admin Panel :: auth.js ===== */
/*  Auth                                                                   */
/* ====================================================================== */
async function doLogin() {
  const token = $('#login-token').value.trim();
  if (!token) { $('#login-error').textContent = 'Введите токен'; return; }
  API.token = token;
  try {
    const data = await API.get('/admin/status');
    sessionStorage.setItem('foa_token', token);
    $('#login-screen').style.display = 'none';
    $('#app').classList.add('active');
    $('#sidebar-version').textContent = `v${data.version || '?'}`;
    initRouter();
  } catch (e) {
    $('#login-error').textContent = 'Неверный токен или сервер недоступен';
    API.token = '';
  }
}

function doLogout() {
  sessionStorage.removeItem('foa_token');
  API.token = '';
  if (refreshTimer) clearInterval(refreshTimer);
  $('#app').classList.remove('active');
  $('#login-screen').style.display = 'flex';
  $('#login-token').value = '';
  $('#login-error').textContent = '';
}

// Auto-login
(function() {
  const saved = sessionStorage.getItem('foa_token');
  if (saved) {
    API.token = saved;
    API.get('/admin/status').then(data => {
      $('#login-screen').style.display = 'none';
      $('#app').classList.add('active');
      $('#sidebar-version').textContent = `v${data.version || '?'}`;
      initRouter();
    }).catch(() => { sessionStorage.removeItem('foa_token'); API.token = ''; });
  }
  // Enter key on login
  $('#login-token').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
})();

