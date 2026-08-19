/**
 * Настройки, которые правит отдел продаж из панели, а не разработчик в .env.
 * Главная из них — база знаний бота: он отвечает клиентам только по ней.
 */

import { db } from './db.js';

/**
 * Заготовка базы знаний. Намеренно пустая по фактам: цены и адреса выдумывать нельзя,
 * а пока их здесь нет, бот на такие вопросы честно зовёт менеджера.
 */
export const KNOWLEDGE_TEMPLATE = `# О компании
С-Мұнай — семейная сеть автозаправочных станций. Работает с 1996 года.
Восемь станций: Жезказган, Сатпаев, Астана.

# Адреса и режим работы
(заполните: город, улица, часы работы каждой станции)

# Топливо и цены
(заполните: какие виды топлива, актуальные цены или где их смотреть)

# Топливные карты для юрлиц
(заполните: условия, как заключить договор, какие документы нужны)

# Оплата
(заполните: наличные, карты, безналичный расчёт)

# Чего не пишем клиентам
Не обещаем скидок и индивидуальных условий — это решает менеджер.`;

const DEFAULTS = {
  bot_knowledge: KNOWLEDGE_TEMPLATE,
  // как бот представляется; пустая строка — здоровается своими словами
  bot_greeting: '',
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? '');
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, String(value ?? ''));
}

export const allSettings = () => ({
  bot_knowledge: getSetting('bot_knowledge'),
  bot_greeting: getSetting('bot_greeting'),
});

/** Заполнена ли база знаний по-настоящему или там всё ещё заготовка со скобками. */
export function knowledgeLooksUnfilled() {
  const text = getSetting('bot_knowledge');
  return !text.trim() || text.includes('(заполните');
}
