/**
 * Ответы бота через Gemini.
 *
 * Главное правило заложено в системную инструкцию: отвечать только по базе знаний.
 * Клиенту, которому назвали выдуманную цену или адрес, потом объясняться будет
 * отдел продаж, поэтому на всё, чего нет в базе, бот зовёт менеджера.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { getSetting } from './settings.js';

const client = config.ai.apiKey
  ? new GoogleGenAI({
      apiKey: config.ai.apiKey,
      ...(config.ai.baseUrl ? { httpOptions: { baseUrl: config.ai.baseUrl } } : {}),
    })
  : null;

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

/** Историю переписки складываем шагами: наши сообщения — вывод модели, клиентские — ввод. */
function toSteps(history, fallbackText) {
  const steps = [];
  for (const m of history) {
    const text = String(m.text || '').trim();
    if (!text) continue;
    const type = m.direction === 'in' ? 'user_input' : 'model_output';
    // подряд идущие реплики одной стороны склеиваем в один шаг
    const last = steps.at(-1);
    if (last && last.type === type) {
      last.content[0].text += '\n' + text;
    } else {
      steps.push({ type, content: [{ type: 'text', text }] });
    }
  }

  if (!steps.length || steps.at(-1).type !== 'user_input') {
    const text = String(fallbackText || '').trim() || '(пустое сообщение)';
    steps.push({ type: 'user_input', content: [{ type: 'text', text }] });
  }
  return steps;
}

/**
 * Готовит ответ на входящее сообщение.
 * @param {{channel: string, history: Array<{direction: string, text: string}>, text: string}} input
 * @returns {Promise<{reply: string, needsHuman: boolean, topic: string} | null>} null — если ИИ не настроен или ответ не разобрался
 */
export async function draftReply({ channel, history = [], text }) {
  if (!client) return null;

  const request = client.interactions.create({
    model: config.ai.model,
    // переписку клиентов у себя храним мы, у Google ей лежать незачем
    store: false,
    system_instruction: systemPrompt(channel),
    input: toSteps(history, text),
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: SCHEMA,
    },
    generation_config: {
      // переписка в мессенджере — не место для долгих раздумий, важнее скорость
      thinking_level: 'low',
    },
  });

  // ждём модель ограниченное время: лучше сценарная фраза сразу,
  // чем правильная через полминуты или повторная доставка вебхука
  const interaction = await Promise.race([
    request,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`модель не ответила за ${config.ai.timeoutMs} мс`)), config.ai.timeoutMs),
    ),
  ]);

  const raw = interaction.output_text;
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
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
