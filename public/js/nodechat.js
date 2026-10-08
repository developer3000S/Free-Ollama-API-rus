/* ===== FOA Gateway Admin Panel :: nodechat.js ===== */
/*  Чат с конкретным узлом: модалка с историей сообщений, отправка через
 *  POST /admin/nodes/:id/chat — прямой прокси на узел под adminAuth.
 *  Раньше чат ходил на /api/chat (userAuth) с токеном панели, из-за чего
 *  получал «Ошибка: Недействительный API-ключ». Список моделей узла
 *  подтягивается через GET /admin/nodes/:id/models в выпадающий выбор. */

const nodeChatState = {
  nodeId: null,
  model: null,    // выбранная модель узла (null → первая доступная)
  models: [],     // список моделей узла для <select>
  messages: [],   // { role: 'user' | 'assistant', content, time }
  sending: false,
};

// История чатов по узлам сохраняется между открытиями окна (в рамках сессии)
const nodeChatHistories = {};

function showNodeChatModal(nodeId) {
  const node = (currentNodesList || []).find(n => n.node_id === nodeId);
  const title = `💬 Чат с узлом ${shortId(nodeId)}${node && node.display_name ? ` · ${node.display_name}` : ''}`;

  if (nodeChatState.nodeId !== nodeId) {
    nodeChatState.nodeId = nodeId;
    nodeChatState.messages = nodeChatHistories[nodeId] || [];
    nodeChatState.sending = false;
    nodeChatState.models = (node && Array.isArray(node.models)) ? node.models.slice() : [];
    nodeChatState.model = nodeChatState.models[0] || null;
  }

  const modelSelect = h('select', {
    class: 'form-control node-chat-model-select', id: 'node-chat-model-select',
    title: 'Модель узла для чата',
  }, h('option', { value: '' }, 'Загрузка моделей…'));

  const el = h('div', {class: 'node-chat'},
    h('div', {class: 'node-chat-meta'},
      node
        ? `Endpoint: ${node.endpoint || '—'} · Статус: ${node.status || '—'}`
        : `Узел: ${esc(nodeId)}`
    ),
    h('div', {class: 'node-chat-model-row'},
      h('label', {class: 'node-chat-model-label', for: 'node-chat-model-select'}, 'Модель:'),
      modelSelect
    ),
    h('div', {class: 'node-chat-messages', id: 'node-chat-messages'}),
    h('form', {class: 'node-chat-input-row', id: 'node-chat-form'},
      h('input', {
        type: 'text', class: 'form-control node-chat-input', id: 'node-chat-input',
        placeholder: 'Введите сообщение для узла…', autocomplete: 'off', required: true
      }),
      h('button', {type: 'submit', class: 'btn btn-primary node-chat-send', id: 'node-chat-send'}, 'Отправить')
    )
  );

  const overlay = showModal(title, el, { wide: true });
  overlay.classList.add('modal-overlay-wide');

  renderNodeChatMessages();
  renderNodeChatModelSelect();
  loadNodeChatModels(nodeId); // GET /admin/nodes/:id/models — актуальный список с узла

  modelSelect.addEventListener('change', () => {
    nodeChatState.model = modelSelect.value || null;
  });

  const form = el.querySelector('#node-chat-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = el.querySelector('#node-chat-input');
    const text = (input.value || '').trim();
    if (!text || nodeChatState.sending) return;
    input.value = '';
    await sendNodeChatMessage(nodeId, text);
  });

  setTimeout(() => { const i = el.querySelector('#node-chat-input'); if (i) i.focus(); }, 50);
}

// Загрузка списка моделей узла: GET /admin/nodes/:id/models. Сервер сначала
// отдаёт кэш node.models, при пустоте опрашивает узел (GET <endpoint>/api/tags).
async function loadNodeChatModels(nodeId) {
  try {
    const res = await API.get(`/admin/nodes/${encodeURIComponent(nodeId)}/models`);
    if (nodeChatState.nodeId !== nodeId) return; // окно уже закрыто/переключено
    const list = Array.isArray(res && res.models) ? res.models : [];
    nodeChatState.models = list;
    if (list.length && !list.includes(nodeChatState.model)) {
      nodeChatState.model = list[0];
    }
    if (!list.length && !nodeChatState.model) nodeChatState.model = null;
    renderNodeChatModelSelect();
  } catch (err) {
    if (nodeChatState.nodeId !== nodeId) return;
    renderNodeChatModelSelect(String(err && err.message || 'не удалось загрузить'));
  }
}

function renderNodeChatModelSelect(errorText) {
  const sel = document.querySelector('#node-chat-model-select');
  if (!sel) return;
  sel.innerHTML = '';
  const models = nodeChatState.models || [];
  if (errorText && !models.length) {
    sel.appendChild(h('option', { value: '' }, `⚠️ ${errorText}`));
    sel.disabled = true;
    return;
  }
  if (!models.length) {
    sel.appendChild(h('option', { value: '' }, 'Модели недоступны'));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const m of models) {
    const opt = h('option', { value: m }, m);
    if (m === nodeChatState.model) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!nodeChatState.model || !models.includes(nodeChatState.model)) {
    nodeChatState.model = models[0];
    sel.value = models[0];
  }
}

async function sendNodeChatMessage(nodeId, text) {
  nodeChatState.messages.push({ role: 'user', content: text, time: new Date() });
  nodeChatHistories[nodeId] = nodeChatState.messages;
  nodeChatState.sending = true;
  renderNodeChatMessages();
  setNodeChatBusy(true);

  try {
    const body = {
      messages: nodeChatState.messages.map(m => ({ role: m.role, content: m.content })),
    };
    if (nodeChatState.model) body.model = nodeChatState.model;

    // Прямой прокси на узел под adminAuth — без пользовательского API-ключа
    const res = await API.post(
      `/admin/nodes/${encodeURIComponent(nodeId)}/chat`,
      body
    );
    const reply =
      (res && typeof res.reply === 'string') ? res.reply :
      (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) ||
      (res && res.content) ||
      (res && res.response) ||
      null;
    nodeChatState.messages.push({
      role: 'assistant',
      content: reply != null ? String(reply) : '(пустой ответ)',
      time: new Date(),
    });
  } catch (err) {
    const msg = String(err && err.message || 'неизвестная ошибка');
    // Сетевая недоступность узла (502 «fetch failed» / таймауты): даём
    // понятную подсказку и кнопку повтора вместо голой технической ошибки.
    const unreachable = /недоступен|fetch failed|таймаут|не отвечает|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg);
    let hint = '';
    if (unreachable) {
      const node = (currentNodesList || []).find(n => n.node_id === nodeId);
      hint = `\nПодсказка: проверьте, что Ollama запущена на адресе ${node && node.endpoint ? node.endpoint : 'узла'} `
        + 'и доступен из сети шлюза (кнопка «Проверить здоровье» на карточке узла).';
    }
    nodeChatState.messages.push({
      role: 'assistant', error: true, retryText: unreachable ? text : null,
      content: `⚠️ Ошибка: ${msg}${hint}`, time: new Date(),
    });
  } finally {
    nodeChatState.sending = false;
    nodeChatHistories[nodeId] = nodeChatState.messages;
    setNodeChatBusy(false);
    renderNodeChatMessages();
    const i = document.querySelector('#node-chat-input');
    if (i) i.focus();
  }
}

function setNodeChatBusy(busy) {
  const btn = document.querySelector('#node-chat-send');
  const inp = document.querySelector('#node-chat-input');
  if (btn) { btn.disabled = busy; btn.textContent = busy ? '…' : 'Отправить'; }
  if (inp) inp.disabled = busy;
}

function renderNodeChatMessages() {
  const box = document.querySelector('#node-chat-messages');
  if (!box) return;
  if (!nodeChatState.messages.length) {
    box.innerHTML = '<div class="node-chat-empty">Начните диалог — сообщения будут отправляться напрямую на выбранный узел.</div>';
    return;
  }
  box.innerHTML = nodeChatState.messages.map((m, idx) => {
    const cls = m.role === 'user' ? 'msg-user' : (m.error ? 'msg-error' : 'msg-assistant');
    const author = m.role === 'user' ? 'Вы' : 'Узел';
    const t = m.time ? m.time.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}) : '';
    const retryBtn = m.error && m.retryText
      ? `<button type="button" class="btn btn-sm node-chat-retry" data-idx="${idx}">🔁 Повторить</button>`
      : '';
    return `<div class="node-chat-msg ${cls}">
      <div class="node-chat-msg-head">${author}<span class="node-chat-msg-time">${t}</span></div>
      <div class="node-chat-msg-body">${esc(m.content).replace(/\n/g, '<br>')}</div>
      ${retryBtn}
    </div>`;
  }).join('');
  box.querySelectorAll('.node-chat-retry').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-idx'));
      const failed = nodeChatState.messages[i];
      if (!failed || !failed.retryText || nodeChatState.sending) return;
      // Убираем сообщение-ошибку и отправляем текст заново
      nodeChatState.messages.splice(i, 1);
      nodeChatHistories[nodeChatState.nodeId] = nodeChatState.messages;
      sendNodeChatMessage(nodeChatState.nodeId, failed.retryText);
    });
  });
  box.scrollTop = box.scrollHeight;
}
