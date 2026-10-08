/* ===== FOA Gateway Admin Panel :: apidocs.js ===== */
/*  API Docs & OpenAPI / Swagger UI                                      */
/* ====================================================================== */
async function renderApiDocs(container) {
  $('#topbar-actions').innerHTML = '';
  container.innerHTML = '<div class="loading">Загрузка OpenAPI / Swagger документации...</div>';

  try {
    container.innerHTML = '';

    const headerCard = h('div', {class: 'card', style: {marginBottom: '20px'}},
      h('div', {style: {display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px'}},
        h('div', null,
          h('div', {class: 'card-title', style: {fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px'}},
            h('span', null, '📖'),
            h('span', null, 'Free Ollama API Gateway — OpenAPI v3 / Swagger Docs')
          ),
          h('div', {style: {fontSize: '13px', color: 'var(--text2)', marginTop: '4px'}},
            'Интерактивная документация по REST API шлюза. Поддерживает Ollama-совместимый контракт, OpenAI-совместимый эндпоинт и административное управление.'
          )
        ),
        h('div', {style: {display: 'flex', gap: '8px'}},
          h('span', {class: 'badge badge-green'}, 'OpenAPI 3.0.1'),
          h('span', {class: 'badge badge-blue'}, 'Base URL: ' + location.origin)
        )
      )
    );
    container.appendChild(headerCard);

    // Поле API-ключа для «Try It Out»: пользовательские эндпоинты (/api/*, /v1/*)
    // аутентифицируются ключом foa_live_..., а не админ-токеном. Сырой ключ
    // хранится только в localStorage этого браузера.
    const keyCard = h('div', {class: 'card', style: {marginBottom: '20px'}},
      h('div', {style: {display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'}},
        h('label', {style: {fontSize: '13px', fontWeight: '600', whiteSpace: 'nowrap'}}, '🔑 API-ключ для пользовательских эндпоинтов:'),
        h('input', {
          id: 'docs-api-key',
          class: 'form-control mono',
          type: 'password',
          placeholder: 'foa_live_... (создайте в разделе API Keys)',
          style: {flex: '1', minWidth: '260px', fontSize: '13px'},
          value: localStorage.getItem('foa_docs_api_key') || '',
          oninput: (e) => localStorage.setItem('foa_docs_api_key', e.target.value)
        }),
        h('button', {
          class: 'btn btn-sm',
          onClick: () => {
            const el = $('docs-api-key');
            const v = el.value;
            el.type = el.type === 'password' ? 'text' : 'password';
            if (v && el.type === 'password') { navigator.clipboard && navigator.clipboard.writeText(v).catch(() => {}); }
          }
        }, '👁️')
      ),
      h('div', {style: {fontSize: '12px', color: 'var(--text2)', marginTop: '8px'}},
        'Эндпоинты «Bearer Token» тестируются этим ключом; админ-эндпоинты «Admin Token» — токеном из входа в панель.'
      )
    );
    container.appendChild(keyCard);

    const groups = [
      {
        title: '🤖 Ollama Compatible User API',
        desc: 'Контракт (§9.3) для взаимодействия с языковыми моделями через привычные Ollama REST эндпоинты.',
        endpoints: [
          { method: 'POST', path: '/api/chat', summary: 'Чат-комплишен с потоковой (SSE) или JSON выдачей', auth: 'Bearer Token', body: { model: 'llama3', messages: [{ role: 'user', content: 'Привет!' }] } },
          { method: 'POST', path: '/api/generate', summary: 'Генерация текста по промпту', auth: 'Bearer Token', body: { model: 'llama3:8b', prompt: 'Объясни квантовые вычисления в двух предложениях.' } },
          { method: 'GET', path: '/api/tags', summary: 'Получить список доступных моделей в маршрутизируемом пуле', auth: 'Bearer Token', body: null },
          { method: 'GET', path: '/api/version', summary: 'Получить версию шлюза', auth: 'Bearer Token', body: null },
        ]
      },
      {
        title: '⚡ OpenAI Compatible API (/v1/*)',
        desc: 'Совместимость с экосистемой OpenAI SDK, LangChain, LlamaIndex, Open WebUI и LibreChat.',
        endpoints: [
          { method: 'POST', path: '/v1/chat/completions', summary: 'OpenAI Chat Completions эндпоинт', auth: 'Bearer Token', body: { model: 'llama3', messages: [{ role: 'user', content: 'Hello!' }] } },
          { method: 'GET', path: '/v1/models', summary: 'OpenAI Models list', auth: 'Bearer Token', body: null },
        ]
      },
      {
        title: '🛡️ Admin Management API',
        desc: 'Эндпоинты административного контроля, мониторинга узлов, ключей и аудита.',
        endpoints: [
          { method: 'GET', path: '/admin/status', summary: 'Статус шлюза, статистика узлов, безопасность и метрики RPM за час', auth: 'Admin Token', body: null },
          { method: 'GET', path: '/admin/nodes?detailed=true', summary: 'Детальный реестр всех узлов пула с распределением задержек', auth: 'Admin Token', body: null },
          { method: 'GET', path: '/admin/keys', summary: 'Список всех выданных API-ключей', auth: 'Admin Token', body: null },
          { method: 'POST', path: '/admin/keys', summary: 'Выпустить новый API-ключ', auth: 'Admin Token', body: { label: 'SDK Client', scopes: ['ollama:generate'], rate_limit_per_minute: 120 } },
          { method: 'GET', path: '/admin/audit', summary: 'Журнал аудита системы', auth: 'Admin Token', body: null },
          { method: 'GET', path: '/admin/config', summary: 'Текущая конфигурация шлюза', auth: 'Admin Token', body: null },
        ]
      }
    ];

    groups.forEach((g, gIdx) => {
      const gCard = h('div', {class: 'card', style: {marginBottom: '16px'}},
        h('div', {style: {fontSize: '16px', fontWeight: '700', marginBottom: '6px'}}, g.title),
        h('div', {style: {fontSize: '13px', color: 'var(--text2)', marginBottom: '14px'}}, g.desc)
      );

      g.endpoints.forEach((ep, epIdx) => {
        const methodColor = ep.method === 'GET' ? 'var(--blue)' : ep.method === 'POST' ? 'var(--green)' : 'var(--red)';
        const epBox = h('div', {
          style: {
            background: 'var(--bg3)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            marginBottom: '10px',
            overflow: 'hidden'
          }
        });

        const epHeader = h('div', {
          style: {
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            cursor: 'pointer',
            background: 'var(--bg4)'
          },
          onClick: () => {
            const bodyDiv = document.getElementById(`doc-body-${gIdx}-${epIdx}`);
            if (bodyDiv) bodyDiv.style.display = bodyDiv.style.display === 'none' ? 'block' : 'none';
          }
        },
          h('div', {style: {display: 'flex', alignItems: 'center', gap: '12px'}},
            h('span', {style: {padding: '2px 8px', borderRadius: '4px', background: methodColor, color: '#fff', fontWeight: '700', fontSize: '11px', minWidth: '55px', textAlign: 'center'}}, ep.method),
            h('span', {class: 'mono', style: {fontWeight: '600', fontSize: '13px'}}, ep.path),
            h('span', {style: {fontSize: '12px', color: 'var(--text2)'}}, ep.summary)
          ),
          h('div', {style: {display: 'flex', alignItems: 'center', gap: '8px'}},
            h('span', {class: 'badge badge-gray', style: {fontSize: '11px'}}, ep.auth),
            h('span', {style: {fontSize: '12px', color: 'var(--text3)'}}, '▼')
          )
        );
        epBox.appendChild(epHeader);

        const epBody = h('div', {
          id: `doc-body-${gIdx}-${epIdx}`,
          style: {padding: '16px', display: 'none', borderTop: '1px solid var(--border)'}
        });

        let bodyHtml = `
          <div style="margin-bottom: 12px; font-size: 13px;"><strong>Описание:</strong> ${esc(ep.summary)}</div>
          <div style="margin-bottom: 12px; font-size: 13px;"><strong>Аутентификация:</strong> <code>${esc(ep.auth)}</code></div>
        `;

        if (ep.body) {
          bodyHtml += `
            <div style="margin-bottom: 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-dim);">Пример тела запроса (JSON):</div>
            <textarea id="doc-req-${gIdx}-${epIdx}" class="form-control mono" style="font-size: 12px; height: 100px; margin-bottom: 10px; resize: vertical;">${esc(JSON.stringify(ep.body, null, 2))}</textarea>
          `;
        }

        bodyHtml += `
          <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px;">
            <button class="btn btn-sm btn-primary" onclick="testApiDocEndpoint('${escAttr(ep.method)}', '${escAttr(ep.path)}', ${gIdx}, ${epIdx}, '${escAttr(ep.auth)}')">🚀 Выполнить запрос (Try It Out)</button>
          </div>
          <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px;">Ответ сервера:</div>
          <pre id="doc-res-${gIdx}-${epIdx}" class="mono" style="background: var(--bg); padding: 10px; border-radius: 6px; font-size: 12px; max-height: 220px; overflow-y: auto; color: var(--green);">Нажмите «Выполнить запрос», чтобы увидеть результат...</pre>
        `;

        epBody.innerHTML = bodyHtml;
        epBox.appendChild(epBody);
        gCard.appendChild(epBox);
      });

      container.appendChild(gCard);
    });

  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

async function testApiDocEndpoint(method, path, gIdx, epIdx, authType) {
  const resPre = document.getElementById(`doc-res-${gIdx}-${epIdx}`);
  if (!resPre) return;
  resPre.textContent = 'Выполнение запроса...';

  try {
    const reqTextEl = document.getElementById(`doc-req-${gIdx}-${epIdx}`);
    let bodyData = undefined;
    if (reqTextEl && reqTextEl.value) {
      try {
        bodyData = JSON.parse(reqTextEl.value);
      } catch (err) {
        resPre.textContent = 'Ошибка парсинга JSON тела запроса: ' + err.message;
        return;
      }
    }

    // Токен выбирается по типу аутентификации эндпоинта:
    //  - 'Bearer Token' — пользовательский API-ключ foa_live_... из поля выше;
    //  - 'Admin Token'  — админ/аудитор-токен, которым вошли в панель;
    //  - иначе (без авторизации) — заголовок Authorization не отправляем.
    let token = '';
    if (authType === 'Bearer Token') {
      token = (document.getElementById('docs-api-key') || {}).value || localStorage.getItem('foa_docs_api_key') || '';
      if (!token) {
        resPre.textContent = 'Введите API-ключ (foa_live_...) в поле выше, затем попробуйте снова.';
        resPre.style.color = 'var(--red)';
        return;
      }
    } else if (authType === 'Admin Token') {
      token = (typeof API !== 'undefined' && API.token) || sessionStorage.getItem('foa_token') || '';
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = {
      method,
      headers
    };
    if (bodyData && method !== 'GET') {
      opts.body = JSON.stringify(bodyData);
    }

    const start = Date.now();
    const response = await fetch(path, opts);
    const duration = Date.now() - start;
    const text = await response.text();
    let formatted = text;
    try {
      formatted = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {}

    resPre.textContent = `Status: ${response.status} ${response.statusText} (${duration}ms)\n\n${formatted}`;
    resPre.style.color = response.ok ? 'var(--green)' : 'var(--red)';
  } catch (err) {
    resPre.textContent = 'Ошибка запроса: ' + err.message;
    resPre.style.color = 'var(--red)';
  }
}
