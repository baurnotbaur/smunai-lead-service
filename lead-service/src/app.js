/**
 * Обработчик запроса — общий для локального сервера и для функции на Vercel.
 * Держим его отдельно от server.js, потому что в функции нет своего http-сервера:
 * платформа сама принимает соединение и передаёт сюда req/res.
 */

import path from 'node:path';
import { ROOT } from './config.js';
import { send, serveStatic } from './http.js';
import { handlePublic } from './routes/public.js';
import { handleMeta } from './routes/meta.js';
import { handleApi } from './routes/api.js';

// не «public»: папку с таким именем Vercel принимает за готовую статику
const PANEL_DIR = path.join(ROOT, 'panel');

export async function handleRequest(req, res) {
  if (req.url.includes('..') || req.url.toLowerCase().includes('%2e')) {
    send(res, 403, 'Forbidden');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (await handlePublic(req, res, url)) return;
    if (await handleMeta(req, res, url)) return;
    if (await handleApi(req, res, url)) return;

    // embed.js должен грузиться с любого домена
    if (url.pathname === '/embed.js') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    if (serveStatic(res, PANEL_DIR, url.pathname)) return;

    // SPA: любой неизвестный путь отдаёт панель
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (serveStatic(res, PANEL_DIR, '/index.html')) return;
    }

    send(res, 404, 'Not found');
  } catch (err) {
    console.error('[error]', req.method, url.pathname, err);
    if (!res.headersSent) {
      send(res, err.status || 500, JSON.stringify({ ok: false, error: 'server_error' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
  }
}
