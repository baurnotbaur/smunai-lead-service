/** Удаляет базу целиком — при следующем запуске она создастся заново. */
import { rmSync, existsSync } from 'node:fs';
import { config } from '../src/config.js';

for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbPath + suffix;
  if (existsSync(file)) {
    rmSync(file);
    console.log('удалено:', file);
  }
}
console.log('Готово. Запустите `npm start` — база и администратор создадутся заново.');
