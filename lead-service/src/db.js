import Database from 'libsql';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { hashPassword } from './auth.js';
import { randomKey } from './util.js';

/**
 * Подключение: сетевая база Turso, если задан её адрес, иначе локальный файл.
 * Диалект SQL один и тот же, поэтому запросы ниже не различают эти случаи.
 */
function connect() {
  if (config.tursoUrl) return new Database(config.tursoUrl, { authToken: config.tursoToken });
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return new Database(config.dbPath);
}

/**
 * Причина, по которой база недоступна, или null. Раньше падение здесь роняло
 * всю функцию с безымянной ошибкой — снаружи было не понять, что случилось.
 * Теперь сервис поднимается и честно отвечает, что именно сломалось.
 */
export let dbError = null;

let connection = null;
try {
  connection = connect();
} catch (err) {
  dbError = err;
  console.error('[db] не удалось подключиться:', err?.message || err);
}

/** Драйвер кладёт в каждую строку служебное поле — в ответы API ему попадать незачем. */
function clean(row) {
  if (row) delete row._metadata;
  return row;
}

// Обёртка оставляет привычные prepare/exec и снимает служебное поле,
// чтобы остальной код ничего не знал об особенностях драйвера.
function alive() {
  if (!connection) throw Object.assign(new Error('База недоступна'), { status: 503 });
  return connection;
}

export const db = {
  prepare(sql) {
    const stmt = alive().prepare(sql);
    return {
      get: (...args) => clean(stmt.get(...args)),
      all: (...args) => stmt.all(...args).map(clean),
      run: (...args) => stmt.run(...args),
    };
  },
  exec: (sql) => alive().exec(sql),
  close: () => connection?.close(),
};

// PRAGMA настраивают локальный файл; у сетевой базы этим занимается сервер
if (connection && !config.tursoUrl) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

/** Создаёт схему и первичные записи. Отделено, чтобы поймать отказ сетевой базы. */
function initSchema() {
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

CREATE TABLE IF NOT EXISTS password_resets (
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

-- Клиент-организация: ТОО, ИП, таксопарк. К ней привязываются заявки и контакты.
CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL DEFAULT '',            -- имя без «ТОО»/кавычек: склейка дублей
  bin         TEXT NOT NULL DEFAULT '',            -- БИН / ИИН
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_companies_norm ON companies(name_norm);
CREATE INDEX IF NOT EXISTS idx_companies_bin  ON companies(bin);

-- Контактное лицо: директор, бухгалтер, логист. Узнаётся по телефону.
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  phone_norm TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  position   TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  -- согласие на рекламу: без него рассылка и выгрузка в рекламные кабинеты незаконны
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  consent_at        TEXT,
  consent_source    TEXT NOT NULL DEFAULT '',
  unsubscribed      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Сегмент: сохранённая выборка клиентов для рассылки или рекламной аудитории.
CREATE TABLE IF NOT EXISTS segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  filters    TEXT NOT NULL DEFAULT '{}',        -- JSON: те же условия, что в списке заявок
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_phone   ON contacts(phone_norm);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- Стадия воронки. leads.status хранит code — этапы можно менять под свой процесс.
CREATE TABLE IF NOT EXISTS stages (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,
  title  TEXT NOT NULL,
  kind   TEXT NOT NULL DEFAULT 'open',        -- open | won | lost: смысл для аналитики
  color  TEXT NOT NULL DEFAULT 'new',         -- палитра пилюли: new|in_work|callback|won|lost
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_stages_sort ON stages(sort);

-- Дело: «перезвонить», «отправить КП». Держит менеджера в графике.
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'call',        -- call | meeting | email | other
  due_at      TEXT NOT NULL,                       -- срок, локальное время в формате БД
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(done, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, done);
CREATE INDEX IF NOT EXISTS idx_tasks_lead     ON tasks(lead_id);

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

-- Переписка из WhatsApp и Instagram. Заявка здесь играет роль диалога:
-- все сообщения одного клиента в одном канале висят на ней.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,                        -- whatsapp | instagram
  direction   TEXT NOT NULL,                        -- in | out
  kind        TEXT NOT NULL DEFAULT 'text',         -- text | image | audio | video | other
  text        TEXT NOT NULL DEFAULT '',
  -- идентификатор сообщения у Meta: она повторяет доставку, пока не получит 200
  external_id TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Настройки, которые меняются из панели, а не через .env: текст базы знаний бота и прочее.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external ON messages(external_id) WHERE external_id <> '';
`);

  // --- миграции ---------------------------------------------------------------

  /** Добавляет колонку, если её ещё нет: база могла создаваться прошлой версией. */
  function addColumn(table, column, definition) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  addColumn('leads', 'company_id', 'INTEGER REFERENCES companies(id) ON DELETE SET NULL');
  addColumn('leads', 'contact_id', 'INTEGER REFERENCES contacts(id) ON DELETE SET NULL');

  // откуда пришла заявка: форма на сайте или переписка в мессенджере
  addColumn('leads', 'channel', "TEXT NOT NULL DEFAULT 'site'");
  // кто написал: wa_id в WhatsApp, id отправителя в Instagram — по нему узнаём вернувшегося
  addColumn('leads', 'external_id', "TEXT NOT NULL DEFAULT ''");
  addColumn('leads', 'last_message_at', 'TEXT');
  // разговор передан живому менеджеру — бот в него больше не вмешивается
  addColumn('leads', 'bot_off', 'INTEGER NOT NULL DEFAULT 0');

  addColumn('contacts', 'marketing_consent', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('contacts', 'consent_at', 'TEXT');
  addColumn('contacts', 'consent_source', "TEXT NOT NULL DEFAULT ''");
  addColumn('contacts', 'unsubscribed', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id);
  CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_id);
  CREATE INDEX IF NOT EXISTS idx_leads_channel  ON leads(channel);
  CREATE INDEX IF NOT EXISTS idx_leads_external ON leads(channel, external_id);
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

  // стартовая воронка повторяет прежние статусы — старые заявки остаются валидными
  const stageCount = db.prepare('SELECT COUNT(*) AS c FROM stages').get().c;
  if (stageCount === 0) {
    const insert = db.prepare('INSERT INTO stages (code, title, kind, color, sort) VALUES (?,?,?,?,?)');
    [
      ['new', 'Новая', 'open', 'new'],
      ['in_work', 'В работе', 'open', 'in_work'],
      ['callback', 'Перезвонить', 'open', 'callback'],
      ['won', 'Успех', 'won', 'won'],
      ['lost', 'Отказ', 'lost', 'lost'],
    ].forEach(([code, title, kind, color], i) => insert.run(code, title, kind, color, (i + 1) * 10));
  }

  const siteCount = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  if (siteCount === 0) {
    const key = randomKey(24);
    db.prepare('INSERT INTO sites (name, domains, public_key) VALUES (?, ?, ?)').run('Мой сайт', '', key);
    console.log(`[init] создан сайт «Мой сайт», ключ: ${key}`);
  }
}

if (connection) {
  try {
    initSchema();
  } catch (err) {
    dbError = err;
    console.error('[db] схема не создана:', err?.message || err);
  }
}
