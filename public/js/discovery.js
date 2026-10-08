/* ===== FOA Gateway Admin Panel :: discovery.js ===== */
/* ====================================================================== */
/*  Discovery / Candidates                                                 */
/* ====================================================================== */
async function renderDiscovery(container) {
  $('#topbar-actions').innerHTML = '';
  const actionsWrap = h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}},
    h('button', {class: 'btn btn-primary', onClick: runDiscovery}, '▶ Запустить Discovery'),
    h('button', {class: 'btn btn-success', onClick: autoVerifyAllCandidates, title: 'Автоматически верифицировать всех кандидатов в узлы'}, '⚡ Авто-верифицировать всех'),
    h('button', {class: 'btn', onClick: () => renderDiscovery(container)}, '🔄 Обновить'),
    h('button', {class: 'btn btn-danger', onClick: clearCandidates}, '🗑 Очистить кандидатов'),
    h('button', {class: 'btn btn-danger', onClick: clearAllData}, '🧹 Очистить всё')
  );
  $('#topbar-actions').appendChild(actionsWrap);

  try {
    const [candData, sourcesData] = await Promise.all([
      API.get('/admin/candidates', {limit: 200}),
      API.get('/admin/discovery/sources').catch(() => ({ sources: [] })),
    ]);

    const list = candData.candidates || [];
    const sources = sourcesData.sources || [];
    container.innerHTML = '';

    // Search Engine Connectors status bar
    const sourcesCard = h('div', {class: 'card', style: {marginBottom: '16px'}},
      h('div', {class: 'card-header'},
        h('span', {class: 'card-title'}, 'Поисковые сервисы и API (§4.4 ТЗ)'),
        h('span', {style: {fontSize: '12px', color: 'var(--text3)'}}, 'Ключи считываются из .env')
      ),
      h('div', {class: 'grid grid-3', style: {gap: '10px'}},
        ...sources.map(s => {
          const isAct = s.configured;
          return h('div', {style: {padding: '10px', background: 'var(--bg3)', borderRadius: '6px', border: `1px solid ${isAct ? 'var(--green)' : 'var(--border)'}`}},
            h('div', {style: {display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px'}},
              h('strong', {style: {fontSize: '13px'}}, s.name),
              h('span', {class: `badge ${isAct ? 'badge-green' : 'badge-gray'}`}, isAct ? 'Активен (.env)' : 'Не настроен')
            ),
            h('div', {class: 'mono', style: {fontSize: '11px', color: 'var(--text3)'}}, `Запрос: ${s.query}`)
          );
        })
      )
    );
    container.appendChild(sourcesCard);

    const info = h('div', {class: 'card', style: {marginBottom: '16px', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px'}},
      h('div', null,
        h('div', {style: {display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px'}},
          h('span', null, `Всего кандидатов в пуле: `),
          h('strong', {style: {fontSize: '17px', color: 'var(--cyan)'}}, String(candData.total || 0)),
          h('span', {class: 'badge badge-green', style: {marginLeft: '6px'}}, '✓ Согласовано с владельцами')
        ),
        h('div', {style: {fontSize: '12px', color: 'var(--text2)'}},
          'Маршрутизация и верификация: поддерживаются автоматический (1-click/на лету) и ручной режимы (§4.4.4 отменён).'
        )
      ),
      h('div', {style: {display: 'flex', gap: '8px', alignItems: 'center'}},
        h('button', {
          class: 'btn btn-sm btn-success',
          onClick: autoVerifyAllCandidates,
          title: 'Автоматически верифицировать всех кандидатов и включить в маршрутизацию'
        }, '⚡ Авто-верифицировать всех'),
        h('button', {
          class: 'btn btn-sm',
          onClick: toggleAutoVerifyDiscovery,
          title: 'Переключить режим авто-маршрутизации при поиске'
        }, '⚡ Авто-маршрутизация при Discovery: ВКЛ')
      )
    );
    container.appendChild(info);

    if (!list.length) {
      container.appendChild(h('div', {class: 'empty-state'},
        h('span', {class: 'icon'}, '🔍'),
        h('p', null, 'Кандидатов пока нет. Нажмите «Запустить Discovery», чтобы опросить поисковые системы, указанные в .env.')
      ));
      return;
    }

    const tbl = h('div', {class: 'table-wrap'});
    let rows = '';
    list.forEach(c => {
      const riskColor = c.risk_score >= 70 ? 'red' : c.risk_score >= 40 ? 'yellow' : 'green';
      const sourcesList = c.sources && c.sources.length ? c.sources : [c.source];
      const sourceBadges = sourcesList.map(s => `<span class="badge badge-blue" style="margin-right:2px;">${esc(s)}</span>`).join('');
      const reviewBadge = c.requires_manual_review ? `<span class="badge badge-red" title="Высокий риск: требуется ручная проверка">Manual Review</span>` : '';
      const isEnrolled = c.status === 'enrolled' || c.verified;

      rows += `<tr>
        <td class="mono">${esc(shortId(c.candidate_id))}</td>
        <td>${sourceBadges}</td>
        <td class="mono"><strong>${esc(c.ip)}</strong>:${c.port}</td>
        <td class="mono" style="font-size:11px;">${esc(c.asn || '—')}</td>
        <td class="truncate" style="max-width:180px;">${(c.dns_names || []).map(d => esc(d)).join(', ') || '—'}</td>
        <td>${esc(c.country || '—')}</td>
        <td><span class="badge badge-${riskColor}">${c.risk_score}</span> ${reviewBadge}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${fmtDate(c.observed_at)}</td>
        <td>
          <div class="btn-group">
            ${isEnrolled 
              ? `<button class="btn btn-sm btn-primary cand-verify-manual" data-id="${esc(c.candidate_id)}" title="Настроить верификацию">⚙ Настроить</button>`
              : `<button class="btn btn-sm btn-success cand-verify-auto" data-id="${esc(c.candidate_id)}" title="Быстрая авто-верификация (согласовано)">⚡ Авто</button>
                 <button class="btn btn-sm btn-primary cand-verify-manual" data-id="${esc(c.candidate_id)}" title="Ручная верификация">⚙ Вручную</button>`
            }
            <button class="btn btn-sm btn-danger cand-del" data-id="${esc(c.candidate_id)}" title="Удалить">🗑</button>
          </div>
        </td>
      </tr>`;
    });
    tbl.innerHTML = `<table><thead><tr>
      <th>ID</th><th>Источники</th><th>IP:Port</th><th>ASN</th><th>DNS</th><th>Страна</th><th>Риск</th><th>Статус</th><th>Обнаружен</th><th>Действия</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    container.appendChild(tbl);

    tbl.addEventListener('click', async e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('cand-verify-auto')) {
        await autoVerifyCandidate(btn.dataset.id);
      } else if (btn.classList.contains('cand-verify-manual') || btn.classList.contains('cand-enroll')) {
        const candObj = list.find(x => x.candidate_id === btn.dataset.id);
        await showVerificationModal(candObj || btn.dataset.id, true);
      } else if (btn.classList.contains('cand-del')) {
        if (!confirmAction('Удалить кандидата?')) return;
        try {
          await API.del(`/admin/candidates/${btn.dataset.id}`);
          toast('Кандидат удалён', 'success');
          renderDiscovery(container);
        } catch (err) { toast(err.message, 'error'); }
      }
    });
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⚠️</span><p>${esc(e.message)}</p></div>`;
  }
}

async function runDiscovery() {
  toast('Запуск сканирования через API поисковых сервисов...', 'info');
  try {
    const data = await API.post('/admin/discovery/run');
    let summary = `Discovery: новых: ${data.created || 0}, дедуплицировано: ${data.deduped || 0}`;
    if (data.source_stats) {
      const parts = Object.entries(data.source_stats).map(([k, v]) => {
        if (v.error) return `${k}: (${v.error})`;
        return `${k}: +${v.count}`;
      });
      if (parts.length) summary += ` [${parts.join(' | ')}]`;
    }
    toast(summary, data.created > 0 ? 'success' : 'info');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

async function clearCandidates() {
  if (!confirmAction('Очистить всех кандидатов?')) return;
  try {
    const data = await API.del('/admin/candidates');
    toast(`Удалено кандидатов: ${data.count || 0}`, 'success');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

async function clearAllData() {
  if (!confirmAction('Очистить все узлы, кандидатов, согласия и чёрный список?')) return;
  try {
    const res = await API.post('/admin/demo/clear');
    toast(res.message || 'Все данные успешно очищены', 'success');
    if (currentPage === 'discovery') renderDiscovery($('#content'));
  } catch (e) { toast(e.message, 'error'); }
}

