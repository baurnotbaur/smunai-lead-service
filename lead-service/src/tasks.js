import { db } from './db.js';
import { clip } from './util.js';
import { broadcast } from './events.js';

export const TASK_KINDS = {
  call: 'Звонок',
  meeting: 'Встреча',
  email: 'Письмо',
  other: 'Дело',
};

const TASK_COLUMNS = `
  t.*,
  u.name AS assigned_name,
  l.name AS lead_name,
  l.phone AS lead_phone,
  c.name AS company_name
`;
const TASK_FROM = `
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN companies c ON c.id = t.company_id
`;

/** Срок из формы (datetime-local) -> формат БД. Пустой срок недопустим. */
function parseDue(raw) {
  const value = String(raw || '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)) {
    throw Object.assign(new Error('Укажите срок дела'), { status: 400 });
  }
  return value.slice(0, 16) + ':00';
}

export function listTasks({ scope, filter, leadId, userId }) {
  const where = ['t.done = 0'];
  const args = [];

  if (leadId) {
    where.length = 0; // у заявки показываем и выполненные — это её история
    where.push('t.lead_id = ?');
    args.push(Number(leadId));
  }
  if (scope === 'me') {
    where.push('t.assigned_to = ?');
    args.push(userId);
  }
  if (filter === 'overdue') where.push("t.due_at < datetime('now')");
  if (filter === 'today') where.push("date(t.due_at) <= date('now')");
  if (filter === 'week') where.push("date(t.due_at) <= date('now', '+7 days')");

  return db
    .prepare(`SELECT ${TASK_COLUMNS} ${TASK_FROM} WHERE ${where.join(' AND ')} ORDER BY t.done, t.due_at LIMIT 300`)
    .all(...args);
}

/** Сколько дел горит: для бейджа в меню. */
export function taskCounts(userId) {
  const row = db
    .prepare(
      `SELECT
         SUM(due_at < datetime('now')) AS overdue,
         SUM(date(due_at) = date('now')) AS today,
         COUNT(*) AS open
       FROM tasks WHERE done = 0 AND (assigned_to = ? OR assigned_to IS NULL)`,
    )
    .get(userId);
  return { overdue: row.overdue || 0, today: row.today || 0, open: row.open || 0 };
}

export function createTask(input, user) {
  const title = clip(input.title, 200);
  if (!title) throw Object.assign(new Error('Опишите, что нужно сделать'), { status: 400 });

  const leadId = input.lead_id ? Number(input.lead_id) : null;
  // дело у заявки наследует её компанию — чтобы не потерялось в карточке клиента
  const companyId = input.company_id
    ? Number(input.company_id)
    : leadId
      ? (db.prepare('SELECT company_id FROM leads WHERE id = ?').get(leadId)?.company_id ?? null)
      : null;

  const info = db
    .prepare(
      `INSERT INTO tasks (lead_id, company_id, title, kind, due_at, assigned_to, created_by)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      leadId,
      companyId,
      title,
      TASK_KINDS[input.kind] ? input.kind : 'call',
      parseDue(input.due_at),
      input.assigned_to ? Number(input.assigned_to) : user.id,
      user.id,
    );

  const task = getTask(Number(info.lastInsertRowid));
  if (leadId) {
    db.prepare('INSERT INTO lead_events (lead_id, user_id, type, text) VALUES (?, ?, ?, ?)').run(
      leadId, user.id, 'task', `Дело: ${task.title} — до ${task.due_at.slice(0, 16)}`,
    );
  }
  broadcast('task:change', { id: task.id, lead_id: leadId });
  return task;
}

export const getTask = (id) => db.prepare(`SELECT ${TASK_COLUMNS} ${TASK_FROM} WHERE t.id = ?`).get(id);

export function updateTask(id, patch, user) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return null;

  const sets = [];
  const vals = [];
  const put = (col, value) => {
    sets.push(`${col} = ?`);
    vals.push(value);
  };

  if (patch.title != null) {
    const title = clip(patch.title, 200);
    if (!title) throw Object.assign(new Error('Название не может быть пустым'), { status: 400 });
    put('title', title);
  }
  if (patch.due_at != null) put('due_at', parseDue(patch.due_at));
  if (patch.kind != null && TASK_KINDS[patch.kind]) put('kind', patch.kind);
  if ('assigned_to' in patch) put('assigned_to', patch.assigned_to ? Number(patch.assigned_to) : null);
  if ('done' in patch) {
    const done = patch.done ? 1 : 0;
    put('done', done);
    sets.push(done ? "done_at = datetime('now')" : 'done_at = NULL');
  }

  if (!sets.length) return getTask(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

  const updated = getTask(id);
  if (task.lead_id && 'done' in patch && patch.done && !task.done) {
    db.prepare('INSERT INTO lead_events (lead_id, user_id, type, text) VALUES (?, ?, ?, ?)').run(
      task.lead_id, user.id, 'task', `Дело выполнено: ${updated.title}`,
    );
  }
  broadcast('task:change', { id, lead_id: task.lead_id });
  return updated;
}

export function deleteTask(id) {
  const task = db.prepare('SELECT lead_id FROM tasks WHERE id = ?').get(id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  broadcast('task:change', { id, lead_id: task?.lead_id ?? null });
}
