/* ===== FOA Gateway Admin Panel :: help.js ===== */
/*  Help & Documentation                                                   */
/* ====================================================================== */
function copyHelpCode(btn) {
  const code = btn.getAttribute('data-code') || '';
  navigator.clipboard.writeText(code);
  toast('Скопировано в буфер обмена', 'success');
}

function toggleFaqItem(el) {
  const item = el.closest('.faq-item');
  if (item) {
    item.classList.toggle('open');
  }
}

function toggleAllFaq() {
  const items = document.querySelectorAll('.faq-item');
  if (!items.length) return;
  const anyClosed = Array.from(items).some(i => !i.classList.contains('open'));
  items.forEach(i => i.classList.toggle('open', anyClosed));
}

async function renderHelp(container) {
  $('#topbar-actions').innerHTML = '';
  const origin = window.location.origin;

  // Шлюз поддерживает два варианта подключения: основной HTTPS и запасной plain-HTTP
  // для клиентов, отклоняющих самоподписанный сертификат (DEPTH_ZERO_SELF_SIGNED_CERT).
  // Список берём с сервера, чтобы порты совпадали с FOA_HTTP_PORT / FOA_HTTPS_PORT.
  let endpoints = [];
  try {
    const data = await API.get('/api/endpoints');
    endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
  } catch (e) {
    endpoints = [];
  }
  // Текущий способ подключения показываем в любом случае, даже если сервер не ответил.
  if (!endpoints.some((e) => e.url === origin)) {
    endpoints = [{ url: origin, scheme: location.protocol.replace(':', ''), label: 'Текущее подключение', description: 'Эндпоинт, по которому открыта эта панель.' }].concat(endpoints);
  }

  const curlCode = `curl -X POST ${origin}/api/chat \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "llama3",
    "messages": [{"role": "user", "content": "Привет!"}]
  }'`;

  const pythonCode = `from openai import OpenAI

client = OpenAI(
    base_url="${origin}/v1",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="llama3",
    messages=[{"role": "user", "content": "Привет!"}]
)
print(response.choices[0].message.content)`;

  const headerCode = "Authorization: Bearer <ваш-api-ключ>";

  container.innerHTML = `
    <div class="help-hero">
      <h2 style="font-size: 20px; font-weight: 600; margin-bottom: 8px; color: var(--text);">📖 Руководство пользователя и интеграция с API Ollama</h2>
      <p style="color: var(--text2); font-size: 14px; line-height: 1.5;">
        Единый шлюз (Unified Gateway) автоматически агрегирует, балансирует и проксирует запросы ко всем найденным, проверенным и разрешенным узлам Ollama через один стандартный эндпоинт. Вам больше не нужно управлять множеством различных адресов — один API-ключ и один базовый URL работают для всех моделей.
      </p>
    </div>

    <div class="help-card">
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--text);">🌐 1. Единый базовый URL эндпоинта шлюза</h3>
      <p style="color: var(--text2); font-size: 13px; margin-bottom: 12px;">
        Все запросы к моделям Ollama (включая совместимые с OpenAI стандарты) направляются на единый эндпоинт шлюза. Доступно два варианта подключения — используйте любой из них, API-ключ действует один и тот же:
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px;">
        ${endpoints.map((e) => `
        <div style="background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
            <strong style="color: var(--text); font-size: 13px;">${e.scheme === 'http' ? '🔓' : '🔒'} ${esc(e.label || e.url)}</strong>
            <button class="btn" style="padding: 2px 8px; font-size: 11px;" data-code="${escAttr(e.url)}" onclick="copyHelpCode(this)">Копировать URL</button>
          </div>
          <pre style="padding: 10px 12px; font-family: monospace; font-size: 13px; color: #38bdf8; overflow-x: auto; margin: 0 0 8px 0; border-radius: 6px; background: var(--bg3);">${esc(e.url)}</pre>
          <div style="color: var(--text2); font-size: 12px; line-height: 1.5;">${esc(e.description || '')}</div>
        </div>`).join('')}
      </div>
      <p style="color: var(--text2); font-size: 12px; margin-top: 10px;">
        * Если ваше приложение выдает ошибку сертификата при обращении по HTTPS (например, <code>DEPTH_ZERO_SELF_SIGNED_CERT</code>), используйте эндпоинт <strong>HTTP (без SSL)</strong> — это обычный HTTP, шифрование не требуется.
      </p>
    </div>

    <div class="help-card">
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--text);">🔑 2. Формат заголовка аутентификации (Authentication Header)</h3>
      <p style="color: var(--text2); font-size: 13px; margin-bottom: 10px;">
        Для доступа к API шлюза требуется передавать ваш API-ключ в заголовок HTTP-запроса. Шлюз поддерживает стандартный Bearer-токен:
      </p>
      <div class="code-container">
        <div class="code-header">
          <span style="font-family: monospace; font-size: 12px; color: var(--accent);">HTTP Header Format</span>
          <button class="btn" style="padding: 2px 8px; font-size: 11px;" data-code="${headerCode}" onclick="copyHelpCode(this)">Копировать</button>
        </div>
        <pre style="padding: 12px; font-family: monospace; font-size: 13px; color: #38bdf8; overflow-x: auto; margin: 0;">Authorization: Bearer foa_live_xxxxxxxxxxxxxxxxxxxxxxxx</pre>
      </div>
      <p style="color: var(--text2); font-size: 12px; margin-top: 8px;">
        * Вы можете сгенерировать и управлять своими ключами в разделе <a href="#keys" style="color: var(--accent); text-decoration: underline;">«API-ключи»</a> в боковом меню.
      </p>
    </div>

    <div class="help-card">
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; color: var(--text);">🚀 3. Поддерживаемые эндпоинты и примеры интеграции</h3>
      <p style="color: var(--text2); font-size: 13px; margin-bottom: 12px;">
        Шлюз поддерживает как стандартные Ollama API эндпоинты, так и OpenAI-совместимые чат-комплишены:
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px;">
        <div style="background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
          <strong style="color: var(--text); font-size: 13px;">Ollama Native API</strong>
          <ul style="color: var(--text2); font-size: 12px; margin-top: 6px; padding-left: 16px; line-height: 1.6;">
            <li><code>POST /api/chat</code> — Чат генерация</li>
            <li><code>POST /api/generate</code> — Текстовая генерация</li>
            <li><code>GET /api/tags</code> — Список доступных моделей</li>
          </ul>
        </div>
        <div style="background: var(--bg); padding: 12px; border-radius: 8px; border: 1px solid var(--border);">
          <strong style="color: var(--text); font-size: 13px;">OpenAI Compatible API</strong>
          <ul style="color: var(--text2); font-size: 12px; margin-top: 6px; padding-left: 16px; line-height: 1.6;">
            <li><code>POST /v1/chat/completions</code> — Chat Completions</li>
            <li><code>GET /v1/models</code> — Models list</li>
          </ul>
        </div>
      </div>

      <h4 style="font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--text);">Пример запроса (cURL / Ollama API):</h4>
      <div class="code-container">
        <div class="code-header">
          <span style="font-family: monospace; font-size: 12px; color: var(--accent);">cURL (bash)</span>
          <button class="btn" style="padding: 2px 8px; font-size: 11px;" data-code="${escAttr(curlCode)}" onclick="copyHelpCode(this)">Копировать cURL</button>
        </div>
        <pre style="padding: 12px; font-family: monospace; font-size: 12px; color: #a5f3fc; overflow-x: auto; margin: 0;">${esc(curlCode)}</pre>
      </div>

      <h4 style="font-size: 14px; font-weight: 600; margin: 16px 0 8px; color: var(--text);">Пример подключения (Python / OpenAI SDK / LangChain):</h4>
      <div class="code-container">
        <div class="code-header">
          <span style="font-family: monospace; font-size: 12px; color: var(--accent);">Python</span>
          <button class="btn" style="padding: 2px 8px; font-size: 11px;" data-code="${escAttr(pythonCode)}" onclick="copyHelpCode(this)">Копировать Python</button>
        </div>
        <pre style="padding: 12px; font-family: monospace; font-size: 12px; color: #a5f3fc; overflow-x: auto; margin: 0;">${esc(pythonCode)}</pre>
      </div>
    </div>

    <div class="help-card" id="help-faq-section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 8px;">
        <h3 style="font-size: 16px; font-weight: 600; color: var(--text);">❓ 4. Часто задаваемые вопросы (FAQ)</h3>
        <button class="btn btn-xs" style="font-size: 11px; padding: 3px 10px;" onclick="toggleAllFaq()">Развернуть / Свернуть все</button>
      </div>
      <p style="color: var(--text2); font-size: 13px; margin-bottom: 14px;">
        Ответы на распространенные технические проблемы, ошибки подключения и рекомендации по настройке запросов к шлюзу:
      </p>

      <div class="faq-list">
        <!-- FAQ 1 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>🔒 Ошибка 401 Unauthorized: не принимается API-ключ</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Убедитесь, что в HTTP-заголовке передается правильный префикс: <code>Authorization: Bearer &lt;ваш_ключ&gt;</code>.<br>
            API-ключ должен быть создан в разделе <strong>«API-ключи»</strong> и находиться в активном статусе (<code>Active</code>). Проверьте, что в токене отсутствуют случайные пробелы и переносы строк, а префикс соответствует <code>foa_live_...</code>.
          </div>
        </div>

        <!-- FAQ 2 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>🌐 Ошибка 503 Service Unavailable: нет доступных или здоровых узлов</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Шлюз направляет трафик исключительно на узлы с подтвержденным согласием владельца и статусом <code>Verified</code> / <code>Healthy</code>. Если все узлы в пуле недоступны или перегружены, возвращается код 503.<br>
            <strong>Решение:</strong> Проверьте состояние узлов в разделах <strong>«Узлы»</strong> и <strong>«Monitor»</strong>. Если требуются дополнительные мощности, перейдите в <strong>«Discovery»</strong> и проведите автоматическую или ручную верификацию кандидатов.
          </div>
        </div>

        <!-- FAQ 3 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>🧠 Ошибка 404 Not Found: запрашиваемая модель не найдена</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Модель должна присутствовать в списке разрешенных моделей хотя бы одного активного узла, имеющего право обслуживать эту модель по условиям согласия.<br>
            Выполните запрос <code>GET /api/tags</code> или <code>GET /v1/models</code> для получения точного перечня доступных тегов моделей (например, <code>llama3:latest</code>, <code>mistral:7b</code>, <code>qwen2.5:coder</code>).
          </div>
        </div>

        <!-- FAQ 4 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>⏱️ Разрыв соединения или 504 Gateway Timeout при объемных ответах</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            При генерации длинных текстов запросы могут выполняться продолжительное время. Для предотвращения разрыва HTTP-соединения промежуточными прокси используйте <strong>потоковый режим (Streaming)</strong>:<br>
            - В Ollama API: передавайте флаг <code>"stream": true</code> (ответ поступает чанками в формате NDJSON).<br>
            - В OpenAI-совместимом API: передавайте <code>"stream": true</code> (ответ поступает как Server-Sent Events).
          </div>
        </div>

        <!-- FAQ 5 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>⚠️ Ошибка 429 Too Many Requests: исчерпан лимит запросов</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Шлюз защищает подключенные узлы от перегрузки с помощью многоуровневых лимитов: RPS на пользователя, лимит параллельных запросов (Concurrency) и дневные квоты.<br>
            При получении ошибки 429 соблюдайте интервал ожидания из заголовка <code>Retry-After</code> и используйте стратегию повторов с экспоненциальной задержкой (Exponential Backoff). Администратор системы может изменить квоты в разделе <strong>«Конфигурация»</strong>.
          </div>
        </div>

        <!-- FAQ 6 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>🌍 Поддержка CORS при обращении из браузера или веб-интерфейсов</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Шлюз полностью настроен для поддержки CORS (Cross-Origin Resource Sharing). Заголовки <code>Access-Control-Allow-Origin: *</code> и <code>Access-Control-Allow-Headers: Authorization, Content-Type</code> автоматически возвращаются на запросы, включая preflight <code>OPTIONS</code>. Шлюз можно подключать напрямую в Open WebUI, LibreChat, SillyTavern или браузерные расширения.
          </div>
        </div>

        <!-- FAQ 7 -->
        <div class="faq-item">
          <div class="faq-question" onclick="toggleFaqItem(this)">
            <span>📛 Ошибка сертификата: DEPTH_ZERO_SELF_SIGNED_CERT / self-signed certificate</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Шлюз использует самоподписанный TLS-сертификат, поэтому часть клиентов (Node.js fetch, Python requests со строгой проверкой, некоторые SDK) отказываются подключаться по HTTPS с ошибкой <code>DEPTH_ZERO_SELF_SIGNED_CERT</code> или <code>SSL: certificate subject name mismatch</code>.<br>
            <strong>Решение 1 (рекомендуется):</strong> используйте второй эндпоинт шлюза по обычному HTTP — <code>http://&lt;адрес-шлюза&gt;:8080</code> (без шифрования, без проверки сертификата). API-ключ и набор эндпоинтов те же самые.<br>
            <strong>Решение 2:</strong> продолжайте работать по HTTPS, но явно сделайте сертификат доверенным для клиента: добавьте <code>deploy/tls/fullchain.pem</code> в системное хранилище ОС, либо передайте его в программу через переменные <code>NODE_EXTRA_CA_CERTS</code> (Node.js) / <code>REQUESTS_CA_BUNDLE</code> и <code>SSL_CERT_FILE</code> (Python).<br>
            <strong>Решение 3:</strong> для разовой отладки можно отключить проверку сертификата в клиенте (<code>curl -k</code>, <code>rejectUnauthorized: false</code> и т. п.) — но для постоянного использования это не рекомендуется.
          </div>
        </div>
      </div>
    </div>
  `;
}

