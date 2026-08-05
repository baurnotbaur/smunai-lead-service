import { config } from './config.js';

const escapeHtml = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/** Уведомления о новой заявке. Ошибки не роняют приём заявки — только пишутся в лог. */
export function notifyNewLead(lead, site, manager) {
  sendTelegram(lead, site, manager).catch((e) => console.error('[telegram]', e.message));
  sendWebhook(lead, site).catch((e) => console.error('[webhook]', e.message));
}

async function sendTelegram(lead, site, manager) {
  if (!config.telegramToken || !config.telegramChatId) return;
  const lines = [
    '<b>🔔 Новая заявка</b>',
    lead.name && `Имя: <b>${escapeHtml(lead.name)}</b>`,
    lead.phone && `Телефон: <b>${escapeHtml(lead.phone)}</b>`,
    lead.email && `Email: ${escapeHtml(lead.email)}`,
    lead.comment && `Комментарий: ${escapeHtml(lead.comment)}`,
    site && `Сайт: ${escapeHtml(site.name)}`,
    lead.utm_source && `Источник: ${escapeHtml(lead.utm_source)} / ${escapeHtml(lead.utm_campaign || '—')}`,
    manager && `Ответственный: ${escapeHtml(manager.name)}`,
    lead.is_duplicate && '⚠️ Похоже на дубль',
    `\n${config.publicUrl}/#/lead/${lead.id}`,
  ].filter(Boolean);

  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

async function sendWebhook(lead, site) {
  if (!site?.webhook_url) return;
  const res = await fetch(site.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'lead.created', lead }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
