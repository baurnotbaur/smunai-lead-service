/**
 * WhatsApp и Instagram. Оба канала принадлежат Meta и приходят на один вебхук,
 * поэтому здесь общая проверка подписи и разбор, а различия — в двух функциях отправки.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const meta = config.meta;
const graph = (path) => `https://graph.facebook.com/${meta.graphVersion}/${path}`;

/**
 * Meta подписывает тело запроса секретом приложения. Без этой проверки вебхук примет
 * что угодно от кого угодно — адрес публичный, подделать заявку сможет любой.
 */
export function signatureValid(rawBody, header) {
  if (!meta.appSecret) return false;
  const received = String(header || '');
  if (!received.startsWith('sha256=')) return false;

  const expected = 'sha256=' + createHmac('sha256', meta.appSecret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Тип вложения — текст мы понимаем, остальное отмечаем, чтобы менеджер открыл переписку. */
function kindOf(message) {
  if (message.text || message.type === 'text') return 'text';
  for (const k of ['image', 'audio', 'video', 'document', 'sticker', 'location']) {
    if (message[k] || message.type === k) return k === 'document' ? 'other' : k;
  }
  return 'other';
}

/**
 * Приводит оба формата к одному виду.
 * @returns {Array<{channel, externalId, name, phone, text, kind, messageId}>}
 */
export function parseIncoming(body) {
  const out = [];

  for (const entry of body?.entry || []) {
    // --- WhatsApp -----------------------------------------------------------
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // статусы доставки приходят сюда же — они не сообщения, пропускаем
      if (!value.messages) continue;

      const profiles = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));

      for (const m of value.messages) {
        out.push({
          channel: 'whatsapp',
          externalId: m.from,
          name: profiles.get(m.from) || '',
          phone: m.from,                      // wa_id и есть номер в международном формате
          text: m.text?.body || m.button?.text || m.interactive?.list_reply?.title || '',
          kind: kindOf(m),
          messageId: m.id || '',
        });
      }
    }

    // --- Instagram ----------------------------------------------------------
    for (const event of entry.messaging || []) {
      const m = event.message;
      // эхо — это наши же ответы, которые Meta присылает обратно
      if (!m || m.is_echo) continue;

      out.push({
        channel: 'instagram',
        externalId: event.sender?.id || '',
        name: '',                             // имя в вебхуке не приходит, подтягивается отдельно
        phone: '',
        text: m.text || '',
        kind: m.attachments?.length ? m.attachments[0].type || 'other' : 'text',
        messageId: m.mid || '',
      });
    }
  }

  return out.filter((m) => m.externalId);
}

async function post(url, token, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Meta ответила ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export function sendWhatsApp(to, text) {
  const { token, phoneId } = meta.whatsapp;
  if (!token || !phoneId) throw new Error('WhatsApp не настроен: нет WHATSAPP_TOKEN или WHATSAPP_PHONE_ID');
  return post(graph(`${phoneId}/messages`), token, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

export function sendInstagram(to, text) {
  const { token } = meta.instagram;
  if (!token) throw new Error('Instagram не настроен: нет INSTAGRAM_TOKEN');
  return post(graph('me/messages'), token, {
    recipient: { id: to },
    message: { text },
  });
}

export const send = (channel, to, text) =>
  channel === 'whatsapp' ? sendWhatsApp(to, text) : sendInstagram(to, text);

/** Настроен ли канал настолько, чтобы можно было отвечать. */
export const canReply = (channel) =>
  channel === 'whatsapp'
    ? Boolean(meta.whatsapp.token && meta.whatsapp.phoneId)
    : Boolean(meta.instagram.token);
