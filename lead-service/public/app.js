/* Панель отдела продаж: заявки, доска, аналитика, подключение сайтов. */
(function () {
  'use strict';

  const STATUSES = {
    new: 'Новая',
    in_work: 'В работе',
    callback: 'Перезвонить',
    won: 'Успех',
    lost: 'Отказ',
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const state = { user: null, users: [], sites: [], filters: {} };

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

  const statusPill = (s) => `<span class="pill pill--${s}">${STATUSES[s] || s}</span>`;

  function toast(msg, isError) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  async function api(path, options = {}) {
    const res = await fetch('/api' + path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (res.status === 401 && !path.startsWith('/auth')) {
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
    // без сессии поток событий всё равно отдаёт 401 — не переподключаемся вхолостую
    connectEvents._es?.close();
    connectEvents._es = null;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $('#loginError').textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      state.user = r.user;
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

  /* ---------- маршрутизация ---------- */

  const routes = [
    [/^\/leads$/, renderLeads],
    [/^\/board$/, renderBoard],
    [/^\/lead\/(\d+)$/, renderLead],
    [/^\/companies$/, renderCompanies],
    [/^\/company\/(\d+)$/, renderCompany],
    [/^\/stats$/, renderStats],
    [/^\/sites$/, renderSites],
    [/^\/team$/, renderTeam],
  ];

  // карточка относится к разделу списка: /lead/7 -> «Все заявки», /company/3 -> «Компании»
  const NAV_OF_CARD = { '/lead/': 'leads', '/company/': 'companies' };

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
        <select id="fstatus">${opts(Object.entries(STATUSES).map(([v, t]) => ({ v, t })), f.status, 'Все статусы')}</select>
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
          ${esc(l.utm_source || l.site_name || '—')}${l.utm_campaign ? '<br>' + esc(l.utm_campaign) : ''}
        </td>
      </tr>`;
  }

  /* ---------- заявки: доска ---------- */

  async function renderBoard() {
    const data = await api('/leads?limit=300&' + filterQuery());
    const cols = Object.entries(STATUSES).map(([key, title]) => {
      const items = data.items.filter((l) => l.status === key);
      return `
        <div class="board__col" data-status="${key}">
          <div class="board__head"><span>${title}</span><span class="muted">${items.length}</span></div>
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
      <div class="page-head"><h1>Доска</h1><span class="muted">Перетащите карточку, чтобы сменить статус</span></div>
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
              <thead><tr><th>Имя</th><th>Должность</th><th>Телефон</th><th>Email</th><th></th></tr></thead>
              <tbody>
                ${contacts.map((c) => `
                  <tr>
                    <td>${esc(c.name) || '<span class="muted">без имени</span>'}</td>
                    <td>${esc(c.position) || '<span class="muted">—</span>'}</td>
                    <td class="mono nowrap">${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</td>
                    <td class="mono">${esc(c.email) || '—'}</td>
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
    const { lead, events } = await api('/leads/' + id);
    const extra = JSON.parse(lead.extra || '{}');

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
              <dt>Сайт</dt><dd>${esc(lead.site_name || '—')}</dd>
              <dt>Страница</dt><dd>${lead.page_url ? `<a href="${esc(lead.page_url)}" target="_blank" rel="noopener">${esc(lead.page_url)}</a>` : '—'}</dd>
              <dt>UTM</dt><dd class="mono">${esc([lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term].filter(Boolean).join(' / ')) || '—'}</dd>
              <dt>Referrer</dt><dd class="mono">${esc(lead.referrer) || '—'}</dd>
              <dt>IP</dt><dd class="mono">${esc(lead.ip) || '—'}</dd>
              ${Object.entries(extra).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
            </dl>
          </div>

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
            <span>Статус</span>
            <select id="setStatus">
              ${Object.entries(STATUSES).map(([v, t]) => `<option value="${v}"${lead.status === v ? ' selected' : ''}>${t}</option>`).join('')}
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
          <label class="field" id="lostWrap"${lead.status === 'lost' ? '' : ' hidden'}>
            <span>Причина отказа</span>
            <input type="text" id="setLost" value="${esc(lead.lost_reason)}" placeholder="Дорого, выбрали конкурента…">
          </label>
          <button class="btn btn--primary" id="saveLead" style="width:100%">Сохранить</button>
          ${state.user.role === 'admin' ? '<button class="btn btn--danger btn--sm" id="delLead" style="width:100%;margin-top:8px">Удалить заявку</button>' : ''}
        </div>
      </div>`;

    $('#setStatus').addEventListener('change', (e) => {
      $('#lostWrap').hidden = e.target.value !== 'lost';
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
          ${Object.entries(STATUSES).map(([k, t]) => `
            <div style="min-width:120px">
              <div style="font-size:22px;font-weight:600">${stats.counts[k]}</div>
              <div>${statusPill(k)}</div>
            </div>`).join('')}
        </div>
      </div>`;
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

  async function renderTeam() {
    const { items } = await api('/users');
    state.users = items;
    const isAdmin = state.user.role === 'admin';

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
                <td>${u.role === 'admin' ? 'Администратор' : 'Менеджер'}</td>
                <td>${u.active ? '<span class="pill pill--won">активен</span>' : '<span class="pill pill--lost">отключён</span>'}</td>
                ${isAdmin ? `<td class="nowrap">
                  <button class="btn btn--sm" data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Отключить' : 'Включить'}</button>
                  <button class="btn btn--sm" data-user-pass="${u.id}">Сменить пароль</button>
                </td>` : ''}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>

      ${isAdmin ? `
      <div class="card" style="max-width:420px">
        <h2 style="margin-bottom:12px">Добавить менеджера</h2>
        <form id="newUser">
          <label class="field"><span>Имя</span><input name="name" required></label>
          <label class="field"><span>Email</span><input name="email" type="email" required></label>
          <label class="field"><span>Пароль (от 8 символов)</span><input name="password" type="password" minlength="8" required></label>
          <label class="field"><span>Роль</span>
            <select name="role"><option value="manager">Менеджер</option><option value="admin">Администратор</option></select>
          </label>
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
      const { stats } = await api('/stats');
      const badge = $('#navNew');
      const count = stats.counts.new;
      badge.hidden = !count;
      badge.textContent = count;
      badge.classList.toggle('badge-count--warn', stats.overdue > 0);
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
    const [users, sites] = await Promise.all([api('/users'), api('/sites')]);
    state.users = users.items;
    state.sites = sites.items;

    $('#loginScreen').hidden = true;
    $('#app').hidden = false;
    $('#userName').textContent = state.user.name;
    $('#userRole').textContent = state.user.role === 'admin' ? 'Администратор' : 'Менеджер';

    await route();
    refreshBadge();
    connectEvents();
    // страховка на случай, если поток событий оборвался незаметно
    clearInterval(boot._t);
    boot._t = setInterval(refreshBadge, 60000);
  }

  api('/me')
    .then((r) => {
      state.user = r.user;
      return boot();
    })
    .catch(showLogin);
})();
