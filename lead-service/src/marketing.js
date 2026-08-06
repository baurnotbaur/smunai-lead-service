import { createHash } from 'node:crypto';
import { db } from './db.js';
import { clip } from './util.js';
import { listStages } from './stages.js';

/* ---------- сегменты ---------- */

export const listSegments = () =>
  db
    .prepare(
      `SELECT s.*, u.name AS author
         FROM segments s LEFT JOIN users u ON u.id = s.created_by
        ORDER BY s.id DESC`,
    )
    .all();

export const getSegment = (id) => db.prepare('SELECT * FROM segments WHERE id = ?').get(id) || null;

export function createSegment(input, user) {
  const name = clip(input.name, 120);
  if (!name) throw Object.assign(new Error('Назовите сегмент'), { status: 400 });
  const info = db
    .prepare('INSERT INTO segments (name, filters, created_by) VALUES (?,?,?)')
    .run(name, JSON.stringify(normalizeFilters(input.filters)), user.id);
  return getSegment(Number(info.lastInsertRowid));
}

export function updateSegment(id, patch) {
  const segment = getSegment(id);
  if (!segment) return null;
  const name = patch.name != null ? clip(patch.name, 120) : segment.name;
  if (!name) throw Object.assign(new Error('Название не может быть пустым'), { status: 400 });
  const filters = patch.filters != null ? JSON.stringify(normalizeFilters(patch.filters)) : segment.filters;
  db.prepare('UPDATE segments SET name = ?, filters = ? WHERE id = ?').run(name, filters, id);
  return getSegment(id);
}

export const deleteSegment = (id) => db.prepare('DELETE FROM segments WHERE id = ?').run(id);

/** Оставляем только понятные условия — в базу не должен попасть произвольный JSON. */
function normalizeFilters(raw) {
  const input = typeof raw === 'object' && raw ? raw : {};
  const known = new Set(listStages().map((s) => s.code));
  const out = {};

  const stages = String(input.stages || '').split(',').map((s) => s.trim()).filter((s) => known.has(s));
  if (stages.length) out.stages = stages.join(',');

  if (input.site) out.site = Number(input.site) || undefined;
  if (input.assigned) out.assigned = Number(input.assigned) || undefined;

  const days = Number(input.days_ago);
  if (Number.isFinite(days) && days > 0) out.days_ago = Math.min(days, 3650);

  const olderThan = Number(input.older_than_days);
  if (Number.isFinite(olderThan) && olderThan > 0) out.older_than_days = Math.min(olderThan, 3650);

  if (input.has_company) out.has_company = 1;
  if (input.q) out.q = clip(input.q, 80);

  return out;
}

/**
 * Условия сегмента -> SQL по таблице контактов.
 * Контакт попадает в выборку, если у него есть подходящая заявка.
 */
function buildAudienceQuery(filters, { consentOnly }) {
  const where = ["(ct.phone_norm != '' OR ct.email != '')"];
  const args = [];

  if (consentOnly) where.push('ct.marketing_consent = 1');
  where.push('ct.unsubscribed = 0');

  const leadWhere = [];
  const leadArgs = [];

  if (filters.stages) {
    const codes = filters.stages.split(',');
    leadWhere.push(`l.status IN (${codes.map(() => '?').join(',')})`);
    leadArgs.push(...codes);
  }
  if (filters.site) {
    leadWhere.push('l.site_id = ?');
    leadArgs.push(filters.site);
  }
  if (filters.assigned) {
    leadWhere.push('l.assigned_to = ?');
    leadArgs.push(filters.assigned);
  }
  if (filters.days_ago) {
    leadWhere.push("l.created_at > datetime('now', ?)");
    leadArgs.push(`-${filters.days_ago} days`);
  }
  if (filters.older_than_days) {
    leadWhere.push("l.created_at < datetime('now', ?)");
    leadArgs.push(`-${filters.older_than_days} days`);
  }

  if (leadWhere.length) {
    where.push(`EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = ct.id AND ${leadWhere.join(' AND ')})`);
    args.push(...leadArgs);
  }
  if (filters.has_company) where.push('ct.company_id IS NOT NULL');
  if (filters.q) {
    where.push('(ct.name LIKE ? OR c.name LIKE ?)');
    args.push(`%${filters.q}%`, `%${filters.q}%`);
  }

  return {
    sql: `FROM contacts ct LEFT JOIN companies c ON c.id = ct.company_id WHERE ${where.join(' AND ')}`,
    args,
  };
}

/** Кто попадёт в рассылку/аудиторию. */
export function audience(filters, { consentOnly = true, limit = 5000 } = {}) {
  const { sql, args } = buildAudienceQuery(filters, { consentOnly });
  return db
    .prepare(
      `SELECT ct.id, ct.name, ct.phone, ct.phone_norm, ct.email,
              ct.marketing_consent, ct.unsubscribed, c.name AS company_name
       ${sql} ORDER BY ct.id DESC LIMIT ?`,
    )
    .all(...args, limit);
}

/** Размер сегмента: сколько всего и сколько из них дали согласие. */
export function audienceStats(filters) {
  const all = buildAudienceQuery(filters, { consentOnly: false });
  const consented = buildAudienceQuery(filters, { consentOnly: true });
  return {
    total: db.prepare(`SELECT COUNT(*) AS c ${all.sql}`).get(...all.args).c,
    consented: db.prepare(`SELECT COUNT(*) AS c ${consented.sql}`).get(...consented.args).c,
    withPhone: db.prepare(`SELECT COUNT(*) AS c ${consented.sql} AND ct.phone_norm != ''`).get(...consented.args).c,
    withEmail: db.prepare(`SELECT COUNT(*) AS c ${consented.sql} AND ct.email != ''`).get(...consented.args).c,
  };
}

/* ---------- выгрузка рекламных аудиторий ---------- */

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * Meta и TikTok принимают только хеши: телефон в E.164 без «+», почта в нижнем регистре.
 * Хешируем сами — сырые номера клиентов наружу не уходят.
 */
export function audienceCsv(rows, format = 'meta') {
  const isTikTok = format === 'tiktok';
  const head = isTikTok ? ['phone', 'email'] : ['phone', 'email'];
  const lines = [head.join(',')];

  for (const r of rows) {
    const phone = r.phone_norm ? sha256(r.phone_norm) : '';
    const email = r.email ? sha256(r.email.trim().toLowerCase()) : '';
    if (!phone && !email) continue;
    lines.push([phone, email].join(','));
  }
  return lines.join('\r\n');
}

/** Для проверки перед загрузкой: тот же список, но без хешей. */
export function audiencePreviewCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Имя;Компания;Телефон;Email;Согласие'];
  for (const r of rows) {
    lines.push([r.name, r.company_name, r.phone, r.email, r.marketing_consent ? 'да' : 'нет'].map(esc).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}
