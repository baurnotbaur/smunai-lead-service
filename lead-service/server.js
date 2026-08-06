import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './src/config.js';
import { db } from './src/db.js';
import { purgeExpiredSessions } from './src/auth.js';
import { closeAll } from './src/events.js';
import { send, serveStatic } from './src/http.js';
import { handlePublic } from './src/routes/public.js';
import { handleApi } from './src/routes/api.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (await handlePublic(req, res, url)) return;
    if (await handleApi(req, res, url)) return;

    // embed.js должен грузиться с любого домена
    if (url.pathname === '/embed.js') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (serveStatic(res, PUBLIC_DIR, url.pathname)) return;

    // SPA: любой неизвестный путь отдаёт панель
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (serveStatic(res, PUBLIC_DIR, '/index.html')) return;
    }

    send(res, 404, 'Not found');
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err);
    if (!res.headersSent) send(res, err.status || 500, JSON.stringify({ ok: false, error: 'server_error' }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
  }
});

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
