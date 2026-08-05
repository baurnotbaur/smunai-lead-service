import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { randomKey } from './util.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'manager',   -- admin | manager
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Подключённый сайт: источник заявок. Ключ вставляется в сниппет на сайте.
CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  domains     TEXT NOT NULL DEFAULT '',            -- список доменов через запятую, пусто = любой
  public_key  TEXT NOT NULL UNIQUE,
  auto_assign INTEGER NOT NULL DEFAULT 1,          -- round-robin по активным менеджерам
  sla_minutes INTEGER NOT NULL DEFAULT 15,         -- дедлайн первого контакта
  webhook_url TEXT NOT NULL DEFAULT '',            -- необязательный внешний вебхук
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  name          TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  phone_norm    TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  comment       TEXT NOT NULL DEFAULT '',
  extra         TEXT NOT NULL DEFAULT '{}',        -- прочие поля формы, JSON
  status        TEXT NOT NULL DEFAULT 'new',       -- new | in_work | callback | won | lost
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount        REAL,
  lost_reason   TEXT NOT NULL DEFAULT '',
  form_id       TEXT NOT NULL DEFAULT '',
  page_url      TEXT NOT NULL DEFAULT '',
  referrer      TEXT NOT NULL DEFAULT '',
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  utm_content   TEXT NOT NULL DEFAULT '',
  utm_term      TEXT NOT NULL DEFAULT '',
  ip            TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  is_duplicate  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  first_touch_at TEXT,                             -- когда менеджер впервые взял в работу
  closed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_phone    ON leads(phone_norm);

-- История: смены статуса, назначения, комментарии
CREATE TABLE IF NOT EXISTS lead_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  type       TEXT NOT NULL,                        -- created | status | assign | comment | field
  text       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id, id);
`);

// --- первичное наполнение ---------------------------------------------------

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    config.adminEmail.toLowerCase(),
    'Администратор',
    hashPassword(config.adminPassword),
    'admin',
  );
  console.log(`[init] создан администратор: ${config.adminEmail} / ${config.adminPassword}`);
}

const siteCount = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
if (siteCount === 0) {
  const key = randomKey(24);
  db.prepare('INSERT INTO sites (name, domains, public_key) VALUES (?, ?, ?)').run('Мой сайт', '', key);
  console.log(`[init] создан сайт «Мой сайт», ключ: ${key}`);
}
