import { db } from './db.js';
import { clip, normalizePhone, isEmail } from './util.js';
import { stageByCode, stageTitles, startCode } from './stages.js';
import { notifyNewLead } from './notify.js';
import { broadcast } from './events.js';
import { linkLeadParties } from './crm.js';

const DUPLICATE_WINDOW_MIN = 30;

/** Следующий ответственный по кругу: у кого меньше всего заявок за сутки. */
function pickManager() {
  return db
    .prepare(
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM leads l
                WHERE l.assigned_to = u.id AND l.created_at > datetime('now','-1 day')) AS load
         FROM users u
        WHERE u.active = 1
        ORDER BY load ASC, u.id ASC
        LIMIT 1`,
    )
    .get();
}

export function findSiteByKey(key) {
  if (!key) return null;
  return db.prepare('SELECT * FROM sites WHERE public_key = ? AND active = 1').get(String(key)) || null;
}

/** Origin запроса разрешён для сайта? Пустой список доменов = разрешено всё. */
export function originAllowed(site, origin) {
  if (!site.domains.trim()) return true;
  if (!origin) return true; // серверные интеграции без Origin
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return site.domains
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)
    .some((d) => host === d || host.endsWith('.' + d));
}

const KNOWN_FIELDS = new Set([
  'key', 'site_key', 'name', 'phone', 'email', 'comment', 'message', 'form_id', 'form',
  'page_url', 'url', 'referrer', 'ref', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'utm', '_hp', 'consent',
  'company', 'org', 'organization', 'bin', 'iin',
]);

/**
 * Принимает сырые данные формы, валидирует и сохраняет заявку.
 * @returns {{ok: true, lead: object} | {ok: false, error: string, message: string}}
 */
export function createLead(input, meta) {
  const site = meta.site;
  const name = clip(input.name, 120);
  const phoneRaw = clip(input.phone, 40);
  const email = clip(input.email, 160).toLowerCase();
  const comment = clip(input.comment ?? input.message, 2000);
  const phoneNorm = normalizePhone(phoneRaw);

  if (!phoneNorm && !email) {
    return { ok: false, error: 'contact_required', message: 'Укажите телефон или email' };
  }
  if (phoneNorm && phoneNorm.length < 10) {
    return { ok: false, error: 'bad_phone', message: 'Проверьте номер телефона' };
  }
  if (email && !isEmail(email)) {
    return { ok: false, error: 'bad_email', message: 'Проверьте адрес электронной почты' };
  }

  // всё, что не входит в стандартный набор — складываем в extra
  const utm = typeof input.utm === 'object' && input.utm ? input.utm : {};
  const extra = {};
  for (const [k, v] of Object.entries(input)) {
    if (KNOWN_FIELDS.has(k) || v === '' || v == null) continue;
    if (typeof v === 'object') continue;
    extra[clip(k, 40)] = clip(v, 500);
  }

  const dupe = phoneNorm
    ? db
        .prepare(
          `SELECT id FROM leads
            WHERE phone_norm = ? AND created_at > datetime('now', ?)
            ORDER BY id DESC LIMIT 1`,
        )
        .get(phoneNorm, `-${DUPLICATE_WINDOW_MIN} minutes`)
    : null;

  const manager = site?.auto_assign ? pickManager() : null;

  // узнаём клиента: тот же телефон — тот же контакт, та же организация — та же компания
  const { companyId, contactId } = linkLeadParties({
    name,
    phone: phoneRaw,
    email,
    company: input.company ?? input.org ?? input.organization,
    bin: input.bin ?? input.iin,
  });

  const info = db
    .prepare(
      `INSERT INTO leads (
         site_id, name, phone, phone_norm, email, comment, extra, assigned_to,
         company_id, contact_id, status,
         form_id, page_url, referrer,
         utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         ip, user_agent, is_duplicate
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      site?.id ?? null,
      name,
      phoneRaw,
      phoneNorm,
      email,
      comment,
      JSON.stringify(extra),
      manager?.id ?? null,
      companyId,
      contactId,
      startCode(),
      clip(input.form_id ?? input.form, 60),
      clip(input.page_url ?? input.url, 500),
      clip(input.referrer ?? input.ref, 500),
      clip(input.utm_source ?? utm.source, 120),
      clip(input.utm_medium ?? utm.medium, 120),
      clip(input.utm_campaign ?? utm.campaign, 120),
      clip(input.utm_content ?? utm.content, 120),
      clip(input.utm_term ?? utm.term, 120),
      clip(meta.ip, 60),
      clip(meta.userAgent, 300),
      dupe ? 1 : 0,
    );

  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO lead_events (lead_id, type, text) VALUES (?, ?, ?)').run(
    id,
    'created',
    `Заявка с сайта${site ? ' «' + site.name + '»' : ''}`,
  );
  if (manager) {
    db.prepare('INSERT INTO lead_events (lead_id, type, text) VALUES (?, ?, ?)').run(
      id,
      'assign',
      `Автоназначение: ${manager.name}`,
    );
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  notifyNewLead(lead, site, manager);
  broadcast('lead:new', {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    site: site?.name || '',
    is_duplicate: lead.is_duplicate,
  });
  return { ok: true, lead };
}

/** Смена статуса/ответственного/суммы с записью в историю. */
export function updateLead(id, patch, user) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) return null;

  const sets = [];
  const vals = [];
  const events = [];

  if (patch.status && patch.status !== lead.status) {
    const stage = stageByCode(patch.status);
    if (!stage) throw Object.assign(new Error('bad_status'), { status: 400 });
    const titles = stageTitles();
    sets.push('status = ?');
    vals.push(stage.code);
    events.push(['status', `Стадия: ${titles[lead.status] || lead.status} → ${stage.title}`]);

    // уход с первой стадии = менеджер взял заявку в работу
    if (!lead.first_touch_at && stage.code !== startCode()) {
      sets.push("first_touch_at = datetime('now')");
    }
    if (stage.kind === 'won' || stage.kind === 'lost') {
      sets.push("closed_at = datetime('now')");
    } else {
      sets.push('closed_at = NULL');
    }
  }

  if ('assigned_to' in patch) {
    const next = patch.assigned_to ? Number(patch.assigned_to) : null;
    if (next !== lead.assigned_to) {
      const target = next ? db.prepare('SELECT name FROM users WHERE id = ?').get(next) : null;
      if (next && !target) throw Object.assign(new Error('bad_user'), { status: 400 });
      sets.push('assigned_to = ?');
      vals.push(next);
      events.push(['assign', target ? `Ответственный: ${target.name}` : 'Ответственный снят']);
    }
  }

  if ('amount' in patch) {
    const amount = patch.amount === '' || patch.amount == null ? null : Number(patch.amount);
    if (amount !== null && !Number.isFinite(amount)) throw Object.assign(new Error('bad_amount'), { status: 400 });
    if (amount !== lead.amount) {
      sets.push('amount = ?');
      vals.push(amount);
      events.push(['field', amount == null ? 'Сумма очищена' : `Сумма сделки: ${amount}`]);
    }
  }

  if ('lost_reason' in patch) {
    sets.push('lost_reason = ?');
    vals.push(clip(patch.lost_reason, 300));
  }

  if ('company_id' in patch) {
    const next = patch.company_id ? Number(patch.company_id) : null;
    if (next !== lead.company_id) {
      const target = next ? db.prepare('SELECT name FROM companies WHERE id = ?').get(next) : null;
      if (next && !target) throw Object.assign(new Error('bad_company'), { status: 400 });
      sets.push('company_id = ?');
      vals.push(next);
      events.push(['field', target ? `Компания: ${target.name}` : 'Компания отвязана']);
    }
  }

  if ('contact_id' in patch) {
    const next = patch.contact_id ? Number(patch.contact_id) : null;
    if (next !== lead.contact_id) {
      const target = next ? db.prepare('SELECT name, phone FROM contacts WHERE id = ?').get(next) : null;
      if (next && !target) throw Object.assign(new Error('bad_contact'), { status: 400 });
      sets.push('contact_id = ?');
      vals.push(next);
      events.push(['field', target ? `Контакт: ${target.name || target.phone}` : 'Контакт отвязан']);
    }
  }

  if (!sets.length) return lead;

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

  const stmt = db.prepare('INSERT INTO lead_events (lead_id, user_id, type, text) VALUES (?, ?, ?, ?)');
  for (const [type, text] of events) stmt.run(id, user.id, type, text);

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  broadcast('lead:update', { id, status: updated.status, by: user.id });
  return updated;
}
