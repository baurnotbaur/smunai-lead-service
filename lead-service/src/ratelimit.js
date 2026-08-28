import { db } from "./db.js";

export function checkRateLimit(ip, action, maxHits, windowMinutes) {
  // Fail-closed: если IP не определён (не должно быть в проде), блокируем,
  // чтобы не отключать лимитер для спамера, научившегося прятать IP
  if (!ip) return false;
  const key = `${ip}:${action}`;

  // Очистка старых
  db.prepare("DELETE FROM rate_limits WHERE expires_at < datetime('now')").run();

  const hits = db.prepare(`
    INSERT INTO rate_limits (key, hits, expires_at) 
    VALUES (?, 1, datetime('now', ?))
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1
    RETURNING hits
  `).get(key, `+${windowMinutes} minutes`)?.hits || 0;

  return hits <= maxHits;
}
