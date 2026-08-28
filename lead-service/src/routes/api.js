import { db } from '../db.js';
import { config } from '../config.js';
import { createHash, randomBytes } from 'node:crypto';
import { json, readInput } from '../http.js';
import {
  currentUser, createSession, sessionCookie, clearCookie,
  destroySession, verifyPassword, hashPassword,
} from '../auth.js';
import { updateLead } from '../leads.js';
import { findCompany, createCompany, updateCompany, createContact, updateContact } from '../crm.js';
import { listTasks, taskCounts, createTask, updateTask, deleteTask } from '../tasks.js';
import {
  listSegments, getSegment, createSegment, updateSegment, deleteSegment,
  audience, audienceStats, audienceCsv, audiencePreviewCsv,
} from '../marketing.js';
import { subscribe } from '../events.js';
import { listMessages, replyAsManager } from '../conversations.js';
import { allSettings, setSetting, knowledgeLooksUnfilled } from '../settings.js';
import { aiEnabled } from '../ai.js';
import { clip, randomKey, isEmail } from '../util.js';
import {
  listStages, codesOfKind, inClause, stageTitles,
  createStage, updateStage, deleteStage, reorderStages,
} from '../stages.js';

const LEAD_COLUMNS = `
  l.*,
  u.name AS assigned_name,
  s.name AS site_name,
  s.sla_minutes AS sla_minutes,
  co.name AS company_name,
  ct.name AS contact_name
`;
const LEAD_FROM = `
  FROM leads l
  LEFT JOIN users u ON u.id = l.assigned_to
  LEFT JOIN sites s ON s.id = l.site_id
  LEFT JOIN companies co ON co.id = l.company_id
  LEFT JOIN contacts ct ON ct.id = l.contact_id
`;

function buildFilters(url, user) {
  const where = [];
  const args = [];

  let type = url.searchParams.get('type') || 'sales';
  if (user.role === 'hr') type = 'hr';
  else if (user.role !== 'admin') type = 'sales';
  
  where.push('l.type = ?');
  args.push(type);

  const status = url.searchParams.get('status');
  if (status && status !== 'all') {
    const known = new Set(listStages().map((s) => s.code));
    const list = status.split(',').filter((s) => known.has(s));
    if (list.length) {
      where.push(`l.status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
  }

  const assigned = url.searchParams.get('assigned');
  if (assigned === 'me') {
    where.push('l.assigned_to = ?');
    args.push(user.id);
  } else if (assigned === 'none') {
    where.push('l.assigned_to IS NULL');
  } else if (assigned) {
    where.push('l.assigned_to = ?');
    args.push(Number(assigned));
  }

  const site = url.searchParams.get('site');
  if (site) {
    where.push('l.site_id = ?');
    args.push(Number(site));
  }

  const company = url.searchParams.get('company');
  if (company) {
    where.push('l.company_id = ?');
    args.push(Number(company));
  }

  const q = clip(url.searchParams.get('q'), 80);
  if (q) {
    const digits = q.replace(/\D+/g, '');
    where.push('(l.name LIKE ? OR l.email LIKE ? OR l.comment LIKE ?' + (digits ? ' OR l.phone_norm LIKE ?' : '') + ')');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    if (digits) args.push(`%${digits}%`);
  }

  const from = url.searchParams.get('from');
  if (from) {
    where.push('l.created_at >= ?');
    args.push(`${from} 00:00:00`);
  }
  const to = url.searchParams.get('to');
  if (to) {
    where.push('l.created_at <= ?');
    args.push(`${to} 23:59:59`);
  }

  if (url.searchParams.get('overdue') === '1') {
    const open = inClause(codesOfKind('open'));
    where.push(
      `l.first_touch_at IS NULL AND l.status IN (${open.sql})
       AND l.created_at < datetime('now', '-' || COALESCE(s.sla_minutes, 15) || ' minutes')`,
    );
    args.push(...open.args);
  }

  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

function listLeads(url, user) {
  const { sql, args } = buildFilters(url, user);
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  const rows = db
    .prepare(`SELECT ${LEAD_COLUMNS} ${LEAD_FROM} ${sql} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c ${LEAD_FROM} ${sql}`).get(...args).c;

  return { items: rows, total, limit, offset };
}

function stats() {
  const stages = listStages();
  const won = inClause(codesOfKind('won'));
  const lost = inClause(codesOfKind('lost'));
  const open = inClause(codesOfKind('open'));

  const byStatus = db.prepare("SELECT status, COUNT(*) AS c FROM leads WHERE type = 'sales' GROUP BY status").all();
  const counts = Object.fromEntries(stages.map((s) => [s.code, 0]));
  for (const r of byStatus) counts[r.status] = r.c;

  const period = (expr) => db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE type = 'sales' AND created_at > datetime('now', ?)`).get(expr).c;

  const responseRow = db
    .prepare(
      `SELECT AVG((julianday(first_touch_at) - julianday(created_at)) * 24 * 60) AS avg_min
         FROM leads WHERE type = 'sales' AND first_touch_at IS NOT NULL AND created_at > datetime('now','-30 days')`,
    )
    .get();

  // просрочка SLA: до заявки ещё не дотронулись, а срок первого контакта вышел
  const overdue = db
    .prepare(
      `SELECT COUNT(*) AS c FROM leads l LEFT JOIN sites s ON s.id = l.site_id
        WHERE l.type = 'sales' AND l.first_touch_at IS NULL
          AND l.status IN (${open.sql})
          AND l.created_at < datetime('now', '-' || COALESCE(s.sla_minutes, 15) || ' minutes')`,
    )
    .get(...open.args).c;

  const bySource = db
    .prepare(
      `SELECT CASE WHEN utm_source = '' THEN 'прямой заход' ELSE utm_source END AS source,
              COUNT(*) AS total,
              SUM(status IN (${won.sql})) AS won
         FROM leads WHERE type = 'sales' AND created_at > datetime('now','-30 days')
        GROUP BY source ORDER BY total DESC LIMIT 10`,
    )
    .all(...won.args);

  const byManager = db
    .prepare(
      `SELECT u.id, u.name,
              COUNT(l.id) AS total,
              SUM(l.status IN (${won.sql})) AS won,
              SUM(l.status IN (${open.sql})) AS open
         FROM users u LEFT JOIN leads l
           ON l.assigned_to = u.id AND l.created_at > datetime('now','-30 days') AND l.type = 'sales'
        WHERE u.active = 1
        GROUP BY u.id ORDER BY total DESC`,
    )
    .all(...won.args, ...open.args);

  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS sum FROM leads
        WHERE status IN (${won.sql}) AND closed_at > datetime('now','-30 days')`,
    )
    .get(...won.args).sum;

  const sum = (codes) => codes.reduce((acc, code) => acc + (counts[code] || 0), 0);
  const wonCount = sum(won.args);
  const closed = wonCount + sum(lost.args);

  return {
    counts,
    stages,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    today: period('-1 day'),
    week: period('-7 days'),
    month: period('-30 days'),
    avgResponseMinutes: responseRow.avg_min ? Math.round(responseRow.avg_min * 10) / 10 : null,
    conversion: closed ? Math.round((wonCount / closed) * 1000) / 10 : null,
    overdue,
    revenue,
    bySource,
    byManager,
  };
}

function toCsv(rows) {
  const STATUSES = stageTitles();
  const head = [
    'ID', 'Дата', 'Имя', 'Телефон', 'Email', 'Комментарий', 'Статус',
    'Ответственный', 'Сайт', 'Источник', 'Кампания', 'Страница', 'Сумма',
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(';')];
  for (const r of rows) {
    lines.push([
      r.id, r.created_at, r.name, r.phone, r.email, r.comment, STATUSES[r.status] || r.status,
      r.assigned_name || '', r.site_name || '', r.utm_source, r.utm_campaign, r.page_url,
      r.amount ?? '',
    ].map(esc).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

import { checkRateLimit } from '../ratelimit.js';

/** @returns {boolean} обработан ли запрос */
export async function handleApi(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  /* ---------- аутентификация ---------- */

  if (p === '/api/auth/login' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'login', 5, 15)) {
      json(res, 429, { ok: false, message: 'Слишком много попыток. Попробуйте позже.' });
      return true;
    }
    const body = await readInput(req);
    const email = clip(body.email, 160).toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (!row || !verifyPassword(body.password || '', row.password_hash)) {
      json(res, 401, { ok: false, message: 'Неверный email или пароль' });
      return true;
    }
    const s = await createSession(db, row.id);
    json(
      res, 200,
      { ok: true, user: { id: row.id, name: row.name, email: row.email, role: row.role }, live: !config.serverless },
      { 'Set-Cookie': sessionCookie(s.id, s.expires) },
    );
    return true;
  }

  if (p === '/api/auth/reset-password' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'reset_req', 3, 60)) {
      json(res, 429, { ok: false, message: 'Слишком много попыток сброса. Попробуйте позже.' });
      return true;
    }
    const body = await readInput(req);
    const email = clip(body.email, 160).toLowerCase();
    const row = db.prepare('SELECT id, email FROM users WHERE email = ? AND active = 1').get(email);
    if (!row) {
      json(res, 200, { ok: true, message: 'If registered, a reset link has been sent.' });
      return true;
    }
    const resetToken = randomBytes(32).toString('hex');
    const hashedToken = createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19);

    db.prepare('INSERT INTO password_resets (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedToken, row.id, expiresAt);

    const resetUrl = `${config.publicUrl}/admin/auth?token=${resetToken}`;
    
    if (config.telegramToken && config.telegramChatId) {
      try {
        const text = `🔐 <b>Сброс пароля</b>\n\nПоступил запрос на сброс пароля для пользователя: <b>${row.email}</b>.\n\nЕсли это вы, перейдите по ссылке (действительна 1 час):\n<a href="${resetUrl}">${resetUrl}</a>\n\n<i>Если вы не запрашивали сброс, просто проигнорируйте это сообщение.</i>`;
        
        await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.telegramChatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
      } catch (e) {
        console.error('[telegram] send error:', e.message);
      }
    } else {
      console.log(`[auth] No TELEGRAM token in config. Reset URL for ${row.email}: ${resetUrl}`);
    }
    json(res, 200, { ok: true, message: 'If registered, a reset link has been sent.' });
    return true;
  }

  if (p === '/api/auth/confirm-reset' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'reset_conf', 5, 60)) {
      json(res, 429, { ok: false, message: 'Слишком много попыток.' });
      return true;
    }
    const body = await readInput(req);
    if (!body.token || !body.newPassword || String(body.newPassword).length < 8) {
      json(res, 400, { ok: false, message: 'Некорректный токен или пароль слишком короткий (мин 8 символов)' });
      return true;
    }
    const hashedToken = createHash('sha256').update(body.token).digest('hex');
    const row = db.prepare('SELECT user_id, expires_at FROM password_resets WHERE id = ?').get(hashedToken);
    if (!row || new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
      json(res, 400, { ok: false, message: 'Токен недействителен или устарел' });
      return true;
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), row.user_id);
    db.prepare('DELETE FROM password_resets WHERE id = ?').run(hashedToken);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
    json(res, 200, { ok: true, message: 'Пароль успешно сброшен' });
    return true;
  }

  const user = currentUser(db, req);

  if (p === '/api/auth/logout' && req.method === 'POST') {
    destroySession(db, user?.sid);
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
    return true;
  }

  if (!user) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }

  // защита от CSRF: у мутаций Origin обязан совпадать с хостом сервиса
  if (req.method !== 'GET' && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        json(res, 403, { ok: false, error: 'bad_origin' });
        return true;
      }
    } catch {
      json(res, 403, { ok: false, error: 'bad_origin' });
      return true;
    }
  }

  const isAdmin = user.role === 'admin';
  const isSenior = user.role === 'senior' || user.role === 'senior_manager';
  const denyNonAdmin = () => {
    json(res, 403, { ok: false, message: 'Недостаточно прав' });
    return true;
  };

  if (p === '/api/me') {
    // live=false — панель не станет открывать поток событий и обойдётся без живых обновлений
    json(res, 200, { ok: true, user, live: !config.serverless });
    return true;
  }

  /* ---------- бот: база знаний ---------- */

  if (p === '/api/settings' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      settings: allSettings(),
      ai: aiEnabled(),
      model: config.ai.model,
      knowledge_unfilled: knowledgeLooksUnfilled(),
    });
    return true;
  }

  if (p === '/api/settings' && (req.method === 'PUT' || req.method === 'PATCH')) {
    if (!isAdmin) return denyNonAdmin();
    const body = await readInput(req);
    for (const key of ['bot_knowledge', 'bot_greeting']) {
      if (key in body) setSetting(key, clip(body[key], 20000));
    }
    json(res, 200, { ok: true, settings: allSettings(), knowledge_unfilled: knowledgeLooksUnfilled() });
    return true;
  }

  // поток живых обновлений: панель сама подтягивает новые заявки
  if (p === '/api/events' && req.method === 'GET') {
    // в функции держать открытый поток нечем: она живёт один запрос и общей памяти между
    // экземплярами нет, так что событие всё равно не дошло бы до чужой вкладки
    if (config.serverless) {
      json(res, 501, { ok: false, error: 'live_unavailable' });
      return true;
    }
    subscribe(req, res);
    return true;
  }

  /* ---------- заявки ---------- */

  if (p === '/api/leads' && req.method === 'GET') {
    json(res, 200, { ok: true, ...listLeads(url, user) });
    return true;
  }

  if (p === '/api/leads' && req.method === 'POST') {
    // ручное добавление заявки менеджером (звонок, визит и т.п.)
    const body = await readInput(req);
    const { createLead } = await import('../leads.js');
    const result = createLead({ ...body, form_id: 'manual' }, { site: null, ip: '', userAgent: 'manual' });
    if (!result.ok) {
      json(res, 400, result);
      return true;
    }
    db.prepare('UPDATE leads SET assigned_to = COALESCE(assigned_to, ?) WHERE id = ?').run(user.id, result.lead.id);
    json(res, 201, { ok: true, lead: result.lead });
    return true;
  }

  if (p === '/api/leads/export.csv') {
    const { sql, args } = buildFilters(url, user);
    const rows = db.prepare(`SELECT ${LEAD_COLUMNS} ${LEAD_FROM} ${sql} ORDER BY l.created_at DESC`).all(...args);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end(toCsv(rows));
    return true;
  }

  const leadMatch = p.match(/^\/api\/leads\/(\d+)$/);
  if (leadMatch) {
    const id = Number(leadMatch[1]);
    if (req.method === 'GET') {
      const lead = db.prepare(`SELECT ${LEAD_COLUMNS} ${LEAD_FROM} WHERE l.id = ?`).get(id);
      if (!lead) {
        json(res, 404, { ok: false, error: 'not_found' });
        return true;
      }
      
      // Авторизация доступа к заявке
      if (user.role === 'hr' && lead.type !== 'hr') {
        json(res, 403, { ok: false, error: 'forbidden', message: 'HR может просматривать только HR-заявки' });
        return true;
      }
      if (user.role !== 'hr' && user.role !== 'admin' && lead.type === 'hr') {
        json(res, 403, { ok: false, error: 'forbidden', message: 'Менеджер не может просматривать HR-заявки' });
        return true;
      }

      const events = db
        .prepare(
          `SELECT e.*, u.name AS user_name FROM lead_events e
             LEFT JOIN users u ON u.id = e.user_id
            WHERE e.lead_id = ? ORDER BY e.id ASC`,
        )
        .all(id);
      json(res, 200, { ok: true, lead, events, messages: listMessages(id) });
      return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const leadBefore = db.prepare(`SELECT type FROM leads WHERE id = ?`).get(id);
        if (!leadBefore) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        if (user.role === 'hr' && leadBefore.type !== 'hr') {
          json(res, 403, { ok: false, error: 'forbidden' });
          return true;
        }
        if (user.role !== 'hr' && user.role !== 'admin' && leadBefore.type === 'hr') {
          json(res, 403, { ok: false, error: 'forbidden' });
          return true;
        }

        const lead = updateLead(id, body, user);
        if (!lead) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, lead });
      } catch (e) {
        json(res, e.status || 500, { ok: false, error: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!isAdmin) return denyNonAdmin();
      db.prepare('DELETE FROM leads WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  // ответ клиенту прямо из карточки — уходит в тот мессенджер, откуда он написал
  const replyMatch = p.match(/^\/api\/leads\/(\d+)\/reply$/);
  if (replyMatch && req.method === 'POST') {
    const id = Number(replyMatch[1]);
    const leadBefore = db.prepare(`SELECT type FROM leads WHERE id = ?`).get(id);
    if (!leadBefore) { json(res, 404, { ok: false, error: 'not_found' }); return true; }
    if (user.role === 'hr' && leadBefore.type !== 'hr') { json(res, 403, { ok: false }); return true; }
    if (user.role !== 'hr' && user.role !== 'admin' && leadBefore.type === 'hr') { json(res, 403, { ok: false }); return true; }

    const body = await readInput(req);
    const text = clip(body.text, 4000);
    if (!text) {
      json(res, 400, { ok: false, message: 'Пустое сообщение' });
      return true;
    }
    try {
      const sent = await replyAsManager(id, text, user);
      if (!sent) json(res, 404, { ok: false, error: 'not_found' });
      else json(res, 200, { ok: true, messages: listMessages(id) });
    } catch (e) {
      json(res, e.status || 502, { ok: false, message: e.message });
    }
    return true;
  }

  const commentMatch = p.match(/^\/api\/leads\/(\d+)\/comments$/);
  if (commentMatch && req.method === 'POST') {
    const id = Number(commentMatch[1]);
    const leadBefore = db.prepare(`SELECT type FROM leads WHERE id = ?`).get(id);
    if (!leadBefore) { json(res, 404, { ok: false, error: 'not_found' }); return true; }
    if (user.role === 'hr' && leadBefore.type !== 'hr') { json(res, 403, { ok: false }); return true; }
    if (user.role !== 'hr' && user.role !== 'admin' && leadBefore.type === 'hr') { json(res, 403, { ok: false }); return true; }

    const body = await readInput(req);
    const text = clip(body.text, 2000);
    if (!text) {
      json(res, 400, { ok: false, message: 'Пустой комментарий' });
      return true;
    }
    db.prepare('INSERT INTO lead_events (lead_id, user_id, type, text) VALUES (?, ?, ?, ?)').run(
      Number(commentMatch[1]), user.id, 'comment', text,
    );
    db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(Number(commentMatch[1]));
    json(res, 201, { ok: true });
    return true;
  }

  if (p === '/api/stats' && req.method === 'GET') {
    if (!isAdmin && !isSenior) return denyNonAdmin();
    json(res, 200, { ok: true, stats: stats() });
    return true;
  }

  /* ---------- маркетинг: сегменты и аудитории ---------- */

  if (p === '/api/segments' && req.method === 'GET') {
    const items = listSegments().map((s) => {
      const filters = JSON.parse(s.filters || '{}');
      return { ...s, filters, stats: audienceStats(filters) };
    });
    json(res, 200, { ok: true, items });
    return true;
  }

  if (p === '/api/segments' && req.method === 'POST') {
    const body = await readInput(req);
    try {
      json(res, 201, { ok: true, segment: createSegment(body, user) });
    } catch (e) {
      json(res, e.status || 500, { ok: false, message: e.message });
    }
    return true;
  }

  // размер выборки до сохранения — чтобы видеть, кого зацепит
  if (p === '/api/segments/preview' && req.method === 'POST') {
    const body = await readInput(req);
    const filters = body.filters || {};
    json(res, 200, {
      ok: true,
      stats: audienceStats(filters),
      sample: audience(filters, { consentOnly: false, limit: 10 }),
    });
    return true;
  }

  const segmentMatch = p.match(/^\/api\/segments\/(\d+)$/);
  if (segmentMatch) {
    const id = Number(segmentMatch[1]);
    if (req.method === 'GET') {
      const segment = getSegment(id);
      if (!segment) {
        json(res, 404, { ok: false, error: 'not_found' });
        return true;
      }
      const filters = JSON.parse(segment.filters || '{}');
      json(res, 200, {
        ok: true,
        segment: { ...segment, filters },
        stats: audienceStats(filters),
        sample: audience(filters, { consentOnly: false, limit: 50 }),
      });
      return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const segment = updateSegment(id, body);
        if (!segment) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, segment });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      deleteSegment(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  const audienceMatch = p.match(/^\/api\/segments\/(\d+)\/audience\.csv$/);
  if (audienceMatch && req.method === 'GET') {
    const segment = getSegment(Number(audienceMatch[1]));
    if (!segment) {
      json(res, 404, { ok: false, error: 'not_found' });
      return true;
    }
    const filters = JSON.parse(segment.filters || '{}');
    const format = url.searchParams.get('format') || 'meta';
    // выгружаем без согласия только по явному требованию — ответственность на владельце базы
    const consentOnly = url.searchParams.get('all') !== '1';
    const rows = audience(filters, { consentOnly });
    const preview = format === 'preview';
    const body = preview ? audiencePreviewCsv(rows) : audienceCsv(rows, format);

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audience-${format}-${segment.id}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }

  /* ---------- воронка ---------- */

  if (p === '/api/stages' && req.method === 'GET') {
    let type = url.searchParams.get('type') || 'sales';
    if (user.role === 'hr') type = 'hr';
    else if (user.role !== 'admin') type = 'sales';

    const counts = Object.fromEntries(
      db.prepare('SELECT status, COUNT(*) AS c FROM leads WHERE type = ? GROUP BY status').all(type).map((r) => [r.status, r.c]),
    );
    json(res, 200, { ok: true, items: listStages(type).map((s) => ({ ...s, leads_count: counts[s.code] || 0 })) });
    return true;
  }

  if (p === '/api/stages' && req.method === 'POST') {
    if (!isAdmin) return denyNonAdmin();
    const body = await readInput(req);
    try {
      json(res, 201, { ok: true, stage: createStage(body) });
    } catch (e) {
      json(res, e.status || 500, { ok: false, message: e.message });
    }
    return true;
  }

  if (p === '/api/stages/reorder' && req.method === 'POST') {
    if (!isAdmin) return denyNonAdmin();
    const body = await readInput(req);
    json(res, 200, { ok: true, items: reorderStages(body.ids || []) });
    return true;
  }

  const stageMatch = p.match(/^\/api\/stages\/(\d+)$/);
  if (stageMatch) {
    if (!isAdmin) return denyNonAdmin();
    const id = Number(stageMatch[1]);
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const stage = updateStage(id, body);
        if (!stage) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, stage });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      try {
        const result = deleteStage(id, url.searchParams.get('move_to'));
        if (!result) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
  }

  /* ---------- дела ---------- */

  if (p === '/api/tasks' && req.method === 'GET') {
    json(res, 200, {
      ok: true,
      items: listTasks({
        scope: url.searchParams.get('scope'),
        filter: url.searchParams.get('filter'),
        leadId: url.searchParams.get('lead'),
        userId: user.id,
      }),
      counts: taskCounts(user.id),
    });
    return true;
  }

  if (p === '/api/tasks' && req.method === 'POST') {
    const body = await readInput(req);
    try {
      json(res, 201, { ok: true, task: createTask(body, user) });
    } catch (e) {
      json(res, e.status || 500, { ok: false, message: e.message });
    }
    return true;
  }

  const taskMatch = p.match(/^\/api\/tasks\/(\d+)$/);
  if (taskMatch) {
    const id = Number(taskMatch[1]);
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const task = updateTask(id, body, user);
        if (!task) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, task });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      deleteTask(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- компании ---------- */

  if (p === '/api/companies' && req.method === 'GET') {
    const q = clip(url.searchParams.get('q'), 80);
    const where = [];
    const args = [];
    if (q) {
      where.push('(c.name LIKE ? OR c.bin LIKE ? OR c.phone LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);

    const items = db
      .prepare(
        `SELECT c.*, u.name AS assigned_name,
                (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id) AS contacts_count,
                (SELECT COUNT(*) FROM leads l WHERE l.company_id = c.id) AS leads_count,
                (SELECT MAX(l.created_at) FROM leads l WHERE l.company_id = c.id) AS last_lead_at
           FROM companies c
           LEFT JOIN users u ON u.id = c.assigned_to
           ${sql}
          ORDER BY last_lead_at DESC, c.id DESC LIMIT ?`,
      )
      .all(...args, limit);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM companies c ${sql}`).get(...args).c;
    json(res, 200, { ok: true, items, total });
    return true;
  }

  if (p === '/api/companies' && req.method === 'POST') {
    const body = await readInput(req);
    try {
      const existing = findCompany({ name: body.name, bin: body.bin });
      if (existing) {
        json(res, 409, { ok: false, message: `Такая компания уже есть: ${existing.name}`, id: existing.id });
        return true;
      }
      json(res, 201, { ok: true, company: createCompany(body) });
    } catch (e) {
      json(res, e.status || 500, { ok: false, message: e.message });
    }
    return true;
  }

  const companyMatch = p.match(/^\/api\/companies\/(\d+)$/);
  if (companyMatch) {
    const id = Number(companyMatch[1]);
    if (req.method === 'GET') {
      const company = db
        .prepare('SELECT c.*, u.name AS assigned_name FROM companies c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.id = ?')
        .get(id);
      if (!company) {
        json(res, 404, { ok: false, error: 'not_found' });
        return true;
      }
      const contacts = db.prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY id').all(id);
      const leads = db
        .prepare(`SELECT ${LEAD_COLUMNS} ${LEAD_FROM} WHERE l.company_id = ? ORDER BY l.created_at DESC LIMIT 100`)
        .all(id);
      json(res, 200, { ok: true, company, contacts, leads });
      return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const company = updateCompany(id, body);
        if (!company) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, company });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!isAdmin) return denyNonAdmin();
      db.prepare('DELETE FROM companies WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- контакты ---------- */

  if (p === '/api/contacts' && req.method === 'GET') {
    const q = clip(url.searchParams.get('q'), 80);
    const companyId = url.searchParams.get('company');
    const where = [];
    const args = [];
    if (companyId) {
      where.push('ct.company_id = ?');
      args.push(Number(companyId));
    }
    if (q) {
      where.push('(ct.name LIKE ? OR ct.phone_norm LIKE ? OR ct.email LIKE ?)');
      args.push(`%${q}%`, `%${q.replace(/\D+/g, '')}%`, `%${q}%`);
    }
    const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const items = db
      .prepare(
        `SELECT ct.*, c.name AS company_name,
                (SELECT COUNT(*) FROM leads l WHERE l.contact_id = ct.id) AS leads_count
           FROM contacts ct LEFT JOIN companies c ON c.id = ct.company_id
           ${sql} ORDER BY ct.id DESC LIMIT 200`,
      )
      .all(...args);
    json(res, 200, { ok: true, items });
    return true;
  }

  if (p === '/api/contacts' && req.method === 'POST') {
    const body = await readInput(req);
    try {
      json(res, 201, { ok: true, contact: createContact(body) });
    } catch (e) {
      json(res, e.status || 500, { ok: false, message: e.message });
    }
    return true;
  }

  const contactMatch = p.match(/^\/api\/contacts\/(\d+)$/);
  if (contactMatch) {
    const id = Number(contactMatch[1]);
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      try {
        const contact = updateContact(id, body);
        if (!contact) {
          json(res, 404, { ok: false, error: 'not_found' });
          return true;
        }
        json(res, 200, { ok: true, contact });
      } catch (e) {
        json(res, e.status || 500, { ok: false, message: e.message });
      }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!isAdmin) return denyNonAdmin();
      db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  /* ---------- сотрудники ---------- */

  if (p === '/api/users' && req.method === 'GET') {
    const rows = db.prepare('SELECT id, email, name, role, active, created_at FROM users ORDER BY id').all();
    json(res, 200, { ok: true, items: rows });
    return true;
  }

  if (p === '/api/users' && req.method === 'POST') {
    if (!isAdmin && !isSenior) return denyNonAdmin();
    const body = await readInput(req);
    const email = clip(body.email, 160).toLowerCase();
    const name = clip(body.name, 120);
    const password = String(body.password || '');
    if (!isEmail(email) || !name || password.length < 8) {
      json(res, 400, { ok: false, message: 'Нужны корректный email, имя и пароль от 8 символов' });
      return true;
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      json(res, 409, { ok: false, message: 'Такой email уже есть' });
      return true;
    }
    
    let newRole = 'manager';
    if (isAdmin) {
      if (body.role === 'admin') newRole = 'admin';
      else if (body.role === 'senior') newRole = 'senior';
      else if (body.role === 'hr') newRole = 'hr';
    }
    
    const info = db
      .prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(email, name, hashPassword(password), newRole);
    json(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
    return true;
  }

  const userMatch = p.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    const id = Number(userMatch[1]);
    if (!isAdmin && id !== user.id) return denyNonAdmin();
    const body = await readInput(req);
    const sets = [];
    const args = [];
    if (body.name) { sets.push('name = ?'); args.push(clip(body.name, 120)); }
    if (body.password) {
      if (String(body.password).length < 8) {
        json(res, 400, { ok: false, message: 'Пароль от 8 символов' });
        return true;
      }
      sets.push('password_hash = ?');
      args.push(hashPassword(body.password));
    }
    if (isAdmin && 'active' in body) { sets.push('active = ?'); args.push(body.active ? 1 : 0); }
    if (isAdmin && body.role) {
      let r = 'manager';
      if (body.role === 'admin') r = 'admin';
      else if (body.role === 'senior') r = 'senior';
      else if (body.role === 'hr') r = 'hr';
      sets.push('role = ?');
      args.push(r);
    }
    if (!sets.length) {
      json(res, 400, { ok: false, message: 'Нечего менять' });
      return true;
    }
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    json(res, 200, { ok: true });
    return true;
  }

  /* ---------- сайты ---------- */

  if (p === '/api/sites' && req.method === 'GET') {
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM leads l WHERE l.site_id = s.id) AS leads_count
           FROM sites s ORDER BY s.id`,
      )
      .all();
    json(res, 200, { ok: true, items: rows });
    return true;
  }

  if (p === '/api/sites' && req.method === 'POST') {
    if (!isAdmin) return denyNonAdmin();
    const body = await readInput(req);
    const name = clip(body.name, 120);
    if (!name) {
      json(res, 400, { ok: false, message: 'Укажите название сайта' });
      return true;
    }
    const key = randomKey(24);
    const info = db
      .prepare('INSERT INTO sites (name, domains, public_key, auto_assign, sla_minutes, webhook_url) VALUES (?,?,?,?,?,?)')
      .run(
        name, clip(body.domains, 500), key,
        body.auto_assign === false ? 0 : 1,
        Number(body.sla_minutes) > 0 ? Number(body.sla_minutes) : 15,
        clip(body.webhook_url, 500),
      );
    json(res, 201, { ok: true, id: Number(info.lastInsertRowid), public_key: key });
    return true;
  }

  const siteMatch = p.match(/^\/api\/sites\/(\d+)(\/rotate)?$/);
  if (siteMatch) {
    if (!isAdmin) return denyNonAdmin();
    const id = Number(siteMatch[1]);
    if (siteMatch[2] && req.method === 'POST') {
      const key = randomKey(24);
      db.prepare('UPDATE sites SET public_key = ? WHERE id = ?').run(key, id);
      json(res, 200, { ok: true, public_key: key });
      return true;
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      const body = await readInput(req);
      const sets = [];
      const args = [];
      if (body.name != null) { sets.push('name = ?'); args.push(clip(body.name, 120)); }
      if (body.domains != null) { sets.push('domains = ?'); args.push(clip(body.domains, 500)); }
      if (body.webhook_url != null) { sets.push('webhook_url = ?'); args.push(clip(body.webhook_url, 500)); }
      if ('auto_assign' in body) { sets.push('auto_assign = ?'); args.push(body.auto_assign ? 1 : 0); }
      if ('active' in body) { sets.push('active = ?'); args.push(body.active ? 1 : 0); }
      if (body.sla_minutes != null && Number(body.sla_minutes) > 0) {
        sets.push('sla_minutes = ?');
        args.push(Number(body.sla_minutes));
      }
      if (!sets.length) {
        json(res, 400, { ok: false, message: 'Нечего менять' });
        return true;
      }
      db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}
