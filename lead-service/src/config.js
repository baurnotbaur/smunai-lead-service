import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const bool = (v, def = false) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  port: Number(process.env.PORT || 4000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@local',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin12345',
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/leads.db'),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  secureCookies: bool(process.env.SECURE_COOKIES, false),
};

if (config.sessionSecret === 'insecure-dev-secret-change-me') {
  console.warn('[warn] SESSION_SECRET не задан — используется дефолтный. Для прода задайте свой в .env');
}
