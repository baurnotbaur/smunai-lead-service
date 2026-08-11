import { json, send, readInput, clientIp } from '../http.js';
import { config } from '../config.js';
import { createRateLimiter } from '../util.js';
import { createLead, findSiteByKey, originAllowed } from '../leads.js';

const perMinute = createRateLimiter({ limit: 20, windowMs: 60_000 });
const perHour = createRateLimiter({ limit: 100, windowMs: 3_600_000 });

function cors(req, extra = {}) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Site-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
}

/** @returns {boolean} обработан ли запрос */
export async function handlePublic(req, res, url) {
  if (url.pathname === '/api/v1/leads' && req.method === 'OPTIONS') {
    send(res, 204, '', cors(req));
    return true;
  }

  // состояние сервиса без ключа: видно, какая база подключена и жива ли вообще сборка
  if (url.pathname === '/api/v1/health') {
    json(
      res, 200,
      { ok: true, db: config.tursoUrl ? 'turso' : 'file', persistent: !config.ephemeralDb, live: !config.serverless },
      cors(req),
    );
    return true;
  }

  if (url.pathname === '/api/v1/ping') {
    const site = findSiteByKey(url.searchParams.get('key') || req.headers['x-site-key']);
    json(res, site ? 200 : 401, site ? { ok: true, site: site.name } : { ok: false, error: 'bad_key' }, cors(req));
    return true;
  }

  if (url.pathname !== '/api/v1/leads' || req.method !== 'POST') return false;

  const ip = clientIp(req);
  if (!perMinute(ip) || !perHour(ip)) {
    json(res, 429, { ok: false, error: 'rate_limited', message: 'Слишком много запросов, попробуйте позже' }, cors(req));
    return true;
  }

  let input;
  try {
    input = await readInput(req);
  } catch {
    json(res, 413, { ok: false, error: 'too_large' }, cors(req));
    return true;
  }

  const site = findSiteByKey(input.key || input.site_key || req.headers['x-site-key']);
  if (!site) {
    json(res, 401, { ok: false, error: 'bad_key', message: 'Неизвестный ключ сайта' }, cors(req));
    return true;
  }
  if (!originAllowed(site, req.headers.origin)) {
    json(res, 403, { ok: false, error: 'origin_not_allowed', message: 'Домен не разрешён для этого ключа' }, cors(req));
    return true;
  }

  // honeypot: боты заполняют скрытое поле, люди — нет
  if (String(input._hp || '').trim()) {
    json(res, 200, { ok: true, id: 0, message: 'Заявка принята' }, cors(req));
    return true;
  }

  const result = createLead(input, { site, ip, userAgent: req.headers['user-agent'] || '' });
  if (!result.ok) {
    json(res, 400, result, cors(req));
    return true;
  }

  // обычная <form> без JS: возвращаем на страницу, чтобы пользователь не увидел JSON
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/html') && !accept.includes('application/json')) {
    const back = input.redirect || req.headers.referer || '/';
    send(res, 303, '', { Location: back });
    return true;
  }

  json(res, 201, { ok: true, id: result.lead.id, message: 'Заявка принята' }, cors(req));
  return true;
}
