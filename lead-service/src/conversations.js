/**
 * Переписка в мессенджерах. Диалог одного человека — это одна заявка:
 * менеджер видит её в общем списке рядом с заявками с сайта, а не в отдельном окне.
 */

import { db } from './db.js';
import { config } from './config.js';
import { clip, normalizePhone } from './util.js';
import { createLead } from './leads.js';
import { codesOfKind } from './stages.js';
import { send, canReply, replyToComment } from './channels/meta.js';
import { draftReply, aiEnabled } from './ai.js';
import { broadcast } from './events.js';

const CHANNELS = { whatsapp: 'WhatsApp', instagram: 'Instagram' };

/** Заявка этого собеседника, если разговор ещё не закрыт. */
function openLead(channel, externalId) {
  const closed = [...codesOfKind('won'), ...codesOfKind('lost')];
  const holes = closed.map(() => '?').join(',') || "''";
  return db
    .prepare(
      `SELECT * FROM leads
        WHERE channel = ? AND external_id = ? AND status NOT IN (${holes})
        ORDER BY id DESC LIMIT 1`,
    )
    .get(channel, externalId, ...closed);
}

const seen = (messageId) =>
  Boolean(messageId) && Boolean(db.prepare('SELECT 1 FROM messages WHERE external_id = ?').get(messageId));

function saveMessage({ leadId, channel, direction, kind, text, messageId }) {
  db.prepare(
    `INSERT INTO messages (lead_id, channel, direction, kind, text, external_id)
     VALUES (?,?,?,?,?,?)`,
  ).run(leadId, channel, direction, kind || 'text', clip(text, 4000), clip(messageId, 120));

  db.prepare("UPDATE leads SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(leadId);
}

/** Похоже ли сообщение на присланный номер телефона. */
function phoneFrom(text) {
  const digits = String(text || '').replace(/\D+/g, '');
  if (digits.length < 10 || digits.length > 15) return '';
  // в тексте должны быть в основном цифры, иначе это просто фраза с числами
  return /^[\d\s+()\-]+$/.test(String(text).trim()) ? normalizePhone(digits) : '';
}

/**
 * Запасной сценарий на случай, когда Gemini не настроен или не ответил.
 * Он намеренно не выдумывает ответы про цены и адреса — здоровается,
 * забирает телефон и передаёт разговор живому менеджеру.
 */
function scriptedReply({ lead, isNew, text }) {
  if (isNew) {
    return lead.phone
      ? 'Здравствуйте! Это С-Мұнай. Спасибо за обращение — менеджер ответит в течение 15 минут в рабочее время.'
      : 'Здравствуйте! Это С-Мұнай. Чтобы менеджер мог связаться с вами быстрее, оставьте, пожалуйста, номер телефона.';
  }

  // телефон дослали следующим сообщением — подтверждаем и больше не спрашиваем
  if (!lead.phone && phoneFrom(text)) {
    return 'Записал номер, спасибо. Менеджер свяжется с вами в ближайшее время.';
  }

  return '';
}

/** Передаёт разговор менеджеру: бот замолкает, в истории остаётся отметка. */
function handOver(leadId, reason) {
  const { changes } = db.prepare('UPDATE leads SET bot_off = 1 WHERE id = ? AND bot_off = 0').run(leadId);
  if (!changes) return;
  db.prepare('INSERT INTO lead_events (lead_id, type, text) VALUES (?, ?, ?)').run(
    leadId,
    'field',
    `Бот передал разговор менеджеру${reason ? ': ' + reason : ''}`,
  );
  broadcast('lead:update', { id: leadId, status: null, by: 0 });
}

/**
 * Что ответить клиенту. Сначала спрашиваем Gemini — он отвечает по базе знаний
 * из панели; если ключа нет или запрос не удался, работает сценарный запасной вариант.
 */
async function composeReply({ lead, isNew, text, channel }) {
  if (!config.botEnabled || lead.bot_off) return { reply: '', handOff: '' };

  if (aiEnabled()) {
    try {
      const draft = await draftReply({
        channel,
        history: listMessages(lead.id).map((m) => ({ direction: m.direction, text: m.text })),
        text,
      });
      if (draft) {
        return {
          reply: draft.reply,
          handOff: draft.needsHuman ? draft.topic || 'нужен живой ответ' : '',
        };
      }
    } catch (err) {
      // модель недоступна или отказала — клиент не должен остаться без ответа
      console.error('[ai] не удалось получить ответ:', err.message);
    }
  }

  return { reply: scriptedReply({ lead, isNew, text }), handOff: '' };
}

/**
 * Принимает одно входящее сообщение: заводит или находит заявку, пишет историю,
 * при необходимости отвечает.
 * @returns {{leadId: number, isNew: boolean, replied: boolean, skipped?: string}}
 */
export async function handleMessage(incoming) {
  const { channel, name, phone, text, kind, messageId, commentId } = incoming;
  const isComment = kind === 'comment';
  // у комментария автор известен не всегда — тогда веткой разговора служит сам комментарий
  const externalId = incoming.externalId || (commentId ? 'comment:' + commentId : '');
  if (!externalId) return { leadId: 0, isNew: false, replied: false, skipped: 'no_sender' };

  // Meta повторяет доставку, пока не получит 200 — без этой проверки
  // один и тот же вопрос клиента превратился бы в несколько заявок
  if (seen(messageId)) return { leadId: 0, isNew: false, replied: false, skipped: 'duplicate' };

  let lead = openLead(channel, externalId);
  const isNew = !lead;

  if (isNew) {
    const result = createLead(
      { name, phone, comment: text },
      { channel, externalId, site: null, ip: '', userAgent: `${CHANNELS[channel] || channel} bot` },
    );
    if (!result.ok) return { leadId: 0, isNew: false, replied: false, skipped: result.error };
    lead = result.lead;
  }

  saveMessage({ leadId: lead.id, channel, direction: 'in', kind, text, messageId });

  // номер, присланный отдельным сообщением, дописываем в карточку
  const late = !lead.phone ? phoneFrom(text) : '';
  if (late) {
    db.prepare('UPDATE leads SET phone = ?, phone_norm = ? WHERE id = ?').run(text.trim(), late, lead.id);
    db.prepare('INSERT INTO lead_events (lead_id, type, text) VALUES (?, ?, ?)').run(
      lead.id,
      'field',
      `Телефон из переписки: ${text.trim()}`,
    );
  }

  if (!isNew) broadcast('lead:update', { id: lead.id, status: lead.status, by: 0 });

  // перечитываем: телефон мог только что дописаться, а bot_off — смениться
  const fresh = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
  const { reply, handOff } = await composeReply({
    lead: fresh,
    isNew,
    text,
    channel: isComment ? 'comment' : channel,
  });

  let replied = false;
  if (reply && (isComment ? canReply('instagram') : canReply(channel))) {
    try {
      const sent = isComment
        ? await replyToComment(commentId, reply)
        : await send(channel, externalId, reply);
      saveMessage({
        leadId: lead.id,
        channel,
        direction: 'out',
        kind: isComment ? 'comment' : 'text',
        text: reply,
        messageId: sent?.messages?.[0]?.id || sent?.message_id || sent?.id || '',
      });
      replied = true;
    } catch (err) {
      // не отвечаем — но заявка уже сохранена, менеджер увидит её и напишет сам
      console.error('[meta] ответ не отправлен:', err.message);
    }
  }

  if (handOff) handOver(lead.id, handOff);

  return { leadId: lead.id, isNew, replied, handOff: Boolean(handOff) };
}

/** Переписка по заявке — для карточки в панели. */
export const listMessages = (leadId) =>
  db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id').all(leadId);

/** Ответ менеджера из панели. */
export async function replyAsManager(leadId, text, user) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;
  if (!lead.external_id || lead.channel === 'site') {
    throw Object.assign(new Error('Этой заявке нельзя ответить: она не из мессенджера'), { status: 400 });
  }

  const sent = await send(lead.channel, lead.external_id, text);
  saveMessage({
    leadId,
    channel: lead.channel,
    direction: 'out',
    kind: 'text',
    text,
    messageId: sent?.messages?.[0]?.id || sent?.message_id || '',
  });
  // менеджер вступил в разговор — дальше бот молчит, чтобы они не отвечали вдвоём
  handOver(leadId, 'менеджер ответил сам');
  db.prepare('INSERT INTO lead_events (lead_id, user_id, type, text) VALUES (?, ?, ?, ?)').run(
    leadId,
    user.id,
    'comment',
    `Ответ в ${CHANNELS[lead.channel] || lead.channel}: ${clip(text, 200)}`,
  );
  return true;
}
