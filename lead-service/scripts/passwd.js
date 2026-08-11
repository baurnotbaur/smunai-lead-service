/**
 * Смена пароля сотрудника прямо в базе — на случай, когда в панель уже не войти.
 *
 *   npm run passwd                          показать, какие учётки есть
 *   npm run passwd -- почта новый-пароль    задать пароль (заводит учётку, если её нет)
 *
 * Работает с той базой, что настроена в окружении: локальный файл по умолчанию,
 * либо Turso, если заданы TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.
 */

import { db, dbError } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword } from '../src/auth.js';

const MIN_LENGTH = 8;

if (dbError) {
  console.error(`База недоступна: ${dbError.message || dbError}`);
  process.exit(1);
}

console.log(`База: ${config.tursoUrl ? `Turso ${config.tursoUrl}` : config.dbPath}\n`);

const [email, password] = process.argv.slice(2);

if (!email) {
  const users = db.prepare('SELECT id, email, name, role, active FROM users ORDER BY id').all();
  if (!users.length) {
    console.log('Учётных записей нет — они создаются при первом запуске сервиса.');
  } else {
    console.log('Учётные записи:');
    for (const u of users) {
      const marks = [u.role === 'admin' ? 'администратор' : 'менеджер', u.active ? null : 'отключён']
        .filter(Boolean)
        .join(', ');
      console.log(`  ${String(u.id).padStart(3)}  ${u.email.padEnd(32)} ${u.name} (${marks})`);
    }
  }
  console.log('\nСменить пароль:  npm run passwd -- почта новый-пароль');
  process.exit(0);
}

if (!password) {
  console.error('Укажите новый пароль:  npm run passwd -- почта новый-пароль');
  process.exit(1);
}

if (password.length < MIN_LENGTH) {
  console.error(`Пароль короче ${MIN_LENGTH} символов — так нельзя.`);
  process.exit(1);
}

const login = email.trim().toLowerCase();
const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(login);

if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, active = 1 WHERE id = ?").run(hashPassword(password), existing.id);
  // старые сессии закрываем: иначе тот, кто уже вошёл, останется внутри
  const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Пароль изменён: ${login} (${existing.name}).`);
  if (changes) console.log(`Закрыто активных сессий: ${changes}.`);
} else {
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    login,
    'Администратор',
    hashPassword(password),
    'admin',
  );
  console.log(`Учётки не было — создана новая: ${login}, роль администратора.`);
}

db.close();
