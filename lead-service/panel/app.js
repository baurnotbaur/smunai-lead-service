/* Панель отдела продаж: заявки, доска, аналитика, подключение сайтов. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const state = { user: null, live: true, users: [], sites: [], stages: [], filters: {}, appType: localStorage.getItem('appType') || 'sales' };

  /* ---------- стадии воронки ---------- */
  // Настраиваются в разделе «Воронка», поэтому берутся с сервера, а не из константы.

  const stageList = () => state.stages;
  const stageOf = (code) => state.stages.find((s) => s.code === code);
  const stageTitle = (code) => stageOf(code)?.title || code;
  const isWonStage = (code) => stageOf(code)?.kind === 'won';
  const isLostStage = (code) => stageOf(code)?.kind === 'lost';
  const isOpenStage = (code) => stageOf(code)?.kind === 'open';

  /* ---------- каналы ---------- */
  // Заявка приходит либо с формы на сайте, либо перепиской из мессенджера.

  const CHANNELS = { whatsapp: 'WhatsApp', instagram: 'Instagram' };
  const channelName = (lead) => CHANNELS[lead?.channel] || '';
  const isChat = (lead) => Boolean(channelName(lead) && lead.external_id);

  /* ---------- утилиты ---------- */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const parseDate = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z') : null);

  function fmtDate(s) {
    const d = parseDate(s);
    if (!d) return '—';
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function ago(s) {
    const d = parseDate(s);
    if (!d) return '';
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.floor(h / 24)} дн назад`;
  }

  const isOverdue = (lead) =>
    lead.status === 'new' && (Date.now() - parseDate(lead.created_at)) / 60000 > (lead.sla_minutes || 15);

  const statusPill = (s) => `<span class="pill pill--${stageOf(s)?.color || 'new'}">${esc(stageTitle(s))}</span>`;

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  async function api(path, options = {}) {
    let finalPath = path;
    if (finalPath.startsWith('/leads') || finalPath.startsWith('/stages')) {
      const sep = finalPath.includes('?') ? '&' : '?';
      finalPath += `${sep}type=${state.appType}`;
    }

    const res = await fetch('/api' + finalPath, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401 && !finalPath.startsWith('/auth')) {
      showLogin();
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({ ok: false, message: 'Ошибка сервера' }));
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.message || 'Ошибка'), { data });
    return data;
  }

  /* ---------- вход ---------- */

  function showLogin() {
    $('#app').hidden = true;
    $('#loginScreen').hidden = false;
    
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    
    if (token) {
      $('#loginForm').hidden = true;
      $('#resetForm').hidden = false;
    } else {
      $('#loginForm').hidden = false;
      $('#resetForm').hidden = true;
      $('#forgotForm').hidden = true;
    }

    // без сессии поток событий всё равно отдаёт 401 — не переподключаемся вхолостую
    connectEvents._es?.close();
    connectEvents._es = null;
  }

  $('#forgotBtn').addEventListener('click', (e) => {
    e.preventDefault();
    $('#loginForm').hidden = true;
    $('#forgotForm').hidden = false;
  });

  $('#backToLoginBtn').addEventListener('click', (e) => {
    e.preventDefault();
    $('#forgotForm').hidden = true;
    $('#loginForm').hidden = false;
  });

  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#forgotError').textContent = '';
    try {
      const email = new FormData(e.target).get('email');
      const r = await api('/auth/reset-password', { method: 'POST', body: { email } });
      $('#forgotError').style.color = 'var(--green)';
      $('#forgotError').textContent = r.message || 'Ссылка отправлена';
    } catch (err) {
      $('#forgotError').style.color = 'var(--red)';
      $('#forgotError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    $('#resetError').textContent = '';
    try {
      const newPassword = new FormData(e.target).get('newPassword');
      const token = new URLSearchParams(window.location.search).get('token');
      const r = await api('/auth/confirm-reset', { method: 'POST', body: { token, newPassword } });
      $('#resetError').style.color = 'var(--green)';
      $('#resetError').textContent = r.message || 'Успешно! Возврат на вход...';
      setTimeout(() => {
        window.history.replaceState({}, document.title, window.location.pathname);
        showLogin();
      }, 2000);
    } catch (err) {
      $('#resetError').style.color = 'var(--red)';
      $('#resetError').textContent = err.message;
      btn.disabled = false;
    }
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#loginError').textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      state.user = r.user;
      state.live = r.live !== false;
      e.target.reset();
      await boot();
    } catch (err) {
      $('#loginError').textContent = err.message;
    }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.hash = '';
    location.reload();
  });

  /* ---------- тема ---------- */
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  $('#themeToggleBtn').textContent = savedTheme === 'dark' ? '☀️' : '🌙';

  $('#themeToggleBtn').addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    $('#themeToggleBtn').textContent = newTheme === 'dark' ? '☀️' : '🌙';
  });

  /* ---------- маршрутизация ---------- */

  const routes = [
    [/^\/leads$/, renderLeads],
    [/^\/board$/, renderBoard],
    [/^\/lead\/(\d+)$/, renderLead],
    [/^\/tasks$/, renderTasks],
    [/^\/stages$/, renderStages],
    [/^\/marketing$/, renderMarketing],
    [/^\/companies$/, renderCompanies],
    [/^\/company\/(\d+)$/, renderCompany],
    [/^\/stats$/, renderStats],
    [/^\/sites$/, renderSites],
    [/^\/bot$/, renderBot],
    [/^\/team$/, renderTeam],
  ];

  // карточка относится к разделу списка: /lead/7 -> «Все заявки», /company/3 -> «Компании»
  const NAV_OF_CARD = { '/lead/': 'leads', '/company/': 'companies', '/tasks': 'tasks' };

  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/leads';
    const [path, query] = hash.split('?');

    // ссылки вида #/leads?company=3 сразу открывают отфильтрованный список
    if (query) {
      const params = new URLSearchParams(query);
      for (const key of ['q', 'status', 'assigned', 'site', 'company', 'from', 'to']) {
        if (params.has(key)) state.filters[key] = params.get(key);
      }
    }

    for (const link of document.querySelectorAll('[data-nav]')) {
      const card = Object.entries(NAV_OF_CARD).find(([prefix]) => path.startsWith(prefix));
      link.classList.toggle(
        'active',
        card ? card[1] === link.dataset.nav : path === '/' + link.dataset.nav,
      );
    }
    for (const [re, handler] of routes) {
      const m = path.match(re);
      if (m) {
        view.innerHTML = '<div class="empty">Загрузка…</div>';
        try {
          await handler(...m.slice(1));
        } catch (err) {
          if (err.message !== 'unauthorized') view.innerHTML = `<div class="empty">Ошибка: ${esc(err.message)}</div>`;
        }
        return;
      }
    }
    location.hash = '#/leads';
  }

  window.addEventListener('hashchange', route);

  /* ---------- заявки: список ---------- */

  function filtersBar() {
    const f = state.filters;
    const opts = (list, sel, empty) =>
      `<option value="">${empty}</option>` +
      list.map((o) => `<option value="${o.v}"${String(sel) === String(o.v) ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

    return `
      <div class="filters">
        <input type="search" id="fq" placeholder="Поиск: имя, телефон, email" value="${esc(f.q || '')}">
        <select id="fstatus">${opts(stageList().map((s) => ({ v: s.code, t: s.title })), f.status, 'Все стадии')}</select>
        <select id="fassigned">
          <option value="">Все ответственные</option>
          <option value="me"${f.assigned === 'me' ? ' selected' : ''}>Мои</option>
          <option value="none"${f.assigned === 'none' ? ' selected' : ''}>Без ответственного</option>
          ${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}"${String(f.assigned) === String(u.id) ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>
        <select id="fsite">${opts(state.sites.map((s) => ({ v: s.id, t: s.name })), f.site, 'Все сайты')}</select>
        <input type="date" id="ffrom" value="${esc(f.from || '')}" title="Заявки с даты">
        <input type="date" id="fto" value="${esc(f.to || '')}" title="Заявки по дату">
        <button class="btn btn--sm" id="fReset">Сбросить</button>
      </div>`;
  }

  function bindFilters(reload) {
    const map = { fq: 'q', fstatus: 'status', fassigned: 'assigned', fsite: 'site', ffrom: 'from', fto: 'to' };
    for (const [id, key] of Object.entries(map)) {
      const el = $('#' + id);
      if (!el) continue;
      const ev = el.type === 'search' ? 'input' : 'change';
      el.addEventListener(ev, () => {
        clearTimeout(bindFilters._t);
        bindFilters._t = setTimeout(() => {
          state.filters[key] = el.value;
          reload();
        }, ev === 'input' ? 300 : 0);
      });
    }
    $('#fReset')?.addEventListener('click', () => {
      state.filters = {};
      reload();
    });
  }

  const filterQuery = () => new URLSearchParams(Object.entries(state.filters).filter(([, v]) => v)).toString();

  async function renderLeads() {
    const q = filterQuery();
    const data = await api('/leads?' + q);

    view.innerHTML = `
      <div class="page-head">
        <h1>Заявки <span class="muted" style="font-weight:400">${data.total}</span></h1>
        <div class="row">
          <a class="btn btn--sm" href="/api/leads/export.csv?${q}">Выгрузить CSV</a>
          <button class="btn btn--primary btn--sm" id="addLead">+ Заявка вручную</button>
        </div>
      </div>
      ${filtersBar()}
      ${data.items.length && state.filters.company ? `
        <div class="row" style="margin-bottom:12px">
          <span class="pill pill--new">Компания: ${esc(data.items[0].company_name || '#' + state.filters.company)}</span>
          <button class="btn btn--sm" id="clearCompany">Показать все заявки</button>
        </div>` : ''}
      <div class="card" style="padding:0;overflow-x:auto">
        ${data.items.length ? `
        <table class="table">
          <thead><tr>
            <th>Когда</th><th>Контакт</th><th>Комментарий</th><th>Статус</th>
            <th>Ответственный</th><th>Источник</th>
          </tr></thead>
          <tbody>
            ${data.items.map(rowHtml).join('')}
          </tbody>
        </table>` : '<div class="empty">Заявок нет. Проверьте, подключён ли сайт — раздел «Подключение сайта».</div>'}
      </div>
      ${data.total > data.items.length ? `<div style="margin-top:12px"><button class="btn" id="more">Показать ещё</button></div>` : ''}
    `;

    bindFilters(renderLeads);
    view.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => (location.hash = '#/lead/' + tr.dataset.id));
    });
    $('#addLead')?.addEventListener('click', manualLeadDialog);
    $('#clearCompany')?.addEventListener('click', () => {
      delete state.filters.company;
      location.hash = '#/leads';
      renderLeads();
    });
    $('#more')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const next = await api(`/leads?${q}&offset=${data.items.length}`);
      view.querySelector('tbody')?.insertAdjacentHTML('beforeend', next.items.map(rowHtml).join(''));
      view.querySelectorAll('tr[data-id]').forEach((tr) => {
        tr.onclick = () => (location.hash = '#/lead/' + tr.dataset.id);
      });
      e.target.disabled = false;
    });
  }

  function rowHtml(l) {
    return `
      <tr data-id="${l.id}">
        <td class="nowrap">
          ${fmtDate(l.created_at)}<br>
          <span class="muted" style="font-size:12px">${ago(l.created_at)}</span>
        </td>
        <td>
          <b>${esc(l.name || 'Без имени')}</b><br>
          <span class="mono">${esc(l.phone || l.email)}</span>
          ${l.is_duplicate ? ' <span class="pill pill--dupe">дубль</span>' : ''}
        </td>
        <td style="max-width:280px">${esc(l.comment).slice(0, 140) || '<span class="muted">—</span>'}</td>
        <td class="nowrap">${statusPill(l.status)} ${isOverdue(l) ? '<span class="pill pill--overdue">просрочка</span>' : ''}</td>
        <td class="nowrap">${esc(l.assigned_name || '—')}</td>
        <td class="nowrap muted" style="font-size:12px">
          ${esc(channelName(l) || l.utm_source || l.site_name || '—')}${l.utm_campaign ? '<br>' + esc(l.utm_campaign) : ''}
        </td>
      </tr>`;
  }

  /* ---------- заявки: доска ---------- */

  async function renderBoard() {
    const data = await api('/leads?limit=300&' + filterQuery());
    const cols = stageList().map((stage) => {
      const items = data.items.filter((l) => l.status === stage.code);
      return `
        <div class="board__col" data-status="${stage.code}">
          <div class="board__head"><span>${esc(stage.title)}</span><span class="muted">${items.length}</span></div>
          ${items.map((l) => `
            <div class="board__card" draggable="true" data-id="${l.id}">
              <b>${esc(l.name || 'Без имени')}</b>
              <span class="mono">${esc(l.phone || l.email)}</span>
              <div class="muted" style="font-size:12px;margin-top:6px">
                ${ago(l.created_at)}${l.assigned_name ? ' · ' + esc(l.assigned_name) : ''}
                ${isOverdue(l) ? ' · <span style="color:var(--red)">просрочка</span>' : ''}
              </div>
            </div>`).join('')}
        </div>`;
    }).join('');

    view.innerHTML = `
      <div class="page-head"><h1>Доска</h1><span class="muted">Перетащите карточку, чтобы сменить стадию</span></div>
      ${filtersBar()}
      <div class="board">${cols}</div>`;

    bindFilters(renderBoard);

    let dragged = null;
    view.querySelectorAll('.board__card').forEach((card) => {
      card.addEventListener('dragstart', () => {
        dragged = card;
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dblclick', () => (location.hash = '#/lead/' + card.dataset.id));
    });
    view.querySelectorAll('.board__col').forEach((col) => {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drop');
      });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        if (!dragged) return;
        const id = dragged.dataset.id;
        try {
          await api('/leads/' + id, { method: 'PATCH', body: { status: col.dataset.status } });
          toast('Статус обновлён');
          renderBoard();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  }

  /* ---------- дела ---------- */

  const TASK_KINDS = { call: 'Звонок', meeting: 'Встреча', email: 'Письмо', other: 'Дело' };

  /** Срок в формате БД -> значение для <input type="datetime-local">. */
  const toInputDate = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const inHours = (h) => toInputDate(new Date(Date.now() + h * 3600_000));

  function tomorrowAt(hour) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(hour, 0, 0, 0);
    return toInputDate(d);
  }

  const isTaskOverdue = (t) => !t.done && parseDate(t.due_at) < Date.now();

  function taskRow(task, { showLead = true } = {}) {
    const lead = task.lead_id
      ? `<a href="#/lead/${task.lead_id}">${esc(task.lead_name || task.lead_phone || '№' + task.lead_id)}</a>`
      : task.company_id
        ? `<a href="#/company/${task.company_id}">${esc(task.company_name)}</a>`
        : '<span class="muted">—</span>';

    return `
      <tr data-task="${task.id}"${task.done ? ' style="opacity:.55"' : ''}>
        <td style="width:32px"><input type="checkbox" data-done="${task.id}"${task.done ? ' checked' : ''} style="width:auto"></td>
        <td>
          <b${task.done ? ' style="text-decoration:line-through"' : ''}>${esc(task.title)}</b>
          <br><span class="muted" style="font-size:12px">${TASK_KINDS[task.kind] || task.kind}</span>
        </td>
        <td class="nowrap">
          ${fmtDate(task.due_at)}
          ${isTaskOverdue(task) ? '<br><span class="pill pill--overdue">просрочено</span>' : ''}
        </td>
        ${showLead ? `<td>${lead}</td>` : ''}
        <td class="nowrap">${esc(task.assigned_name || '—')}</td>
        <td class="nowrap"><button class="btn btn--sm btn--danger" data-del-task="${task.id}">Удалить</button></td>
      </tr>`;
  }

  /** Вешает обработчики «выполнено» и «удалить» на любой список дел. */
  function bindTaskRows(reload) {
    view.querySelectorAll('[data-done]').forEach((box) => {
      box.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api('/tasks/' + box.dataset.done, { method: 'PATCH', body: { done: box.checked } });
          toast(box.checked ? 'Дело выполнено' : 'Дело возвращено в работу');
          reload();
        } catch (err) {
          toast(err.message, true);
          box.checked = !box.checked;
        }
      });
    });
    view.querySelectorAll('[data-del-task]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Удалить дело?')) return;
        await api('/tasks/' + btn.dataset.delTask, { method: 'DELETE' });
        reload();
      });
    });
  }

  async function renderTasks() {
    const scope = state.taskScope || 'me';
    const filter = state.taskFilter || 'week';
    const { items } = await api(`/tasks?scope=${scope}&filter=${filter}`);

    const overdue = items.filter(isTaskOverdue);
    const today = items.filter((t) => !isTaskOverdue(t) && new Date(parseDate(t.due_at)).toDateString() === new Date().toDateString());
    const later = items.filter((t) => !overdue.includes(t) && !today.includes(t));

    const group = (title, list, cls = '') => list.length ? `
      <h2 style="margin:22px 0 10px" class="${cls}">${title} <span class="muted" style="font-weight:400">${list.length}</span></h2>
      <div class="card" style="padding:0;overflow-x:auto">
        <table class="table">
          <thead><tr><th></th><th>Что сделать</th><th>Срок</th><th>По заявке</th><th>Ответственный</th><th></th></tr></thead>
          <tbody>${list.map((t) => taskRow(t)).join('')}</tbody>
        </table>
      </div>` : '';

    view.innerHTML = `
      <div class="page-head">
        <h1>Дела</h1>
      </div>
      <div class="filters">
        <select id="tScope">
          <option value="me"${scope === 'me' ? ' selected' : ''}>Мои дела</option>
          <option value="all"${scope === 'all' ? ' selected' : ''}>Все дела</option>
        </select>
        <select id="tFilter">
          <option value="today"${filter === 'today' ? ' selected' : ''}>На сегодня</option>
          <option value="week"${filter === 'week' ? ' selected' : ''}>На неделю</option>
          <option value="overdue"${filter === 'overdue' ? ' selected' : ''}>Только просроченные</option>
          <option value=""${filter === '' ? ' selected' : ''}>Все открытые</option>
        </select>
      </div>
      ${items.length ? '' : '<div class="empty">Дел нет. Добавляйте их из карточки заявки — «Перезвонить», «Отправить КП».</div>'}
      ${group('Просрочено', overdue)}
      ${group('Сегодня', today)}
      ${group('Дальше', later)}`;

    $('#tScope').addEventListener('change', (e) => {
      state.taskScope = e.target.value;
      renderTasks();
    });
    $('#tFilter').addEventListener('change', (e) => {
      state.taskFilter = e.target.value;
      renderTasks();
    });
    bindTaskRows(renderTasks);
  }

  /* ---------- компании: список ---------- */

  async function renderCompanies() {
    const q = state.companyQuery || '';
    const { items, total } = await api('/companies?q=' + encodeURIComponent(q));

    view.innerHTML = `
      <div class="page-head">
        <h1>Компании <span class="muted" style="font-weight:400">${total}</span></h1>
        <button class="btn btn--primary btn--sm" id="addCompany">+ Компания</button>
      </div>
      <div class="filters">
        <input type="search" id="cq" placeholder="Поиск: название, БИН, телефон" value="${esc(q)}">
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        ${items.length ? `
        <table class="table">
          <thead><tr>
            <th>Компания</th><th>БИН</th><th>Контакты</th><th>Заявки</th>
            <th>Последняя заявка</th><th>Ответственный</th>
          </tr></thead>
          <tbody>
            ${items.map((c) => `
              <tr data-id="${c.id}">
                <td><b>${esc(c.name)}</b>${c.phone ? `<br><span class="mono muted">${esc(c.phone)}</span>` : ''}</td>
                <td class="mono nowrap">${esc(c.bin) || '—'}</td>
                <td class="nowrap">${c.contacts_count}</td>
                <td class="nowrap">${c.leads_count}</td>
                <td class="nowrap">${c.last_lead_at ? fmtDate(c.last_lead_at) : '<span class="muted">—</span>'}</td>
                <td class="nowrap">${esc(c.assigned_name || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">Компаний пока нет. Они заводятся сами, когда в заявке указана организация.</div>'}
      </div>`;

    const search = $('#cq');
    search.addEventListener('input', () => {
      clearTimeout(search._t);
      search._t = setTimeout(() => {
        state.companyQuery = search.value.trim();
        renderCompanies().then(() => $('#cq')?.focus());
      }, 350);
    });
    view.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => (location.hash = '#/company/' + tr.dataset.id));
    });
    $('#addCompany').addEventListener('click', async () => {
      const name = prompt('Название компании (ТОО «…» / ИП …):');
      if (!name) return;
      try {
        const r = await api('/companies', { method: 'POST', body: { name } });
        location.hash = '#/company/' + r.company.id;
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  /* ---------- компании: карточка ---------- */

  async function renderCompany(id) {
    const { company, contacts, leads } = await api('/companies/' + id);

    view.innerHTML = `
      <div class="page-head">
        <div>
          <a href="#/companies" class="muted">← К компаниям</a>
          <h1 style="margin-top:6px">${esc(company.name)}</h1>
        </div>
        <div class="row">
          ${company.phone ? `<a class="btn btn--primary btn--sm" href="tel:${esc(company.phone)}">Позвонить</a>` : ''}
          <a class="btn btn--sm" href="#/leads?company=${company.id}">Заявки компании</a>
        </div>
      </div>

      <div class="lead-grid">
        <div class="grid">
          <div class="card">
            <h2 style="margin-bottom:12px">Контактные лица</h2>
            ${contacts.length ? `
            <table class="table">
              <thead><tr><th>Имя</th><th>Должность</th><th>Телефон</th><th>Email</th><th>Реклама</th><th></th></tr></thead>
              <tbody>
                ${contacts.map((c) => `
                  <tr>
                    <td>${esc(c.name) || '<span class="muted">без имени</span>'}</td>
                    <td>${esc(c.position) || '<span class="muted">—</span>'}</td>
                    <td class="mono nowrap">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</td>
                    <td class="mono">${esc(c.email) || '—'}</td>
                    <td class="nowrap">
                      ${c.unsubscribed
                        ? '<span class="pill pill--lost">отписан</span>'
                        : c.marketing_consent
                          ? `<span class="pill pill--won">согласие</span>`
                          : '<span class="muted" style="font-size:12px">нет</span>'}
                      <button class="btn btn--sm" data-consent="${c.id}" style="margin-left:6px">
                        ${c.marketing_consent ? 'Снять' : 'Отметить'}
                      </button>
                    </td>
                    <td class="nowrap"><button class="btn btn--sm" data-edit-contact="${c.id}">Изменить</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<div class="muted">Контактных лиц пока нет.</div>'}
            <button class="btn btn--sm" style="margin-top:12px" id="addContact">+ Контактное лицо</button>
          </div>

          <div class="card">
            <h2 style="margin-bottom:12px">Заявки компании <span class="muted" style="font-weight:400">${leads.length}</span></h2>
            ${leads.length ? `
            <table class="table">
              <thead><tr><th>Когда</th><th>Кто</th><th>Статус</th><th>Ответственный</th></tr></thead>
              <tbody>
                ${leads.map((l) => `
                  <tr data-lead="${l.id}">
                    <td class="nowrap">${fmtDate(l.created_at)}</td>
                    <td>${esc(l.name || l.phone)}</td>
                    <td class="nowrap">${statusPill(l.status)}</td>
                    <td class="nowrap">${esc(l.assigned_name || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<div class="muted">Заявок пока нет.</div>'}
          </div>
        </div>

        <div class="card">
          <h2 style="margin-bottom:12px">Реквизиты</h2>
          <label class="field"><span>Название</span><input id="cName" value="${esc(company.name)}"></label>
          <label class="field"><span>БИН / ИИН</span><input id="cBin" value="${esc(company.bin)}" placeholder="12 цифр"></label>
          <label class="field"><span>Телефон</span><input id="cPhone" value="${esc(company.phone)}"></label>
          <label class="field"><span>Email</span><input id="cEmail" value="${esc(company.email)}"></label>
          <label class="field"><span>Адрес</span><input id="cAddress" value="${esc(company.address)}"></label>
          <label class="field">
            <span>Ответственный</span>
            <select id="cAssigned">
              <option value="">— не назначен —</option>
              ${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}"${company.assigned_to === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>Заметки</span><textarea id="cNote">${esc(company.note)}</textarea></label>
          <button class="btn btn--primary" id="saveCompany" style="width:100%">Сохранить</button>
          ${state.user.role === 'admin' ? '<button class="btn btn--danger btn--sm" id="delCompany" style="width:100%;margin-top:8px">Удалить компанию</button>' : ''}
        </div>
      </div>`;

    view.querySelectorAll('tr[data-lead]').forEach((tr) => {
      tr.addEventListener('click', () => (location.hash = '#/lead/' + tr.dataset.lead));
    });

    $('#saveCompany').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/companies/' + id, {
          method: 'PATCH',
          body: {
            name: $('#cName').value,
            bin: $('#cBin').value,
            phone: $('#cPhone').value,
            email: $('#cEmail').value,
            address: $('#cAddress').value,
            note: $('#cNote').value,
            assigned_to: $('#cAssigned').value || null,
          },
        });
        toast('Сохранено');
        renderCompany(id);
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    });

    $('#addContact').addEventListener('click', async () => {
      const name = prompt('Имя контактного лица:');
      if (name === null) return;
      const phone = prompt('Телефон:') || '';
      const position = prompt('Должность (необязательно):') || '';
      try {
        await api('/contacts', { method: 'POST', body: { name, phone, position, company_id: id } });
        toast('Контакт добавлен');
        renderCompany(id);
      } catch (err) {
        toast(err.message, true);
      }
    });

    view.querySelectorAll('[data-consent]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const contact = contacts.find((c) => String(c.id) === btn.dataset.consent);
        const next = !contact.marketing_consent;
        if (next && !confirm(`Клиент ${contact.name || contact.phone} действительно дал согласие на рекламные рассылки?`)) return;
        await api('/contacts/' + contact.id, {
          method: 'PATCH',
          body: { marketing_consent: next, consent_source: 'вручную, менеджер' },
        });
        toast(next ? 'Согласие отмечено' : 'Согласие снято');
        renderCompany(id);
      });
    });

    view.querySelectorAll('[data-edit-contact]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const contact = contacts.find((c) => String(c.id) === btn.dataset.editContact);
        const name = prompt('Имя:', contact.name);
        if (name === null) return;
        const phone = prompt('Телефон:', contact.phone);
        if (phone === null) return;
        const position = prompt('Должность:', contact.position);
        if (position === null) return;
        try {
          await api('/contacts/' + contact.id, { method: 'PATCH', body: { name, phone, position } });
          toast('Сохранено');
          renderCompany(id);
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    $('#delCompany')?.addEventListener('click', async () => {
      if (!confirm('Удалить компанию? Заявки и контакты останутся, но потеряют привязку.')) return;
      await api('/companies/' + id, { method: 'DELETE' });
      location.hash = '#/companies';
    });
  }

  /* ---------- заявки: карточка ---------- */

  async function renderLead(id) {
    const [{ lead, events, messages = [] }, tasksRes] = await Promise.all([api('/leads/' + id), api('/tasks?lead=' + id)]);
    const extra = JSON.parse(lead.extra || '{}');
    const tasks = tasksRes.items;

    view.innerHTML = `
      <div class="page-head">
        <div>
          <a href="#/leads" class="muted">← К списку</a>
          <h1 style="margin-top:6px">${esc(lead.name || 'Без имени')} <span class="muted" style="font-weight:400">#${lead.id}</span></h1>
        </div>
        <div class="row">
          ${lead.phone ? `<a class="btn btn--primary btn--sm" href="tel:${esc(lead.phone)}">Позвонить</a>` : ''}
          ${lead.email ? `<a class="btn btn--sm" href="mailto:${esc(lead.email)}">Написать</a>` : ''}
        </div>
      </div>

      <div class="lead-grid">
        <div class="grid">
          <div class="card">
            <h2 style="margin-bottom:12px">Контакт и источник</h2>
            <dl class="kv">
              <dt>Компания</dt><dd>${lead.company_id
                ? `<a href="#/company/${lead.company_id}">${esc(lead.company_name)}</a>`
                : '<span class="muted">не определена</span>'}</dd>
              <dt>Контакт</dt><dd>${esc(lead.contact_name) || '<span class="muted">—</span>'}</dd>
              <dt>Телефон</dt><dd class="mono">${esc(lead.phone) || '—'}</dd>
              <dt>Email</dt><dd class="mono">${esc(lead.email) || '—'}</dd>
              <dt>Комментарий</dt><dd>${esc(lead.comment) || '—'}</dd>
              <dt>Создана</dt><dd>${fmtDate(lead.created_at)} <span class="muted">(${ago(lead.created_at)})</span></dd>
              <dt>Первый контакт</dt><dd>${lead.first_touch_at ? fmtDate(lead.first_touch_at) : '<span style="color:var(--red)">ещё не было</span>'}</dd>
              <dt>Канал</dt><dd>${channelName(lead) || 'Форма на сайте'}</dd>
              <dt>Сайт</dt><dd>${esc(lead.site_name || '—')}</dd>
              <dt>Страница</dt><dd>${lead.page_url ? `<a href="${esc(lead.page_url)}" target="_blank" rel="noopener">${esc(lead.page_url)}</a>` : '—'}</dd>
              <dt>UTM</dt><dd class="mono">${esc([lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term].filter(Boolean).join(' / ')) || '—'}</dd>
              <dt>Referrer</dt><dd class="mono">${esc(lead.referrer) || '—'}</dd>
              <dt>IP</dt><dd class="mono">${esc(lead.ip) || '—'}</dd>
              ${Object.entries(extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
            </dl>
          </div>

          <div class="card">
            <h2 style="margin-bottom:12px">Дела</h2>
            <form id="taskForm" class="row row--wrap" style="gap:8px;margin-bottom:14px">
              <input name="title" placeholder="Что сделать: перезвонить, отправить КП…" required style="flex:1 1 240px">
              <select name="kind" style="width:auto">
                ${Object.entries(TASK_KINDS).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
              </select>
              <input type="datetime-local" name="due_at" value="${inHours(1)}" required style="width:auto">
              <button class="btn btn--primary btn--sm" type="submit">Добавить</button>
            </form>
            <div class="row row--wrap" style="gap:6px;margin-bottom:14px">
              <span class="muted" style="font-size:12px">Быстрый срок:</span>
              <button class="btn btn--sm" data-due="${inHours(1)}">через час</button>
              <button class="btn btn--sm" data-due="${tomorrowAt(10)}">завтра 10:00</button>
              <button class="btn btn--sm" data-due="${inHours(72)}">через 3 дня</button>
            </div>
            ${tasks.length ? `
            <div style="overflow-x:auto">
              <table class="table">
                <thead><tr><th></th><th>Что сделать</th><th>Срок</th><th>Ответственный</th><th></th></tr></thead>
                <tbody>${tasks.map((t) => taskRow(t, { showLead: false })).join('')}</tbody>
              </table>
            </div>` : '<div class="muted">Дел по заявке нет.</div>'}
          </div>

          ${isChat(lead) ? `
          <div class="card">
            <h2 style="margin-bottom:12px">Переписка · ${channelName(lead)}</h2>
            <div class="chat">
              ${messages.length
                ? messages.map((m) => `
                  <div class="chat__msg chat__msg--${m.direction === 'in' ? 'in' : 'out'}">
                    <div>${m.kind === 'text' ? esc(m.text) : `<span class="muted">[${esc(m.kind)}]</span> ${esc(m.text)}`}</div>
                    <div class="when">${fmtDate(m.created_at)}</div>
                  </div>`).join('')
                : '<div class="muted">Сообщений нет.</div>'}
            </div>
            <form id="replyForm" style="margin-top:12px">
              <textarea name="text" placeholder="Ответить клиенту в ${channelName(lead)}…" required></textarea>
              <button class="btn btn--primary btn--sm" style="margin-top:8px" type="submit">Отправить</button>
            </form>
          </div>` : ''}

          <div class="card">
            <h2 style="margin-bottom:12px">История</h2>
            <form id="commentForm" style="margin-bottom:14px">
              <textarea name="text" placeholder="Комментарий: о чём договорились, что дальше…" required></textarea>
              <button class="btn btn--sm" style="margin-top:8px" type="submit">Добавить</button>
            </form>
            <ul class="timeline">
              ${events.map((e) => `
                <li class="${e.type === 'comment' ? 'comment' : ''}">
                  <div>${esc(e.text)}</div>
                  <div class="when">${fmtDate(e.created_at)}${e.user_name ? ' · ' + esc(e.user_name) : ''}</div>
                </li>`).reverse().join('')}
            </ul>
          </div>
        </div>

        <div class="card">
          <h2 style="margin-bottom:12px">Работа с заявкой</h2>
          <label class="field">
            <span>Стадия</span>
            <select id="setStatus">
              ${stageList().map((s) => `<option value="${s.code}"${lead.status === s.code ? ' selected' : ''}>${esc(s.title)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span>Ответственный</span>
            <select id="setAssigned">
              <option value="">— не назначен —</option>
              ${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}"${lead.assigned_to === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span>Сумма сделки</span>
            <input type="number" id="setAmount" step="0.01" value="${lead.amount ?? ''}" placeholder="0">
          </label>
          <label class="field" id="lostWrap"${isLostStage(lead.status) ? '' : ' hidden'}>
            <span>Причина отказа</span>
            <input type="text" id="setLost" value="${esc(lead.lost_reason)}" placeholder="Дорого, выбрали конкурента…">
          </label>
          <button class="btn btn--primary" id="saveLead" style="width:100%">Сохранить</button>
          ${state.user.role === 'admin' ? '<button class="btn btn--danger btn--sm" id="delLead" style="width:100%;margin-top:8px">Удалить заявку</button>' : ''}
        </div>
      </div>`;

    $('#setStatus').addEventListener('change', (e) => {
      $('#lostWrap').hidden = !isLostStage(e.target.value);
    });

    $('#saveLead').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('/leads/' + id, {
          method: 'PATCH',
          body: {
            status: $('#setStatus').value,
            assigned_to: $('#setAssigned').value || null,
            amount: $('#setAmount').value,
            lost_reason: $('#setLost') ? $('#setLost').value : '',
          },
        });
        toast('Сохранено');
        renderLead(id);
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    });

    $('#commentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = new FormData(e.target).get('text');
      try {
        await api(`/leads/${id}/comments`, { method: 'POST', body: { text } });
        renderLead(id);
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#replyForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = e.target.querySelector('[type="submit"]');
      const text = new FormData(e.target).get('text');
      button.disabled = true;
      try {
        await api(`/leads/${id}/reply`, { method: 'POST', body: { text } });
        renderLead(id);
      } catch (err) {
        // отправка могла не пройти из-за окна в 24 часа или отозванного токена —
        // текст ошибки от Meta лучше показать как есть, он объясняет причину
        toast(err.message, true);
        button.disabled = false;
      }
    });

    const taskForm = $('#taskForm');
    taskForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(taskForm);
      try {
        await api('/tasks', {
          method: 'POST',
          body: {
            lead_id: id,
            title: fd.get('title'),
            kind: fd.get('kind'),
            due_at: fd.get('due_at'),
          },
        });
        toast('Дело добавлено');
        renderLead(id);
      } catch (err) {
        toast(err.message, true);
      }
    });
    view.querySelectorAll('[data-due]').forEach((btn) => {
      btn.addEventListener('click', () => {
        taskForm.elements.due_at.value = btn.dataset.due;
        taskForm.elements.title.focus();
      });
    });
    bindTaskRows(() => renderLead(id));

    $('#delLead')?.addEventListener('click', async () => {
      if (!confirm('Удалить заявку безвозвратно?')) return;
      await api('/leads/' + id, { method: 'DELETE' });
      location.hash = '#/leads';
    });
  }

  /* ---------- ручное добавление ---------- */

  async function manualLeadDialog() {
    const name = prompt('Имя клиента:');
    if (name === null) return;
    const phone = prompt('Телефон:');
    if (phone === null) return;
    const comment = prompt('Комментарий (необязательно):') || '';
    try {
      await api('/leads', { method: 'POST', body: { name, phone, comment } });
      toast('Заявка добавлена');
      renderLeads();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------- аналитика ---------- */

  async function renderStats() {
    const { stats } = await api('/stats');
    const maxSource = Math.max(1, ...stats.bySource.map((s) => s.total));

    const tile = (value, label) => `<div class="stat"><div class="stat__value">${value}</div><div class="stat__label">${label}</div></div>`;

    view.innerHTML = `
      <div class="page-head"><h1>Аналитика <span class="muted" style="font-weight:400">за 30 дней</span></h1></div>

      <div class="stats">
        ${tile(stats.today, 'Заявок за сутки')}
        ${tile(stats.week, 'За 7 дней')}
        ${tile(stats.month, 'За 30 дней')}
        ${tile(stats.counts.new, 'Новых, не разобрано')}
        ${tile(stats.overdue ? `<span style="color:var(--red)">${stats.overdue}</span>` : 0, 'Просрочен первый контакт')}
        ${tile(stats.avgResponseMinutes != null ? stats.avgResponseMinutes + ' мин' : '—', 'Среднее время реакции')}
        ${tile(stats.conversion != null ? stats.conversion + '%' : '—', 'Конверсия в успех')}
        ${tile(stats.revenue ? Number(stats.revenue).toLocaleString('ru-RU') : 0, 'Сумма выигранных')}
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="card">
          <h2 style="margin-bottom:12px">Источники</h2>
          ${stats.bySource.length ? stats.bySource.map((s) => `
            <div style="margin-bottom:10px">
              <div class="spread" style="font-size:13px"><span>${esc(s.source)}</span><span class="muted">${s.total} · успех ${s.won || 0}</span></div>
              <div class="bar" style="width:${Math.round((s.total / maxSource) * 100)}%"></div>
            </div>`).join('') : '<p class="muted">Пока нет данных</p>'}
        </div>

        <div class="card">
          <h2 style="margin-bottom:12px">Менеджеры</h2>
          <table class="table">
            <thead><tr><th>Сотрудник</th><th>Заявок</th><th>В работе</th><th>Успех</th></tr></thead>
            <tbody>
              ${stats.byManager.map((m) => `
                <tr style="cursor:default"><td>${esc(m.name)}</td><td>${m.total}</td><td>${m.open || 0}</td><td>${m.won || 0}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <h2 style="margin-bottom:12px">Воронка</h2>
        <div class="row row--wrap">
          ${stageList().map((s) => `
            <div style="min-width:120px">
              <div style="font-size:22px;font-weight:600">${stats.counts[s.code] || 0}</div>
              <div>${statusPill(s.code)}</div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  /* ---------- маркетинг: сегменты и аудитории ---------- */

  /** Условия сегмента человеческим языком — чтобы в списке было видно, кого он ловит. */
  function describeFilters(f) {
    const parts = [];
    if (f.stages) parts.push('стадии: ' + f.stages.split(',').map(stageTitle).join(', '));
    if (f.days_ago) parts.push(`заявка за последние ${f.days_ago} дн.`);
    if (f.older_than_days) parts.push(`заявка старше ${f.older_than_days} дн.`);
    if (f.assigned) parts.push('менеджер: ' + (state.users.find((u) => u.id === f.assigned)?.name || f.assigned));
    if (f.site) parts.push('сайт: ' + (state.sites.find((s) => s.id === f.site)?.name || f.site));
    if (f.has_company) parts.push('только с компанией');
    if (f.q) parts.push(`поиск «${f.q}»`);
    return parts.length ? parts.join(' · ') : 'вся база контактов';
  }

  function segmentFormHtml(f = {}) {
    return `
      <div class="grid" style="gap:10px">
        <label class="field" style="margin:0">
          <span>Стадии заявок (можно несколько)</span>
          <select id="sgStages" multiple size="5">
            ${stageList().map((s) => `<option value="${s.code}"${(f.stages || '').split(',').includes(s.code) ? ' selected' : ''}>${esc(s.title)}</option>`).join('')}
          </select>
        </label>
        <div class="row row--wrap" style="gap:10px">
          <label class="field" style="margin:0;flex:1 1 160px">
            <span>Заявка за последние, дней</span>
            <input type="number" id="sgDays" min="1" value="${f.days_ago || ''}" placeholder="напр. 90">
          </label>
          <label class="field" style="margin:0;flex:1 1 160px">
            <span>Заявка старше, дней</span>
            <input type="number" id="sgOlder" min="1" value="${f.older_than_days || ''}" placeholder="напр. 30">
          </label>
        </div>
        <label class="field" style="margin:0">
          <span>Менеджер</span>
          <select id="sgAssigned">
            <option value="">— любой —</option>
            ${state.users.filter((u) => u.active).map((u) => `<option value="${u.id}"${f.assigned === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}
          </select>
        </label>
        <label class="row" style="gap:8px;align-items:center">
          <input type="checkbox" id="sgHasCompany" style="width:auto"${f.has_company ? ' checked' : ''}>
          <span>Только те, у кого определена компания</span>
        </label>
      </div>`;
  }

  function readSegmentForm() {
    return {
      stages: Array.from($('#sgStages').selectedOptions).map((o) => o.value).join(','),
      days_ago: $('#sgDays').value,
      older_than_days: $('#sgOlder').value,
      assigned: $('#sgAssigned').value,
      has_company: $('#sgHasCompany').checked ? 1 : 0,
    };
  }

  async function renderMarketing() {
    const { items } = await api('/segments');

    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Маркетинг</h1>
          <p class="muted" style="margin:6px 0 0">Сегменты клиентской базы и выгрузка аудиторий для Instagram и TikTok.</p>
        </div>
        <button class="btn btn--primary btn--sm" id="addSegment">+ Сегмент</button>
      </div>

      <div id="segmentEditor" hidden class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:12px">Новый сегмент</h2>
        <label class="field"><span>Название</span><input id="sgName" placeholder="Например: отказы старше 30 дней"></label>
        ${segmentFormHtml()}
        <div class="row" style="margin-top:14px;gap:8px">
          <button class="btn btn--primary btn--sm" id="saveSegment">Сохранить</button>
          <button class="btn btn--sm" id="previewSegment">Посчитать</button>
          <button class="btn btn--sm btn--ghost" id="cancelSegment">Отмена</button>
          <span class="muted" id="sgPreview"></span>
        </div>
      </div>

      ${items.length ? items.map((s) => `
        <div class="card" style="margin-bottom:12px">
          <div class="spread">
            <div>
              <h3>${esc(s.name)}</h3>
              <div class="muted" style="font-size:13px;margin-top:4px">${esc(describeFilters(s.filters))}</div>
            </div>
            <button class="btn btn--sm btn--danger" data-del-seg="${s.id}">Удалить</button>
          </div>
          <div class="row row--wrap" style="gap:18px;margin-top:12px">
            <div><div style="font-size:20px;font-weight:600">${s.stats.total}</div><div class="muted" style="font-size:12px">контактов всего</div></div>
            <div><div style="font-size:20px;font-weight:600;color:var(--green)">${s.stats.consented}</div><div class="muted" style="font-size:12px">с согласием на рекламу</div></div>
            <div><div style="font-size:20px;font-weight:600">${s.stats.withPhone}</div><div class="muted" style="font-size:12px">с телефоном</div></div>
            <div><div style="font-size:20px;font-weight:600">${s.stats.withEmail}</div><div class="muted" style="font-size:12px">с почтой</div></div>
          </div>
          <div class="row row--wrap" style="gap:8px;margin-top:14px">
            <a class="btn btn--sm" href="/api/segments/${s.id}/audience.csv?format=meta">Аудитория для Instagram (Meta)</a>
            <a class="btn btn--sm" href="/api/segments/${s.id}/audience.csv?format=tiktok">Аудитория для TikTok</a>
            <a class="btn btn--sm btn--ghost" href="/api/segments/${s.id}/audience.csv?format=preview">Посмотреть список</a>
          </div>
          ${s.stats.consented === 0 ? '<p class="muted" style="margin:10px 0 0;font-size:13px;color:var(--amber)">Никто в сегменте не дал согласия на рекламу — выгрузка будет пустой.</p>' : ''}
        </div>`).join('') : '<div class="empty">Сегментов нет. Создайте первый — например «успешные сделки за полгода» для look-alike аудитории.</div>'}

      <div class="card" style="margin-top:16px">
        <h2 style="margin-bottom:10px">Как загрузить аудиторию</h2>
        <ol class="muted" style="margin:0;padding-left:20px;font-size:13px;line-height:1.9">
          <li><b>Instagram:</b> Meta Ads Manager → Аудитории → Создать аудиторию → Индивидуальная → Список клиентов → загрузить файл.</li>
          <li><b>TikTok:</b> TikTok Ads Manager → Ассеты → Аудитории → Загрузить файл → тип «Хешированные данные».</li>
          <li>Телефоны и почты выгружаются уже захешированными (SHA-256) — сырые контакты наружу не уходят, это требование обеих площадок.</li>
          <li>В выгрузку попадают только те, кто дал согласие на рекламу. Согласие ставится галочкой в форме на сайте или вручную в карточке компании.</li>
        </ol>
      </div>`;

    const editor = $('#segmentEditor');
    $('#addSegment').addEventListener('click', () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) $('#sgName').focus();
    });
    $('#cancelSegment').addEventListener('click', () => (editor.hidden = true));

    $('#previewSegment').addEventListener('click', async () => {
      const { stats } = await api('/segments/preview', { method: 'POST', body: { filters: readSegmentForm() } });
      $('#sgPreview').textContent = `${stats.total} контактов, из них с согласием ${stats.consented}`;
    });

    $('#saveSegment').addEventListener('click', async () => {
      try {
        await api('/segments', { method: 'POST', body: { name: $('#sgName').value, filters: readSegmentForm() } });
        toast('Сегмент сохранён');
        renderMarketing();
      } catch (err) {
        toast(err.message, true);
      }
    });

    view.querySelectorAll('[data-del-seg]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить сегмент?')) return;
        await api('/segments/' + btn.dataset.delSeg, { method: 'DELETE' });
        renderMarketing();
      });
    });
  }

  /* ---------- воронка: настройка ---------- */

  const STAGE_KINDS = { open: 'В работе', won: 'Успешное завершение', lost: 'Отказ' };
  const STAGE_COLORS = { new: 'синий', in_work: 'жёлтый', callback: 'фиолетовый', won: 'зелёный', lost: 'серый' };

  async function renderStages() {
    const { items } = await api('/stages');
    state.stages = items;
    const admin = state.user.role === 'admin';

    view.innerHTML = `
      <div class="page-head">
        <div>
          <h1>Воронка</h1>
          <p class="muted" style="margin:6px 0 0">Этапы, по которым заявка идёт до договора. Порядок = колонки на доске.</p>
        </div>
        ${admin ? '<button class="btn btn--primary btn--sm" id="addStage">+ Стадия</button>' : ''}
      </div>

      <div class="card" style="padding:0;overflow-x:auto">
        <table class="table">
          <thead><tr><th></th><th>Название</th><th>Тип</th><th>Цвет</th><th>Заявок</th><th></th></tr></thead>
          <tbody>
            ${items.map((s, i) => `
              <tr>
                <td class="nowrap">
                  ${admin ? `
                    <button class="btn btn--sm" data-up="${s.id}"${i === 0 ? ' disabled' : ''}>↑</button>
                    <button class="btn btn--sm" data-down="${s.id}"${i === items.length - 1 ? ' disabled' : ''}>↓</button>` : ''}
                </td>
                <td>${statusPill(s.code)}</td>
                <td>${STAGE_KINDS[s.kind]}</td>
                <td class="muted">${STAGE_COLORS[s.color] || s.color}</td>
                <td class="mono">${s.leads_count ?? ''}</td>
                <td class="nowrap">
                  ${admin ? `
                    <button class="btn btn--sm" data-edit="${s.id}">Изменить</button>
                    <button class="btn btn--sm btn--danger" data-del="${s.id}">Удалить</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin-top:12px;font-size:13px">
        Тип «Успешное завершение» и «Отказ» нужны аналитике: по ним считается конверсия и выручка.
      </p>`;

    if (!admin) return;

    const move = async (id, delta) => {
      const ids = items.map((s) => s.id);
      const i = ids.indexOf(Number(id));
      const j = i + delta;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('/stages/reorder', { method: 'POST', body: { ids } });
      renderStages();
    };
    view.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(b.dataset.up, -1)));
    view.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(b.dataset.down, 1)));

    $('#addStage')?.addEventListener('click', async () => {
      const title = prompt('Название стадии (например: КП отправлено):');
      if (!title) return;
      const kind = prompt('Тип: open — в работе, won — успех, lost — отказ', 'open');
      if (kind === null) return;
      try {
        await api('/stages', { method: 'POST', body: { title, kind } });
        toast('Стадия добавлена');
        renderStages();
      } catch (err) {
        toast(err.message, true);
      }
    });

    view.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stage = items.find((s) => String(s.id) === btn.dataset.edit);
        const title = prompt('Название стадии:', stage.title);
        if (title === null) return;
        const kind = prompt('Тип: open / won / lost', stage.kind);
        if (kind === null) return;
        const color = prompt('Цвет: new, in_work, callback, won, lost', stage.color);
        if (color === null) return;
        try {
          await api('/stages/' + stage.id, { method: 'PATCH', body: { title, kind, color } });
          toast('Сохранено');
          renderStages();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    view.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stage = items.find((s) => String(s.id) === btn.dataset.del);
        if (!confirm(`Удалить стадию «${stage.title}»?`)) return;
        try {
          await api('/stages/' + stage.id, { method: 'DELETE' });
          toast('Стадия удалена');
          renderStages();
        } catch (err) {
          // в стадии есть заявки — спрашиваем, куда их перенести
          if (!/перенести/.test(err.message)) return toast(err.message, true);
          const others = items.filter((s) => s.id !== stage.id);
          const target = prompt(
            `${err.message}\n\nКуда перенести? Впишите название:\n` + others.map((s) => '• ' + s.title).join('\n'),
            others[0].title,
          );
          if (!target) return;
          const match = others.find((s) => s.title.toLowerCase() === target.trim().toLowerCase());
          if (!match) return toast('Такой стадии нет', true);
          await api(`/stages/${stage.id}?move_to=${encodeURIComponent(match.code)}`, { method: 'DELETE' });
          toast('Стадия удалена, заявки перенесены');
          renderStages();
        }
      });
    });
  }

  /* ---------- подключение сайта ---------- */

  function snippet(site) {
    const origin = location.origin;
    return `<span class="tag">&lt;script</span> src=<span class="str">"${origin}/embed.js?key=${site.public_key}"</span> defer<span class="tag">&gt;&lt;/script&gt;</span>`;
  }

  async function renderSites() {
    const { items } = await api('/sites');
    state.sites = items;
    const isAdmin = state.user.role === 'admin';

    view.innerHTML = `
      <div class="page-head">
        <h1>Подключение сайта</h1>
        ${isAdmin ? '<button class="btn btn--primary btn--sm" id="addSite">+ Добавить сайт</button>' : ''}
      </div>

      <div class="card" style="margin-bottom:16px">
        <h2>Как подключить за 2 шага</h2>
        <p class="muted" style="margin:8px 0 4px">1. Вставьте скрипт сайта перед закрывающим &lt;/body&gt;:</p>
        <pre class="snippet">${snippet(items[0] || { public_key: 'ВАШ_КЛЮЧ' })}</pre>
        <p class="muted" style="margin:12px 0 4px">2. Пометьте форму атрибутом <code class="mono">data-lead-form</code>, поля назовите name / phone / email / comment:</p>
        <pre class="snippet">${esc(`<form data-lead-form>
  <input name="name"  placeholder="Имя">
  <input name="phone" placeholder="Телефон" required>
  <input name="_hp" style="display:none" tabindex="-1" autocomplete="off">
  <button type="submit">Отправить заявку</button>
</form>`)}</pre>
        <p class="muted" style="margin:12px 0 4px">Скрытое поле <code class="mono">_hp</code> — ловушка для ботов, живой человек его не заполняет.
        Виджет сам подхватывает UTM-метки, referrer и адрес страницы, а на форме вызывает события <code class="mono">lead:success</code> и <code class="mono">lead:error</code>.</p>
        <p class="muted" style="margin:12px 0 4px">Если нужен свой код отправки — шлите POST напрямую:</p>
        <pre class="snippet">${esc(`curl -X POST ${location.origin}/api/v1/leads \\
  -H "Content-Type: application/json" \\
  -d '{"key":"${items[0]?.public_key || 'ВАШ_КЛЮЧ'}","name":"Иван","phone":"+7 700 000 00 00","comment":"Хочу заправку"}'`)}</pre>
      </div>

      <div class="grid">
        ${items.map((s) => `
          <div class="card" data-site="${s.id}">
            <div class="spread" style="margin-bottom:12px">
              <h2>${esc(s.name)} ${s.active ? '' : '<span class="pill pill--lost">выключен</span>'}</h2>
              <span class="muted">${s.leads_count} заявок</span>
            </div>
            <dl class="kv" style="margin-bottom:12px">
              <dt>Ключ</dt><dd class="mono">${esc(s.public_key)} <button class="btn btn--sm" data-copy="${esc(s.public_key)}">копировать</button></dd>
              <dt>Домены</dt><dd class="mono">${esc(s.domains) || '<span class="muted">любые (укажите свои для защиты ключа)</span>'}</dd>
              <dt>Автораспределение</dt><dd>${s.auto_assign ? 'включено' : 'выключено'}</dd>
              <dt>SLA первого контакта</dt><dd>${s.sla_minutes} мин</dd>
              <dt>Вебхук</dt><dd class="mono">${esc(s.webhook_url) || '—'}</dd>
            </dl>
            <pre class="snippet">${snippet(s)}</pre>
            ${isAdmin ? `
              <div class="row row--wrap" style="margin-top:10px">
                <button class="btn btn--sm" data-edit="${s.id}">Настроить</button>
                <button class="btn btn--sm" data-rotate="${s.id}">Сменить ключ</button>
                <button class="btn btn--sm" data-toggle="${s.id}">${s.active ? 'Выключить' : 'Включить'}</button>
              </div>` : ''}
            <div data-form="${s.id}" hidden style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
              <label class="field"><span>Название</span><input data-f="name" value="${esc(s.name)}"></label>
              <label class="field"><span>Разрешённые домены (через запятую, пусто = любые)</span><input data-f="domains" value="${esc(s.domains)}" placeholder="smunai.kz, www.smunai.kz"></label>
              <label class="field"><span>SLA первого контакта, минут</span><input data-f="sla_minutes" type="number" min="1" value="${s.sla_minutes}"></label>
              <label class="field"><span>Вебхук на новую заявку (необязательно)</span><input data-f="webhook_url" value="${esc(s.webhook_url)}" placeholder="https://..."></label>
              <label class="row" style="margin-bottom:12px"><input type="checkbox" data-f="auto_assign" style="width:auto"${s.auto_assign ? ' checked' : ''}> <span>Распределять заявки по менеджерам автоматически</span></label>
              <button class="btn btn--primary btn--sm" data-save="${s.id}">Сохранить</button>
            </div>
          </div>`).join('')}
      </div>`;

    view.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.dataset.copy);
        toast('Ключ скопирован');
      }));

    view.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => {
        const box = view.querySelector(`[data-form="${b.dataset.edit}"]`);
        box.hidden = !box.hidden;
      }));

    view.querySelectorAll('[data-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        const box = view.querySelector(`[data-form="${b.dataset.save}"]`);
        const body = {};
        box.querySelectorAll('[data-f]').forEach((el) => {
          body[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
        });
        try {
          await api('/sites/' + b.dataset.save, { method: 'PATCH', body });
          toast('Сохранено');
          renderSites();
        } catch (err) {
          toast(err.message, true);
        }
      }));

    view.querySelectorAll('[data-rotate]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Старый ключ перестанет работать — сниппет на сайте придётся обновить. Продолжить?')) return;
        await api(`/sites/${b.dataset.rotate}/rotate`, { method: 'POST' });
        toast('Ключ обновлён');
        renderSites();
      }));

    view.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', async () => {
        const site = items.find((s) => String(s.id) === b.dataset.toggle);
        await api('/sites/' + site.id, { method: 'PATCH', body: { active: !site.active } });
        renderSites();
      }));

    $('#addSite')?.addEventListener('click', async () => {
      const name = prompt('Название сайта:');
      if (!name) return;
      const domains = prompt('Домены через запятую (можно пропустить):') || '';
      try {
        await api('/sites', { method: 'POST', body: { name, domains } });
        toast('Сайт добавлен');
        renderSites();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  /* ---------- сотрудники ---------- */

  /* ---------- бот ---------- */

  async function renderBot() {
    const data = await api('/settings');
    const s = data.settings;
    const admin = state.user.role === 'admin';

    view.innerHTML = `
      <h1 class="page-title">Бот</h1>

      <div class="card" style="margin-bottom:16px">
        <h2 style="margin-bottom:10px">Как он сейчас работает</h2>
        <dl class="kv">
          <dt>Ответы</dt><dd>${data.ai
            ? `отвечает ИИ, модель <span class="mono">${esc(data.model)}</span>`
            : '<span style="color:var(--red)">ИИ не подключён</span> — бот здоровается и зовёт менеджера'}</dd>
          <dt>База знаний</dt><dd>${data.knowledge_unfilled
            ? '<span style="color:var(--red)">не заполнена</span> — на вопросы о ценах и адресах бот будет отвечать «уточню у менеджера»'
            : 'заполнена'}</dd>
        </dl>
        ${data.ai ? '' : `
        <p class="muted" style="margin-top:10px">
          Чтобы отвечал ИИ, задайте переменную окружения <span class="mono">GEMINI_API_KEY</span> и перезапустите сервис.
        </p>`}
      </div>

      <div class="card">
        <h2 style="margin-bottom:6px">База знаний</h2>
        <p class="muted" style="margin-bottom:12px">
          Бот отвечает клиентам только тем, что написано здесь. Чего здесь нет — на то он
          отвечает «уточню у менеджера» и передаёт разговор живому человеку.
          Пишите простым текстом, как объяснили бы новому сотруднику.
        </p>
        <form id="botForm">
          <label class="field">
            <span>Что бот знает о компании</span>
            <textarea name="bot_knowledge" rows="20" class="mono" style="font-size:13px"
              ${admin ? '' : 'disabled'}>${esc(s.bot_knowledge)}</textarea>
          </label>
          <label class="field" style="margin-top:12px">
            <span>Как представляется при первом сообщении (необязательно)</span>
            <input name="bot_greeting" value="${esc(s.bot_greeting)}"
              placeholder="Здравствуйте! Это Айгуль из С-Мұнай." ${admin ? '' : 'disabled'}>
          </label>
          ${admin
            ? '<button class="btn btn--primary" style="margin-top:12px" type="submit">Сохранить</button>'
            : '<p class="muted" style="margin-top:12px">Менять базу знаний может только администратор.</p>'}
        </form>
      </div>`;

    if (!admin) return;
    $('#botForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/settings', {
          method: 'PUT',
          body: { bot_knowledge: fd.get('bot_knowledge'), bot_greeting: fd.get('bot_greeting') },
        });
        toast('База знаний сохранена');
        renderBot();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  async function renderTeam() {
    const { items } = await api('/users');
    state.users = items;
    const isAdmin = state.user.role === 'admin';
    const isSenior = state.user.role === 'senior' || state.user.role === 'senior_manager';

    view.innerHTML = `
      <div class="page-head"><h1>Сотрудники</h1></div>
      <div class="card" style="padding:0;margin-bottom:16px;overflow-x:auto">
        <table class="table">
          <thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Статус</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
          <tbody>
            ${items.map((u) => `
              <tr style="cursor:default">
                <td>${esc(u.name)}</td>
                <td class="mono">${esc(u.email)}</td>
                <td>${u.role === 'admin' ? 'Администратор' : (u.role === 'senior' || u.role === 'senior_manager' ? 'Старший менеджер' : 'Менеджер')}</td>
                <td>${u.active ? '<span class="pill pill--won">активен</span>' : '<span class="pill pill--lost">отключён</span>'}</td>
                ${isAdmin ? `<td class="nowrap">
                  <button class="btn btn--sm" data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Отключить' : 'Включить'}</button>
                  <button class="btn btn--sm" data-user-pass="${u.id}">Сменить пароль</button>
                </td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      ${isAdmin || isSenior ? `
      <div class="card" style="max-width:420px">
        <h2 style="margin-bottom:12px">Добавить менеджера</h2>
        <form id="newUser">
          <label class="field"><span>Имя</span><input name="name" required></label>
          <label class="field"><span>Email</span><input name="email" type="email" required></label>
          <label class="field"><span>Пароль (от 8 символов)</span><input name="password" type="password" minlength="8" required></label>
          ${isAdmin ? `
          <label class="field"><span>Роль</span>
            <select name="role">
              <option value="manager">Менеджер</option>
              <option value="hr">HR-менеджер</option>
              <option value="senior">Старший менеджер</option>
              <option value="admin">Администратор</option>
            </select>
          </label>` : `<input type="hidden" name="role" value="manager">`}
          <button class="btn btn--primary" type="submit">Создать</button>
        </form>
      </div>` : ''}`;

    $('#newUser')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        await api('/users', { method: 'POST', body });
        toast('Сотрудник добавлен');
        renderTeam();
      } catch (err) {
        toast(err.message, true);
      }
    });

    view.querySelectorAll('[data-user-toggle]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/users/' + b.dataset.userToggle, { method: 'PATCH', body: { active: b.dataset.active !== '1' } });
        renderTeam();
      }));

    view.querySelectorAll('[data-user-pass]').forEach((b) =>
      b.addEventListener('click', async () => {
        const password = prompt('Новый пароль (от 8 символов):');
        if (!password) return;
        try {
          await api('/users/' + b.dataset.userPass, { method: 'PATCH', body: { password } });
          toast('Пароль изменён');
        } catch (err) {
          toast(err.message, true);
        }
      }));
  }

  /* ---------- запуск ---------- */

  async function refreshBadge() {
    if (!state.user) return;
    try {
      const [{ stats }, tasks] = await Promise.all([api('/stats'), api('/tasks?scope=me&filter=today')]);

      const badge = $('#navNew');
      const count = stats.counts.new;
      badge.hidden = !count;
      badge.textContent = count;
      badge.classList.toggle('badge-count--warn', stats.overdue > 0);

      // в бейдже дел — то, что горит сегодня или уже просрочено
      const due = tasks.counts.overdue + tasks.counts.today;
      const taskBadge = $('#navTasks');
      taskBadge.hidden = !due;
      taskBadge.textContent = due;
      taskBadge.classList.toggle('badge-count--warn', tasks.counts.overdue > 0);
    } catch {}
  }

  /* ---------- живые обновления ---------- */

  /** Перерисовывать список на месте можно, только если он никому не мешает. */
  function safeToRefresh() {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
    return !document.querySelector('.board__card.dragging');
  }

  function currentPath() {
    return (location.hash.replace(/^#/, '') || '/leads').split('?')[0];
  }

  function liveRefresh(changedId) {
    refreshBadge();
    const path = currentPath();
    const onList = path === '/leads' || path === '/board';
    const onChangedLead = changedId != null && path === '/lead/' + changedId;
    if ((onList || onChangedLead) && safeToRefresh()) route();
  }

  function connectEvents() {
    const es = new EventSource('/api/events');

    es.addEventListener('lead:new', (e) => {
      const lead = JSON.parse(e.data);
      toast(`🔔 Новая заявка: ${lead.name || lead.phone || '№' + lead.id}`);
      liveRefresh(lead.id);
    });

    es.addEventListener('lead:update', (e) => {
      const { id, by } = JSON.parse(e.data);
      // свои же изменения панель уже отрисовала — второй перерисовки не нужно
      if (by === state.user.id) return;
      liveRefresh(id);
    });

    es.addEventListener('task:change', (e) => {
      const { lead_id } = JSON.parse(e.data);
      refreshBadge();
      const path = currentPath();
      const affected = path === '/tasks' || (lead_id != null && path === '/lead/' + lead_id);
      if (affected && safeToRefresh()) route();
    });

    // обрыв связи EventSource лечит сам; после 401 он закрывается — пробуем позже,
    // но только пока пользователь залогинен
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) return;
      setTimeout(() => {
        if (connectEvents._es === es && !$('#app').hidden) connectEvents();
      }, 5000);
    };

    connectEvents._es?.close();
    connectEvents._es = es;
  }

  async function boot() {
    const [users, sites, stages] = await Promise.all([api('/users'), api('/sites'), api('/stages')]);
    state.users = users.items;
    state.sites = sites.items;
    state.stages = stages.items;

    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    $('#userName').textContent = state.user.name;
    
    let roleName = 'Менеджер';
    if (state.user.role === 'admin') roleName = 'Администратор';
    else if (state.user.role === 'hr') roleName = 'HR-менеджер';
    else if (state.user.role === 'senior' || state.user.role === 'senior_manager') roleName = 'Старший менеджер';
    $('#userRole').textContent = roleName;

    const isAdmin = state.user.role === 'admin';
    const isSenior = state.user.role === 'senior' || state.user.role === 'senior_manager';
    const isHr = state.user.role === 'hr';
    
    $('[data-nav="stats"]').hidden = !(isAdmin || isSenior);
    $('[data-nav="marketing"]').hidden = isHr;
    $('[data-nav="companies"]').hidden = isHr;
    $('[data-nav="stages"]').hidden = !isAdmin;
    $('[data-nav="sites"]').hidden = !isAdmin;
    $('[data-nav="bot"]').hidden = !isAdmin;
    $('[data-nav="team"]').hidden = !(isAdmin || isSenior);

    const switcher = $('#crmTypeSwitcher');
    if (isAdmin) {
      switcher.hidden = false;
      switcher.value = state.appType;
      switcher.onchange = async (e) => {
        state.appType = e.target.value;
        localStorage.setItem('appType', state.appType);
        const [newStages] = await Promise.all([api('/stages')]);
        state.stages = newStages.items;
        route();
      };
    } else {
      switcher.hidden = true;
    }

    await route();
    refreshBadge();

    clearInterval(boot._t);
    if (state.live) {
      connectEvents();
      // страховка на случай, если поток событий оборвался незаметно
      boot._t = setInterval(refreshBadge, 60000);
    } else {
      // живого потока нет (сервис работает в функции) — подтягиваем список сами
      boot._t = setInterval(() => safeToRefresh() && liveRefresh(), 30000);
    }
  }

  api('/me')
    .then((r) => {
      state.user = r.user;
      state.live = r.live !== false;
      return boot();
    })
    .catch(showLogin);
})();
