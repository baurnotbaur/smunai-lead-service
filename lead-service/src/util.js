import { randomBytes } from 'node:crypto';

export const randomKey = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Телефон -> только цифры, для поиска дублей и сравнения. 8XXX -> 7XXX (KZ/RU). */
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1);
  return d;
}

export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());

/** БИН/ИИН — только цифры (12 знаков в Казахстане). */
export const normalizeBin = (raw) => String(raw || '').replace(/\D+/g, '').slice(0, 12);

const LEGAL_FORMS = new Set([
  'тоо', 'жшс', 'ип', 'жк', 'ао', 'қб', 'оао', 'зао', 'ооо', 'тов', 'llp', 'llc', 'ltd', 'ao',
]);

/**
 * Название организации -> ключ для склейки дублей.
 * «ТОО "Такси Плюс"», «Такси плюс» и «такси  плюс» дают одно и то же.
 * Разбираем на слова, а не режем регуляркой: \b в JS не дружит с кириллицей.
 */
export function normalizeCompany(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !LEGAL_FORMS.has(word))
    .join(' ');
}

/** Обрезка строки до лимита — защита от мусора в базе. */
export const clip = (v, max = 500) => String(v ?? '').trim().slice(0, max);

export const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const STATUSES = {
  new: 'Новая',
  in_work: 'В работе',
  callback: 'Перезвонить',
  won: 'Успех',
  lost: 'Отказ',
};

export const isOpenStatus = (s) => s === 'new' || s === 'in_work' || s === 'callback';

/** Простой лимитер в памяти: не больше `limit` событий на ключ за `windowMs`. */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const bucket = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (bucket.length >= limit) {
      hits.set(key, bucket);
      return false;
    }
    bucket.push(now);
    hits.set(key, bucket);
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return true;
  };
}
