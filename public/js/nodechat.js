/* ===== FOA Gateway Admin Panel :: nodechat.js ===== */
/*  Чат с конкретным узлом: модалка с историей сообщений, отправка через
 *  POST /api/chat c явным указанием target_node_id (маршрутизация на узел). */

const nodeChatState = {
  nodeId: null,
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
  }

  const el = h('div', {class: 'node-chat'},
    h('div', {class: 'node-chat-meta'},
      node
        ? `Endpoint: ${node.endpoint || '—'} · Статус: ${node.status || '—'} · Модели: ${(node.models || []).join(', ') || '—'}`
        : `Узел: ${esc(nodeId)}`
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

async function sendNodeChatMessage(nodeId, text) {
  nodeChatState.messages.push({ role: 'user', content: text, time: new Date() });
  nodeChatHistories[nodeId] = nodeChatState.messages;
  nodeChatState.sending = true;
  renderNodeChatMessages();
  setNodeChatBusy(true);

  try {
    const node = (currentNodesList || []).find(n => n.node_id === nodeId);
    const model = (node && node.models && node.models[0]) || undefined;
    const body = {
      messages: nodeChatState.messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
    };
    if (model) body.model = model;
    // Явная маршрутизация запроса на выбранный узел
    body.target_node_id = nodeId;

    const res = await API.post('/api/chat', body);
    const reply =
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
    nodeChatState.messages.push({
      role: 'assistant', error: true,
      content: `⚠️ Ошибка: ${err.message}`, time: new Date(),
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
  box.innerHTML = nodeChatState.messages.map(m => {
    const cls = m.role === 'user' ? 'msg-user' : (m.error ? 'msg-error' : 'msg-assistant');
    const author = m.role === 'user' ? 'Вы' : 'Узел';
    const t = m.time ? m.time.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'}) : '';
    return `<div class="node-chat-msg ${cls}">
      <div class="node-chat-msg-head">${author}<span class="node-chat-msg-time">${t}</span></div>
      <div class="node-chat-msg-body">${esc(m.content)}</div>
    </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
