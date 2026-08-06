import { db } from './db.js';
import { clip, normalizePhone, normalizeCompany, normalizeBin, truthy, nowIso } from './util.js';

/* ---------- компании ---------- */

/** Ищет компанию по БИН, затем по нормализованному названию. */
export function findCompany({ name, bin }) {
  const binNorm = normalizeBin(bin);
  if (binNorm) {
    const byBin = db.prepare('SELECT * FROM companies WHERE bin = ?').get(binNorm);
    if (byBin) return byBin;
  }
  const nameNorm = normalizeCompany(name);
  if (!nameNorm) return null;
  return db.prepare('SELECT * FROM companies WHERE name_norm = ?').get(nameNorm) || null;
}

export function createCompany(input) {
  const name = clip(input.name, 200);
  if (!name) throw Object.assign(new Error('Укажите название компании'), { status: 400 });

  const info = db
    .prepare(
      `INSERT INTO companies (name, name_norm, bin, phone, email, address, note, assigned_to)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      name,
      normalizeCompany(name),
      normalizeBin(input.bin),
      clip(input.phone, 40),
      clip(input.email, 160).toLowerCase(),
      clip(input.address, 300),
      clip(input.note, 2000),
      input.assigned_to ? Number(input.assigned_to) : null,
    );
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** Находит компанию или заводит новую — используется при приёме заявки. */
export function ensureCompany({ name, bin, phone, email }) {
  if (!normalizeCompany(name) && !normalizeBin(bin)) return null;
  const found = findCompany({ name, bin });
  if (found) {
    // подтягиваем БИН, если в старой карточке его не было
    const binNorm = normalizeBin(bin);
    if (binNorm && !found.bin) {
      db.prepare("UPDATE companies SET bin = ?, updated_at = datetime('now') WHERE id = ?").run(binNorm, found.id);
      found.bin = binNorm;
    }
    return found;
  }
  return createCompany({ name, bin, phone, email });
}

export function updateCompany(id, patch) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!company) return null;

  const sets = [];
  const vals = [];
  const put = (col, value) => {
    sets.push(`${col} = ?`);
    vals.push(value);
  };

  if (patch.name != null) {
    const name = clip(patch.name, 200);
    if (!name) throw Object.assign(new Error('Название не может быть пустым'), { status: 400 });
    put('name', name);
    put('name_norm', normalizeCompany(name));
  }
  if (patch.bin != null) put('bin', normalizeBin(patch.bin));
  if (patch.phone != null) put('phone', clip(patch.phone, 40));
  if (patch.email != null) put('email', clip(patch.email, 160).toLowerCase());
  if (patch.address != null) put('address', clip(patch.address, 300));
  if (patch.note != null) put('note', clip(patch.note, 2000));
  if ('assigned_to' in patch) put('assigned_to', patch.assigned_to ? Number(patch.assigned_to) : null);

  if (!sets.length) return company;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

/* ---------- контакты ---------- */

export function findContactByPhone(phone) {
  const norm = normalizePhone(phone);
  if (norm.length < 10) return null;
  return db.prepare('SELECT * FROM contacts WHERE phone_norm = ? ORDER BY id LIMIT 1').get(norm) || null;
}

export function createContact(input) {
  const name = clip(input.name, 120);
  const phone = clip(input.phone, 40);
  const email = clip(input.email, 160).toLowerCase();
  if (!name && !phone && !email) {
    throw Object.assign(new Error('Нужно имя, телефон или email'), { status: 400 });
  }

  const consent = truthy(input.marketing_consent ?? input.consent);
  const info = db
    .prepare(
      `INSERT INTO contacts (company_id, name, phone, phone_norm, email, position, note,
                             marketing_consent, consent_at, consent_source)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.company_id ? Number(input.company_id) : null,
      name,
      phone,
      normalizePhone(phone),
      email,
      clip(input.position, 120),
      clip(input.note, 2000),
      consent ? 1 : 0,
      consent ? nowIso() : null,
      consent ? clip(input.consent_source, 60) || 'форма на сайте' : '',
    );
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function updateContact(id, patch) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!contact) return null;

  const sets = [];
  const vals = [];
  const put = (col, value) => {
    sets.push(`${col} = ?`);
    vals.push(value);
  };

  if (patch.name != null) put('name', clip(patch.name, 120));
  if (patch.phone != null) {
    const phone = clip(patch.phone, 40);
    put('phone', phone);
    put('phone_norm', normalizePhone(phone));
  }
  if (patch.email != null) put('email', clip(patch.email, 160).toLowerCase());
  if (patch.position != null) put('position', clip(patch.position, 120));
  if (patch.note != null) put('note', clip(patch.note, 2000));
  if ('company_id' in patch) put('company_id', patch.company_id ? Number(patch.company_id) : null);

  if ('marketing_consent' in patch) {
    const consent = truthy(patch.marketing_consent);
    put('marketing_consent', consent ? 1 : 0);
    // дату согласия ставим один раз — она доказательство, что оно было получено
    if (consent && !contact.marketing_consent) {
      put('consent_at', nowIso());
      put('consent_source', clip(patch.consent_source, 60) || 'вручную');
    }
  }
  if ('unsubscribed' in patch) put('unsubscribed', truthy(patch.unsubscribed) ? 1 : 0);

  if (!sets.length) return contact;
  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

/**
 * По данным заявки находит/создаёт контакт и компанию.
 * Клиента узнаём по телефону, организацию — по названию или БИН.
 * @returns {{companyId: number|null, contactId: number|null}}
 */
export function linkLeadParties({ name, phone, email, company, bin, consent }) {
  const org = ensureCompany({ name: company, bin, phone, email });

  let contact = findContactByPhone(phone);
  if (contact) {
    const patch = {};
    // дозаполняем пустые поля тем, что пришло с новой заявкой
    if (!contact.name && name) patch.name = name;
    if (!contact.email && email) patch.email = email;
    if (!contact.company_id && org) patch.company_id = org.id;
    // согласие только подтверждаем: снять его может лишь сам человек
    if (truthy(consent) && !contact.marketing_consent) {
      patch.marketing_consent = true;
      patch.consent_source = 'форма на сайте';
    }
    if (Object.keys(patch).length) contact = updateContact(contact.id, patch);
  } else if (normalizePhone(phone).length >= 10 || name || email) {
    contact = createContact({ name, phone, email, company_id: org?.id ?? null, consent });
  }

  return { companyId: org?.id ?? null, contactId: contact?.id ?? null };
}
