import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

export async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw Object.assign(new Error('payload_too_large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Разбирает тело как JSON или как form-urlencoded (обычный <form> без JS). */
export async function readInput(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

export function clientIp(req) {
  // На Vercel реальный IP клиента приходит в x-real-ip — его ставит платформа и
  // подделать со стороны клиента нельзя. Левому значению x-forwarded-for НЕ
  // доверяем: его задаёт сам клиент, а значит rate-limit обходился бы сменой
  // заголовка. Локально прокси нет — берём адрес сокета.
  if (process.env.VERCEL) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return req.socket?.remoteAddress || '';
}

export function serveStatic(res, rootDir, urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const file = path.resolve(rootDir, rel || 'index.html');
  if (!file.startsWith(path.resolve(rootDir))) return send(res, 403, 'Forbidden');
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) throw new Error('dir');
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}
