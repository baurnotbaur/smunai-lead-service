import http from 'node:http';
import { config } from './src/config.js';
import { db } from './src/db.js';
import { purgeExpiredSessions } from './src/auth.js';
import { closeAll } from './src/events.js';
import { handleRequest } from './src/app.js';

const server = http.createServer(handleRequest);

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 6 * 3600 * 1000).unref();

server.listen(config.port, () => {
  console.log(`\n  Сервис заявок запущен`);
  console.log(`  Панель:   ${config.publicUrl}`);
  console.log(`  Приём:    POST ${config.publicUrl}/api/v1/leads`);
  console.log(`  Виджет:   ${config.publicUrl}/embed.js?key=...\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    closeAll();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
