import { db } from "./db.js";

export function checkRateLimit(ip, action, maxHits, windowMinutes) {
  if (!ip) return true;
  const key = `${ip}:${action}`;

  db.prepare(`DELETE FROM rate_limits WHERE expires_at < datetime("now")`).run();

  const row = db.prepare(`SELECT hits FROM rate_limits WHERE key = ?`).get(key);
  if (!row) {
    db.prepare(`INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, datetime("now", ?))`)
      .run(key, `+${windowMinutes} minutes`);
    return true;
  }

  if (row.hits >= maxHits) {
    return false;
  }

  db.prepare(`UPDATE rate_limits SET hits = hits + 1 WHERE key = ?`).run(key);
  return true;
}
