/**
 * Доделать работу после ответа клиенту (оценка ИИ, уведомления).
 *
 * На долгоживущем сервере промис доживает сам. В функции Vercel исполнение
 * замирает сразу после ответа, поэтому промис отдаётся платформе через
 * waitUntil — она держит функцию, пока он не завершится, в пределах
 * maxDuration из vercel.json.
 */

import { waitUntil } from '@vercel/functions';
import { config } from './config.js';

export function afterResponse(promise) {
  if (!config.serverless) return;
  try {
    waitUntil(promise);
  } catch (err) {
    // вне контекста запроса Vercel (например, локальный запуск с VERCEL=1)
    console.error('[defer] waitUntil недоступен:', err?.message || err);
  }
}
