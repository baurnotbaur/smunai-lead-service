import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { randomKey } from './util.js';

const SESSION_COOKIE = 'ld_sid';
const SESSION_DAYS = 14;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createSession(db, userId) {
  const id = randomKey(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    id,
    userId,
    expires.toISOString().replace('T', ' ').slice(0, 19),
  );
  return { id, expires };
}

export function sessionCookie(id, expires) {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expires.toUTCString()}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Возвращает пользователя по сессионной куке или null. Просроченные сессии чистит. */
export function currentUser(db, req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sid);
  if (!row) return null;
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z') < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return null;
  }
  if (!row.active) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, sid };
}

export function destroySession(db, sid) {
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

export function purgeExpiredSessions(db) {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}
