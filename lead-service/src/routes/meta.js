/**
 * Вебхук Meta — один адрес на оба канала.
 * WhatsApp и Instagram подключаются к нему в настройках приложения.
 */

import { json, send as respond, readBody } from '../http.js';
import { config } from '../config.js';
import { signatureValid, parseIncoming } from '../channels/meta.js';
import { handleMessage } from '../conversations.js';

const PATH = '/api/v1/webhook/meta';

/** @returns {boolean} обработан ли запрос */
export async function handleMeta(req, res, url) {
  if (url.pathname !== PATH) return false;

  // --- подключение вебхука: Meta ждёт обратно присланную строку ----------------
  if (req.method === 'GET') {
    const params = url.searchParams;
    const token = config.meta.verifyToken;

    if (token && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === token) {
      respond(res, 200, params.get('hub.challenge') || '', { 'Content-Type': 'text/plain; charset=utf-8' });
    } else {
      respond(res, 403, 'Forbidden');
    }
    return true;
  }

  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { ok: false, error: 'too_large' });
    return true;
  }

  if (!signatureValid(raw, req.headers['x-hub-signature-256'])) {
    // адрес публичный: без подписи любой мог бы слать сюда выдуманные заявки
    json(res, 401, { ok: false, error: 'bad_signature' });
    return true;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: 'bad_json' });
    return true;
  }

  const messages = parseIncoming(body);

  // Meta повторяет доставку, пока не получит 200, поэтому об ошибке обработки
  // ей лучше не сообщать — иначе одно кривое сообщение будет ходить по кругу
  for (const message of messages) {
    try {
      await handleMessage(message);
    } catch (err) {
      console.error('[meta] сообщение не обработано:', err.message);
    }
  }

  json(res, 200, { ok: true, received: messages.length });
  return true;
}
