/**
 * Ответы бота через Claude.
 *
 * Главное правило заложено в системный промпт: отвечать только по базе знаний.
 * Клиенту, которому назвали выдуманную цену или адрес, потом объясняться будет
 * отдел продаж, поэтому на всё, чего нет в базе, бот зовёт менеджера.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getSetting } from './settings.js';

const client = config.ai.apiKey ? new Anthropic({ apiKey: config.ai.apiKey }) : null;

export const aiEnabled = () => Boolean(client);

const CHANNEL_LIMITS = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  comment: 'комментарий под постом в Instagram',
};

const SCHEMA = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'Текст ответа клиенту. Пустая строка — если отвечать не нужно.',
    },
    needs_human: {
      type: 'boolean',
      description: 'true, если вопрос требует менеджера: нет данных в базе знаний, торг, жалоба, договор.',
    },
    topic: {
      type: 'string',
      description: 'О чём спросили, 2-4 слова, для карточки заявки.',
    },
  },
  required: ['reply', 'needs_human', 'topic'],
  additionalProperties: false,
};

function systemPrompt(channel) {
  const knowledge = getSetting('bot_knowledge');
  const greeting = getSetting('bot_greeting').trim();
  const place = CHANNEL_LIMITS[channel] || channel;

  return `Ты отвечаешь клиентам сети автозаправочных станций С-Мұнай в ${place}.

<знания>
${knowledge}
</знания>

Отвечай только тем, что есть в блоке знаний выше. Если ответа там нет — не придумывай
и не строй догадок: скажи, что уточнишь у менеджера, и поставь needs_human. Это касается
всего, что клиент может проверить: цены, адреса, часы работы, наличие топлива, сроки,
условия договора, номера телефонов.

Ставь needs_human и когда клиент торгуется, жалуется, просит особые условия или счёт,
даже если формально ответ в знаниях есть.

Как писать:
- на языке клиента: написал по-казахски — отвечай по-казахски, по-русски — по-русски;
- одно-два предложения, это переписка в мессенджере, а не письмо;
- без разметки, списков и заголовков, живой человеческой речью;
- обращайся на «вы»;
- если телефона клиента ещё нет в разговоре, спроси его один раз, не настойчивее.
${greeting ? `\nПри первом сообщении представься так: ${greeting}` : ''}

Ничего не обещай от имени компании: ни скидок, ни сроков, ни брони. Это решает менеджер.`;
}

/**
 * Готовит ответ на входящее сообщение.
 * @param {{channel: string, history: Array<{direction: string, text: string}>, text: string}} input
 * @returns {Promise<{reply: string, needsHuman: boolean, topic: string} | null>} null — если ИИ не настроен или отказал
 */
export async function draftReply({ channel, history = [], text }) {
  if (!client) return null;

  const messages = [];
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const content = String(m.text || '').trim();
    if (!content) continue;
    // Claude требует чередования ролей — подряд идущие склеиваем
    if (messages.length && messages.at(-1).role === role) {
      messages.at(-1).content += '\n' + content;
    } else {
      messages.push({ role, content });
    }
  }
  if (!messages.length || messages.at(-1).role !== 'user') {
    messages.push({ role: 'user', content: String(text || '').trim() || '(пустое сообщение)' });
  }

  const response = await client.messages.create({
    model: config.ai.model,
    // с запасом: на Opus 5 лимит считает и рассуждения, и текст ответа
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: systemPrompt(channel),
        // база знаний между запросами не меняется — пусть считается один раз
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      // переписка с клиентом — не место для долгих раздумий, важнее скорость ответа
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    messages,
  });

  if (response.stop_reason === 'refusal') {
    console.warn('[ai] модель отказалась отвечать:', response.stop_details?.category);
    return null;
  }

  const block = response.content.find((b) => b.type === 'text');
  if (!block) return null;

  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    console.warn('[ai] ответ не разобрался как JSON');
    return null;
  }

  return {
    reply: String(parsed.reply || '').trim(),
    needsHuman: Boolean(parsed.needs_human),
    topic: String(parsed.topic || '').trim(),
  };
}
