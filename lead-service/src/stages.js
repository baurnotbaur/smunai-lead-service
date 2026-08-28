import { db } from './db.js';
import { clip } from './util.js';

const KINDS = new Set(['open', 'won', 'lost']);
const COLORS = new Set(['new', 'in_work', 'callback', 'won', 'lost']);

export const listStages = (type = 'sales') => db.prepare('SELECT * FROM stages WHERE active = 1 AND type = ? ORDER BY sort, id').all(type);

export const stageByCode = (code) => db.prepare('SELECT * FROM stages WHERE code = ?').get(code) || null;

/** Коды стадий с нужным смыслом — для SQL вида `status IN (...)`. */
export function codesOfKind(kind, type = 'sales') {
  return db.prepare('SELECT code FROM stages WHERE kind = ? AND active = 1 AND type = ?').all(kind, type).map((r) => r.code);
}

/** Первая стадия воронки: в неё попадают новые заявки. */
export function startCode(type = 'sales') {
  const row = db.prepare("SELECT code FROM stages WHERE active = 1 AND kind = 'open' AND type = ? ORDER BY sort, id LIMIT 1").get(type);
  return row?.code || (type === 'hr' ? 'hr_new' : 'new');
}

/** Готовый кусок SQL `IN (?,?,?)` вместе со значениями. */
export function inClause(codes) {
  return { sql: codes.length ? codes.map(() => '?').join(',') : "''", args: codes };
}

/** Код -> название: подписи в CSV, истории и уведомлениях. */
export function stageTitles() {
  return Object.fromEntries(db.prepare('SELECT code, title FROM stages').all().map((s) => [s.code, s.title]));
}

function nextCode(title) {
  const base = clip(title, 40)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '') || 'stage';
  let code = base;
  for (let i = 2; db.prepare('SELECT 1 FROM stages WHERE code = ?').get(code); i++) code = `${base}_${i}`;
  return code;
}

export function createStage(input) {
  const title = clip(input.title, 60);
  if (!title) throw Object.assign(new Error('Укажите название стадии'), { status: 400 });
  const type = input.type === 'hr' ? 'hr' : 'sales';

  const kind = KINDS.has(input.kind) ? input.kind : 'open';
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM stages WHERE type = ?').get(type).m;
  const info = db
    .prepare('INSERT INTO stages (code, title, kind, color, sort, type) VALUES (?,?,?,?,?,?)')
    .run(nextCode(title), title, kind, COLORS.has(input.color) ? input.color : 'new', maxSort + 10, type);
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function updateStage(id, patch) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
  if (!stage) return null;

  const sets = [];
  const vals = [];
  const put = (col, value) => {
    sets.push(`${col} = ?`);
    vals.push(value);
  };

  if (patch.title != null) {
    const title = clip(patch.title, 60);
    if (!title) throw Object.assign(new Error('Название не может быть пустым'), { status: 400 });
    put('title', title);
  }
  if (patch.kind != null && KINDS.has(patch.kind)) put('kind', patch.kind);
  if (patch.color != null && COLORS.has(patch.color)) put('color', patch.color);
  if (patch.sort != null && Number.isFinite(Number(patch.sort))) put('sort', Number(patch.sort));

  if (!sets.length) return stage;
  db.prepare(`UPDATE stages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
}

/**
 * Удаляет стадию, перенося её заявки в другую — иначе они «повиснут»
 * со статусом, которого больше нет ни в одной воронке.
 */
export function deleteStage(id, moveToCode) {
  const stage = db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
  if (!stage) return null;
  if (db.prepare('SELECT COUNT(*) AS c FROM stages WHERE active = 1').get().c <= 1) {
    throw Object.assign(new Error('Нельзя удалить единственную стадию'), { status: 400 });
  }

  const used = db.prepare('SELECT COUNT(*) AS c FROM leads WHERE status = ?').get(stage.code).c;
  if (used) {
    const target = moveToCode && moveToCode !== stage.code ? stageByCode(moveToCode) : null;
    if (!target) {
      throw Object.assign(
        new Error(`В стадии ${used} заявок — укажите, куда их перенести`),
        { status: 409 },
      );
    }
    db.prepare('UPDATE leads SET status = ? WHERE status = ?').run(target.code, stage.code);
  }

  db.prepare('DELETE FROM stages WHERE id = ?').run(id);
  return { moved: used };
}

/** Порядок стадий задаётся списком id — как их перетащили в настройках. */
export function reorderStages(ids) {
  const stmt = db.prepare('UPDATE stages SET sort = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run((i + 1) * 10, Number(id)));
  return listStages();
}
