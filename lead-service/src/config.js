import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomKey } from './util.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Читает .env. Две вещи, которых не делает встроенный loadEnvFile:
 * снимает BOM (иначе первая переменная в файле теряется — Windows дописывает его
 * при сохранении) и не затирает то, что уже задано в окружении, — иначе пустое
 * значение из файла перебивало бы переменную, переданную в командной строке.
 */
function loadEnv(file) {
  for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq < 0) continue;

    const key = text.slice(0, eq).trim();
    if (!key || key in process.env) continue;

    const value = text.slice(eq + 1).trim();
    const quoted = value.length > 1 && (value.startsWith('"') || value.startsWith("'")) && value.at(-1) === value[0];
    process.env[key] = quoted ? value.slice(1, -1) : value;
  }
}

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) loadEnv(envFile);

const bool = (v, def = false) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v)));

// На Vercel сервис живёт в функции: диск только для чтения, писать можно лишь в /tmp,
// и каждый холодный старт поднимает чистый экземпляр.
const serverless = Boolean(process.env.VERCEL);
const defaultDb = serverless ? '/tmp/leads.db' : './data/leads.db';

// Turso — та же SQLite, только по сети. Задан адрес — работаем с ней, иначе с локальным файлом.
const tursoUrl = process.env.TURSO_DATABASE_URL || '';

export const config = {
  serverless,
  tursoUrl,
  tursoToken: process.env.TURSO_AUTH_TOKEN || '',
  // база во временной папке: переживает тёплые запросы, но не холодный старт
  ephemeralDb: serverless && !tursoUrl && !process.env.DB_PATH,
  port: Number(process.env.PORT || 4000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@local',
  // В проде без явного ADMIN_PASSWORD не заводим известный дефолт: генерируем
  // случайный (виден один раз в логе старта). Локально оставляем удобный дефолт.
  adminPassword: process.env.ADMIN_PASSWORD || (serverless ? randomKey(18) : 'admin12345'),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || defaultDb),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  // в проде (Vercel = HTTPS) кука сессии обязана быть Secure; локально по HTTP — нет
  secureCookies: bool(process.env.SECURE_COOKIES, serverless),

  // WhatsApp и Instagram: оба канала идут через Meta и один общий вебхук
  meta: {
    // строка, которую Meta пришлёт при подключении вебхука — придумывается произвольно
    verifyToken: process.env.META_VERIFY_TOKEN || '',
    // секрет приложения: им подписан каждый запрос, без проверки подписи вебхук открыт всему миру
    appSecret: process.env.META_APP_SECRET || '',
    graphVersion: process.env.META_GRAPH_VERSION || 'v21.0',
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN || '',
      phoneId: process.env.WHATSAPP_PHONE_ID || '',
    },
    instagram: {
      token: process.env.INSTAGRAM_TOKEN || '',
    },
  },
  // автоответ в переписке: выключается, когда с клиентами говорят только руками
  botEnabled: bool(process.env.BOT_ENABLED, true),

  // Gemini отвечает клиентам по базе знаний из панели. Без ключа бот остаётся
  // сценарным: здоровается, просит телефон и зовёт менеджера.
  ai: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // lite-модель отвечает за секунду-две вместо пятнадцати у старших, а на
    // коротком ответе по готовой базе знаний разницы в качестве не видно
    model: process.env.BOT_MODEL || 'gemini-3.5-flash-lite',
    // нестандартный адрес API — нужен, если запросы идут через прокси
    baseUrl: process.env.GEMINI_BASE_URL || '',
    // сколько ждём модель, прежде чем ответить клиенту сценарной фразой:
    // Meta повторяет доставку вебхука, если ответ долго не приходит
    timeoutMs: Number(process.env.BOT_TIMEOUT_MS || 12000),
  },
};

if (config.sessionSecret === 'insecure-dev-secret-change-me') {
  console.warn('[warn] SESSION_SECRET не задан — используется дефолтный. Для прода задайте свой в .env');
}

if (serverless && !process.env.ADMIN_PASSWORD) {
  console.warn(
    '[warn] ADMIN_PASSWORD не задан в проде — пароль администратора случайный и виден только в этом логе. ' +
      'Задайте ADMIN_EMAIL/ADMIN_PASSWORD в переменных окружения и подключите Turso, ' +
      'иначе администратор пересоздаётся при каждом холодном старте.',
  );
}

if (config.ephemeralDb) {
  console.warn(
    '[warn] База лежит в /tmp и стирается при холодном старте: заявки будут теряться. ' +
      'Для рабочего сервиса задайте TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.',
  );
}

if (config.tursoUrl && !config.tursoToken) {
  console.warn('[warn] TURSO_DATABASE_URL задан без TURSO_AUTH_TOKEN — база не пустит без токена');
}
