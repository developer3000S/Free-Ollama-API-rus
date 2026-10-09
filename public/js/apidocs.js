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

    // Список эндпоинтов загружается с сервера (GET /admin/apidocs/spec),
    // который обходит стек роутов Express. Раньше список был захардкожен
    // здесь и рассинхронизировался с кодом — новые эндпоинты не попадали
    // на страницу. Теперь любой добавленный маршрут отображается автоматически.
    let spec;
    try {
      spec = await API.get('/admin/apidocs/spec');
    } catch (e) {
      container.appendChild(h('div', {class: 'empty-state'},
        h('span', {class: 'icon'}, '⚠️'),
        h('p', null, 'Не удалось загрузить спецификацию API: ' + esc(e.message || 'нет ответа сервера'))
      ));
      return;
    }
    const routes = Array.isArray(spec?.routes) ? spec.routes : [];
    if (!routes.length) {
      container.appendChild(h('div', {class: 'empty-state'},
        h('span', {class: 'icon'}, '📭'),
        h('p', null, 'Маршруты не найдены')
      ));
      return;
    }

    // Группировка маршрутов по разделам в порядке, заданном сервером.
    const groupMap = new Map();
    for (const r of routes) {
      if (!groupMap.has(r.group)) groupMap.set(r.group, []);
      groupMap.get(r.group).push(r);
    }

    // Поле поиска: фильтрует по методу, пути и описанию — при 60+ эндпоинтах
    // без него нужный маршрут не найти.
    const searchWrap = h('div', {class: 'card', style: {marginBottom: '20px', padding: '12px 16px'}},
      h('div', {style: {display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap'}},
        h('span', {style: {fontSize: '14px'}}, '🔍'),
        h('input', {
          id: 'apidocs-search',
          class: 'form-control',
          type: 'search',
          placeholder: `Поиск по ${routes.length} эндпоинтам (путь, метод, описание)…`,
          style: {flex: '1', minWidth: '240px', fontSize: '13px'},
          oninput: () => applyApiDocsFilter(),
        }),
        h('span', {
          id: 'apidocs-count',
          style: {fontSize: '12px', color: 'var(--text2)', whiteSpace: 'nowrap'}
        }, `${routes.length} / ${routes.length}`)
      )
    );
    container.appendChild(searchWrap);

    const groupsContainer = h('div', {id: 'apidocs-groups'});
    container.appendChild(groupsContainer);

    function applyApiDocsFilter() {
      const q = ($('#apidocs-search')?.value || '').trim().toLowerCase();
      const cnt = $('#apidocs-count');
      let shown = 0;
      groupsContainer.innerHTML = '';

      groupMap.forEach((eps, gTitle) => {
        const filtered = q
          ? eps.filter((ep) =>
              ep.path.toLowerCase().includes(q) ||
              ep.method.toLowerCase().includes(q) ||
              (ep.summary || '').toLowerCase().includes(q))
          : eps;
        shown += filtered.length;
        if (!filtered.length) return;

        const gCard = h('div', {class: 'card', style: {marginBottom: '16px'}},
          h('div', {style: {fontSize: '16px', fontWeight: '700', marginBottom: '6px'}}, gTitle),
          h('div', {style: {fontSize: '13px', color: 'var(--text2)', marginBottom: '14px'}}, `${filtered.length} эндпоинтов`)
        );

        filtered.forEach((ep) => {
          const gIdx = gTitle, epIdx = ep.path + ep.method;
          const methodColor = ep.method === 'GET' ? 'var(--blue)' : ep.method === 'POST' ? 'var(--green)' : ep.method === 'DELETE' ? 'var(--red)' : 'var(--text2)';
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
            h('div', {style: {display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap'}},
              h('span', {style: {padding: '2px 8px', borderRadius: '4px', background: methodColor, color: '#fff', fontWeight: '700', fontSize: '11px', minWidth: '55px', textAlign: 'center'}}, ep.method),
              h('span', {class: 'mono', style: {fontWeight: '600', fontSize: '13px'}}, ep.path),
              h('span', {style: {fontSize: '12px', color: 'var(--text2)'}}, ep.summary || '')
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
            <div style="margin-bottom: 12px; font-size: 13px;"><strong>Описание:</strong> ${esc(ep.summary || '—')}</div>
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
              <button class="btn btn-sm btn-primary" onclick="testApiDocEndpoint('${escAttr(ep.method)}', '${escAttr(ep.path)}', '${gIdx}', '${escAttr(epIdx)}', '${escAttr(ep.auth)}')">🚀 Выполнить запрос (Try It Out)</button>
            </div>
            <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-dim); margin-bottom: 6px;">Ответ сервера:</div>
            <pre id="doc-res-${gIdx}-${epIdx}" class="mono" style="background: var(--bg); padding: 10px; border-radius: 6px; font-size: 12px; max-height: 220px; overflow-y: auto; color: var(--green);">Нажмите «Выполнить запрос», чтобы увидеть результат...</pre>
          `;

          epBody.innerHTML = bodyHtml;
          epBox.appendChild(epBody);
          gCard.appendChild(epBox);
        });

        groupsContainer.appendChild(gCard);
      });

      if (cnt) cnt.textContent = `${shown} / ${routes.length}`;
    }

    applyApiDocsFilter();

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
