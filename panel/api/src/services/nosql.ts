/**
 * Document (NoSQL) databases. Each database is its own file under <dataDir>/nosql, with
 * JSON documents grouped in collections. Queries use the MongoDB filter and update
 * operators ($eq, $gt, $in, $regex, $or… / $set, $inc, $push…), translated to SQL over
 * the documents' JSON so indexes on fields work.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { config } from '../config.ts';
import { get, type NosqlDatabaseRow } from '../db.ts';
import { HttpError } from '../lib/validate.ts';

export const NOSQL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
export const COLLECTION_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;
const FIELD_SEGMENT_RE = /^[A-Za-z0-9_$@-]{1,64}$/;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_LIMIT = 1000;

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;

const dir = () => join(config.dataDir, 'nosql');
const fileOf = (name: string) => join(dir(), `${name}.db`);
const open = new Map<string, DatabaseSync>();

function handle(name: string): DatabaseSync {
  let d = open.get(name);
  if (d) return d;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  d = new DatabaseSync(fileOf(name));
  d.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS indexes (collection TEXT NOT NULL, field TEXT NOT NULL, is_unique INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (collection, field));
    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (collection, id)
    ) WITHOUT ROWID;`);
  d.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (typeof value !== 'string' || typeof pattern !== 'string') return 0;
    const [, source = pattern, flags = ''] = /^\/(.*)\/([a-z]*)$/s.exec(pattern) ?? [];
    try {
      return new RegExp(source, flags.replace(/[^imsu]/g, '')).test(value) ? 1 : 0;
    } catch {
      return 0;
    }
  });
  open.set(name, d);
  return d;
}

// --- databases ------------------------------------------------------------------------

export function createNosqlDatabase(name: string) {
  handle(name);
}

export async function dropNosqlDatabase(name: string) {
  open.get(name)?.close();
  open.delete(name);
  for (const suffix of ['', '-wal', '-shm']) await rm(`${fileOf(name)}${suffix}`, { force: true });
}

export function nosqlSize(name: string) {
  let total = 0;
  for (const suffix of ['', '-wal']) {
    try {
      total += statSync(`${fileOf(name)}${suffix}`).size;
    } catch {
      /* not created yet */
    }
  }
  return total;
}

export function nosqlByIdOr404(id: number) {
  const row = get<NosqlDatabaseRow>('SELECT * FROM nosql_databases WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'Base de datos NoSQL no encontrada');
  return row;
}

// --- collections ------------------------------------------------------------------------

function checkCollection(name: string) {
  if (!COLLECTION_RE.test(name)) throw new HttpError(400, 'Nombre de colección no válido (letras, números, _ . -; máx. 64)');
  return name;
}

/** Collection names are validated, so they can be inlined (needed for partial indexes). */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function ensureCollection(d: DatabaseSync, name: string) {
  d.prepare('INSERT OR IGNORE INTO collections (name, created_at) VALUES (?, ?)').run(checkCollection(name), Date.now());
}

export function listCollections(db: NosqlDatabaseRow) {
  const d = handle(db.name);
  const rows = d
    .prepare(
      `SELECT c.name, c.created_at, COUNT(x.id) AS count, COALESCE(SUM(LENGTH(x.data)), 0) AS size
       FROM collections c LEFT JOIN docs x ON x.collection = c.name GROUP BY c.name ORDER BY c.name`,
    )
    .all() as { name: string; created_at: number; count: number; size: number }[];
  const idx = d.prepare('SELECT collection, field, is_unique FROM indexes ORDER BY field').all() as { collection: string; field: string; is_unique: number }[];
  return rows.map((r) => ({
    ...r,
    count: Number(r.count),
    size: Number(r.size),
    indexes: idx.filter((i) => i.collection === r.name).map((i) => ({ field: i.field, unique: !!i.is_unique })),
  }));
}

export function createCollection(db: NosqlDatabaseRow, name: string) {
  const d = handle(db.name);
  if (d.prepare('SELECT 1 FROM collections WHERE name = ?').get(checkCollection(name))) throw new HttpError(400, 'Ya existe una colección con ese nombre');
  ensureCollection(d, name);
}

export function dropCollection(db: NosqlDatabaseRow, name: string) {
  const d = handle(db.name);
  checkCollection(name);
  for (const i of d.prepare('SELECT field FROM indexes WHERE collection = ?').all(name) as { field: string }[]) {
    d.exec(`DROP INDEX IF EXISTS ${indexName(name, i.field)}`);
  }
  d.prepare('DELETE FROM indexes WHERE collection = ?').run(name);
  d.prepare('DELETE FROM docs WHERE collection = ?').run(name);
  d.prepare('DELETE FROM collections WHERE name = ?').run(name);
}

// --- field paths and filters --------------------------------------------------------------

function fieldPath(field: string) {
  const parts = field.split('.');
  if (!parts.length || parts.some((p) => !FIELD_SEGMENT_RE.test(p))) throw new HttpError(400, `Campo no válido: ${field}`);
  return '$' + parts.map((p) => (/^\d+$/.test(p) ? `[${p}]` : `."${p}"`)).join('');
}

/** SQL expression for a field; "_id" is the document key column. */
const fieldExpr = (field: string) => (field === '_id' ? 'id' : `json_extract(data, ${lit(fieldPath(field))})`);

type SqlValue = string | number | null;
function sqlValue(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v);
}

function compileValue(field: string, cond: unknown, params: SqlValue[]): string {
  const expr = fieldExpr(field);
  const isOps = cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).length > 0 && Object.keys(cond).every((k) => k.startsWith('$'));
  if (!isOps) return eq(expr, cond, params);
  const parts: string[] = [];
  const ops = cond as Record<string, unknown>;
  for (const [op, v] of Object.entries(ops)) {
    switch (op) {
      case '$eq':
        parts.push(eq(expr, v, params));
        break;
      case '$ne':
        parts.push(`NOT (${eq(expr, v, params)})`);
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        const sym = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
        params.push(sqlValue(v));
        parts.push(`${expr} ${sym} ?`);
        break;
      }
      case '$in':
      case '$nin': {
        if (!Array.isArray(v)) throw new HttpError(400, `${op} necesita una lista`);
        const inner = v.length ? v.map((x) => `(${eq(expr, x, params)})`).join(' OR ') : '0';
        parts.push(op === '$in' ? `(${inner})` : `NOT (${inner})`);
        break;
      }
      case '$exists':
        parts.push(field === '_id' ? (v ? '1' : '0') : `json_type(data, ${lit(fieldPath(field))}) IS ${v ? 'NOT ' : ''}NULL`);
        break;
      case '$contains': {
        // Array field that contains the value.
        params.push(sqlValue(v));
        parts.push(`EXISTS (SELECT 1 FROM json_each(data, ${lit(fieldPath(field))}) WHERE value = ?)`);
        break;
      }
      case '$size':
        params.push(Number(v));
        parts.push(`json_array_length(data, ${lit(fieldPath(field))}) = ?`);
        break;
      case '$regex': {
        const flags = typeof ops.$options === 'string' ? ops.$options : '';
        const source = v instanceof RegExp ? v.source : String(v);
        params.push(`/${source}/${flags}`);
        parts.push(`${expr} REGEXP ?`);
        break;
      }
      case '$options':
        break;
      case '$not':
        parts.push(`NOT (${compileValue(field, v, params)})`);
        break;
      default:
        throw new HttpError(400, `Operador no soportado: ${op}`);
    }
  }
  return parts.length ? parts.join(' AND ') : '1';
}

function eq(expr: string, v: unknown, params: SqlValue[]) {
  if (v === null || v === undefined) return `${expr} IS NULL`;
  if (typeof v === 'object') {
    params.push(JSON.stringify(v));
    return `json(${expr}) = json(?)`;
  }
  params.push(sqlValue(v));
  return `${expr} = ?`;
}

function compileFilter(filter: Filter | undefined, params: SqlValue[]): string {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    if (filter === undefined) return '1';
    throw new HttpError(400, 'El filtro debe ser un objeto');
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(value) || !value.length) throw new HttpError(400, `${key} necesita una lista de filtros`);
      const subs = value.map((f) => `(${compileFilter(f as Filter, params)})`);
      parts.push(key === '$and' ? subs.join(' AND ') : key === '$or' ? `(${subs.join(' OR ')})` : `NOT (${subs.join(' OR ')})`);
    } else if (key.startsWith('$')) {
      throw new HttpError(400, `Operador no soportado: ${key}`);
    } else {
      parts.push(`(${compileValue(key, value, params)})`);
    }
  }
  return parts.length ? parts.join(' AND ') : '1';
}

function compileSort(sort: unknown) {
  if (!sort) return 'ORDER BY created_at, id';
  if (typeof sort !== 'object' || Array.isArray(sort)) throw new HttpError(400, 'sort debe ser un objeto { campo: 1 | -1 }');
  const parts = Object.entries(sort as Record<string, unknown>).map(([f, dir]) => `${fieldExpr(f)} ${Number(dir) < 0 ? 'DESC' : 'ASC'}`);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

// --- documents ----------------------------------------------------------------------------

const newId = () => randomBytes(10).toString('hex');

function toDoc(row: { id: string; data: string }): Doc {
  return { _id: row.id, ...(JSON.parse(row.data) as Doc) };
}

function pick(doc: Doc, fields?: string[]) {
  if (!fields?.length) return doc;
  const out: Doc = { _id: doc._id };
  for (const f of fields) {
    const parts = f.split('.');
    let src: unknown = doc;
    for (const p of parts) src = src && typeof src === 'object' ? (src as Doc)[p] : undefined;
    if (src === undefined) continue;
    let dst = out;
    parts.slice(0, -1).forEach((p) => (dst = (dst[p] ??= {}) as Doc));
    dst[parts.at(-1)!] = src;
  }
  return out;
}

function serialize(doc: Doc) {
  const { _id: _ignored, ...rest } = doc;
  const text = JSON.stringify(rest);
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw new HttpError(413, 'El documento supera 1 MB');
  return text;
}

function docId(doc: Doc) {
  if (doc._id === undefined || doc._id === null || doc._id === '') return newId();
  if (typeof doc._id !== 'string' && typeof doc._id !== 'number') throw new HttpError(400, '_id debe ser texto o número');
  const id = String(doc._id);
  if (id.length > 200) throw new HttpError(400, '_id demasiado largo');
  return id;
}

function wrapWrite<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const msg = (err as Error).message;
    if (/UNIQUE constraint failed: docs\.collection, docs\.id/.test(msg)) throw new HttpError(409, 'Ya existe un documento con ese _id');
    if (/UNIQUE constraint failed/.test(msg)) throw new HttpError(409, 'Otro documento ya tiene ese valor en un campo único');
    throw err;
  }
}

interface FindOptions {
  filter?: Filter;
  sort?: unknown;
  limit?: number;
  skip?: number;
  fields?: string[];
}

export function find(db: NosqlDatabaseRow, collection: string, o: FindOptions = {}) {
  const d = handle(db.name);
  checkCollection(collection);
  const params: SqlValue[] = [];
  const where = compileFilter(o.filter, params);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(o.limit) || 100));
  const skip = Math.max(0, Number(o.skip) || 0);
  const rows = d
    .prepare(`SELECT id, data FROM docs WHERE collection = ${lit(collection)} AND (${where}) ${compileSort(o.sort)} LIMIT ${limit} OFFSET ${skip}`)
    .all(...params) as { id: string; data: string }[];
  return rows.map((r) => pick(toDoc(r), o.fields));
}

export function count(db: NosqlDatabaseRow, collection: string, filter?: Filter) {
  const params: SqlValue[] = [];
  const where = compileFilter(filter, params);
  const r = handle(db.name).prepare(`SELECT COUNT(*) AS n FROM docs WHERE collection = ${lit(checkCollection(collection))} AND (${where})`).get(...params) as { n: number };
  return Number(r.n);
}

export function insertMany(db: NosqlDatabaseRow, collection: string, docs: Doc[]) {
  const d = handle(db.name);
  if (!Array.isArray(docs) || !docs.length) throw new HttpError(400, 'Envía al menos un documento');
  if (docs.length > 1000) throw new HttpError(400, 'Máximo 1000 documentos por llamada');
  ensureCollection(d, collection);
  const now = Date.now();
  const stmt = d.prepare('INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const ids: string[] = [];
  d.exec('BEGIN');
  try {
    wrapWrite(() => {
      for (const doc of docs) {
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'Cada documento debe ser un objeto JSON');
        const id = docId(doc);
        stmt.run(collection, id, serialize(doc), now, now);
        ids.push(id);
      }
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return ids;
}

// --- update operators ---------------------------------------------------------------------

function parentOf(doc: Doc, field: string, create: boolean): [Doc | unknown[] | undefined, string] {
  const parts = field.split('.');
  if (parts.some((p) => !FIELD_SEGMENT_RE.test(p))) throw new HttpError(400, `Campo no válido: ${field}`);
  let cur: Doc = doc;
  for (const p of parts.slice(0, -1)) {
    let next = cur[p];
    if (next === undefined || next === null || typeof next !== 'object') {
      if (!create) return [undefined, parts.at(-1)!];
      next = {};
      cur[p] = next;
    }
    cur = next as Doc;
  }
  return [cur, parts.at(-1)!];
}

function matchesValue(item: unknown, cond: unknown) {
  return JSON.stringify(item) === JSON.stringify(cond);
}

function applyUpdate(doc: Doc, update: Doc): Doc {
  const keys = Object.keys(update);
  if (!keys.length) throw new HttpError(400, 'La actualización está vacía');
  if (!keys.every((k) => k.startsWith('$'))) {
    if (keys.some((k) => k.startsWith('$'))) throw new HttpError(400, 'No mezcles operadores ($set…) con campos sueltos');
    return { ...update, _id: doc._id }; // replacement
  }
  const out = structuredClone(doc);
  for (const [op, fields] of Object.entries(update)) {
    if (!fields || typeof fields !== 'object') throw new HttpError(400, `${op} necesita un objeto`);
    for (const [field, value] of Object.entries(fields as Doc)) {
      if (field === '_id') throw new HttpError(400, 'No se puede modificar _id');
      const [parent, key] = parentOf(out, field, op !== '$unset' && op !== '$pull');
      const target = parent as Doc | undefined;
      switch (op) {
        case '$set':
          target![key] = value;
          break;
        case '$unset':
          if (target) delete target[key];
          break;
        case '$inc':
        case '$mul': {
          const cur = target![key] ?? 0;
          if (typeof cur !== 'number' || typeof value !== 'number') throw new HttpError(400, `${op} solo funciona con números (${field})`);
          target![key] = op === '$inc' ? cur + value : cur * value;
          break;
        }
        case '$min':
        case '$max': {
          const cur = target![key];
          if (cur === undefined || (op === '$min' ? (value as number) < (cur as number) : (value as number) > (cur as number))) target![key] = value;
          break;
        }
        case '$rename': {
          if (typeof value !== 'string') throw new HttpError(400, '$rename necesita el nuevo nombre');
          if (target && key in target) {
            const v = target[key];
            delete target[key];
            const [p2, k2] = parentOf(out, value, true);
            (p2 as Doc)[k2] = v;
          }
          break;
        }
        case '$currentDate':
          target![key] = new Date().toISOString();
          break;
        case '$push':
        case '$addToSet': {
          const arr = (target![key] ?? []) as unknown[];
          if (!Array.isArray(arr)) throw new HttpError(400, `${field} no es una lista`);
          const items = value && typeof value === 'object' && '$each' in (value as Doc) ? ((value as Doc).$each as unknown[]) : [value];
          for (const it of items) if (op === '$push' || !arr.some((x) => matchesValue(x, it))) arr.push(it);
          target![key] = arr;
          break;
        }
        case '$pull': {
          if (target && Array.isArray(target[key])) target[key] = (target[key] as unknown[]).filter((x) => !matchesValue(x, value));
          break;
        }
        case '$pop': {
          if (target && Array.isArray(target[key])) (Number(value) < 0 ? (target[key] as unknown[]).shift() : (target[key] as unknown[]).pop());
          break;
        }
        default:
          throw new HttpError(400, `Operador de actualización no soportado: ${op}`);
      }
    }
  }
  return out;
}

/** Document built from an upsert filter (its plain equality fields). */
function seedFromFilter(filter: Filter = {}): Doc {
  const seed: Doc = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$')) continue;
    const value = v && typeof v === 'object' && !Array.isArray(v) && '$eq' in (v as Doc) ? (v as Doc).$eq : v;
    if (value && typeof value === 'object' && Object.keys(value).some((x) => x.startsWith('$'))) continue;
    if (k === '_id') seed._id = value;
    else {
      const [p, key] = parentOf(seed, k, true);
      (p as Doc)[key] = value;
    }
  }
  return seed;
}

export function updateDocs(db: NosqlDatabaseRow, collection: string, filter: Filter, update: Doc, o: { multi: boolean; upsert?: boolean; replace?: boolean }) {
  const d = handle(db.name);
  ensureCollection(d, collection);
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new HttpError(400, 'La actualización debe ser un objeto');
  if (o.replace && Object.keys(update).some((k) => k.startsWith('$'))) throw new HttpError(400, 'replaceOne recibe un documento completo, sin operadores');
  const targets = find(db, collection, { filter, limit: o.multi ? MAX_LIMIT : 1 });
  const now = Date.now();
  const stmt = d.prepare('UPDATE docs SET data = ?, updated_at = ? WHERE collection = ? AND id = ?');
  let modified = 0;
  let upsertedId: string | null = null;
  d.exec('BEGIN');
  try {
    wrapWrite(() => {
      for (const doc of targets) {
        const next = applyUpdate(doc, update);
        const text = serialize(next);
        if (text !== serialize(doc)) {
          stmt.run(text, now, collection, String(doc._id));
          modified++;
        }
      }
      if (!targets.length && o.upsert) {
        const seed = seedFromFilter(filter);
        const doc = applyUpdate({ ...seed, _id: docId(seed) }, update);
        upsertedId = String(doc._id ?? seed._id);
        d.prepare('INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(collection, upsertedId, serialize(doc), now, now);
      }
    });
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { matchedCount: targets.length, modifiedCount: modified, upsertedId };
}

export function deleteDocs(db: NosqlDatabaseRow, collection: string, filter: Filter, multi: boolean) {
  const d = handle(db.name);
  checkCollection(collection);
  if (multi) {
    const params: SqlValue[] = [];
    const where = compileFilter(filter, params);
    const r = d.prepare(`DELETE FROM docs WHERE collection = ${lit(collection)} AND (${where})`).run(...params);
    return { deletedCount: Number(r.changes) };
  }
  const [doc] = find(db, collection, { filter, limit: 1 });
  if (!doc) return { deletedCount: 0 };
  d.prepare('DELETE FROM docs WHERE collection = ? AND id = ?').run(collection, String(doc._id));
  return { deletedCount: 1 };
}

// --- indexes ------------------------------------------------------------------------------

function indexName(collection: string, field: string) {
  return `ix_${Buffer.from(`${collection}\u0000${field}`).toString('hex').slice(0, 120)}`;
}

export function createIndex(db: NosqlDatabaseRow, collection: string, field: string, unique = false) {
  const d = handle(db.name);
  ensureCollection(d, collection);
  if (field === '_id') throw new HttpError(400, '_id ya está indexado');
  const expr = fieldExpr(field);
  try {
    d.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${indexName(collection, field)} ON docs(${expr}) WHERE collection = ${lit(collection)}`);
  } catch (err) {
    if (/UNIQUE/.test((err as Error).message)) throw new HttpError(409, `Hay documentos repetidos en "${field}": no se puede crear un índice único`);
    throw err;
  }
  d.prepare('INSERT OR REPLACE INTO indexes (collection, field, is_unique) VALUES (?, ?, ?)').run(collection, field, Number(unique));
}

export function dropIndex(db: NosqlDatabaseRow, collection: string, field: string) {
  const d = handle(db.name);
  checkCollection(collection);
  fieldPath(field);
  d.exec(`DROP INDEX IF EXISTS ${indexName(collection, field)}`);
  d.prepare('DELETE FROM indexes WHERE collection = ? AND field = ?').run(collection, field);
}

// --- one entry point for the HTTP API and the Worker binding ------------------------------

const READ_ACTIONS = new Set(['get', 'find', 'findOne', 'count']);
export const isReadAction = (action: string) => READ_ACTIONS.has(action);

export function runNosqlAction(db: NosqlDatabaseRow, collection: string, action: string, raw: unknown) {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const filter = b.filter as Filter | undefined;
  switch (action) {
    case 'get': {
      const [doc] = find(db, collection, { filter: { _id: String(b.id ?? '') }, limit: 1 });
      return { document: doc ?? null };
    }
    case 'find':
      return { documents: find(db, collection, { filter, sort: b.sort, limit: b.limit as number, skip: b.skip as number, fields: b.fields as string[] }) };
    case 'findOne':
      return { document: find(db, collection, { filter, sort: b.sort, limit: 1, fields: b.fields as string[] })[0] ?? null };
    case 'count':
      return { count: count(db, collection, filter) };
    case 'insertOne':
      return { insertedId: insertMany(db, collection, [b.document as Doc])[0] };
    case 'insertMany':
      return { insertedIds: insertMany(db, collection, b.documents as Doc[]) };
    case 'updateOne':
    case 'updateMany':
      return updateDocs(db, collection, filter ?? {}, b.update as Doc, { multi: action === 'updateMany', upsert: !!b.upsert });
    case 'replaceOne':
      return updateDocs(db, collection, filter ?? {}, b.document as Doc, { multi: false, upsert: !!b.upsert, replace: true });
    case 'deleteOne':
    case 'deleteMany':
      return deleteDocs(db, collection, filter ?? {}, action === 'deleteMany');
    case 'createIndex':
      createIndex(db, collection, String(b.field ?? ''), !!b.unique);
      return { ok: true };
    default:
      throw new HttpError(400, `Acción desconocida: ${action}`);
  }
}

// --- export / import (one JSON object per line) ------------------------------------------

export function* exportLines(db: NosqlDatabaseRow): Generator<string> {
  const d = handle(db.name);
  for (const c of listCollections(db)) {
    yield JSON.stringify({ collection: c.name, indexes: c.indexes }) + '\n';
    let last = '';
    for (;;) {
      const rows = d.prepare('SELECT id, data FROM docs WHERE collection = ? AND id > ? ORDER BY id LIMIT 500').all(c.name, last) as { id: string; data: string }[];
      if (!rows.length) break;
      for (const r of rows) yield JSON.stringify({ collection: c.name, document: toDoc(r) }) + '\n';
      last = rows.at(-1)!.id;
    }
  }
}

export async function importLines(db: NosqlDatabaseRow, body: Readable) {
  const d = handle(db.name);
  const rl = createInterface({ input: body, crlfDelay: Infinity });
  const now = Date.now();
  const upsert = d.prepare(
    'INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  );
  let docs = 0;
  let line = 0;
  d.exec('BEGIN');
  try {
    for await (const text of rl) {
      line++;
      if (!text.trim()) continue;
      let entry: { collection?: string; document?: Doc; indexes?: { field: string; unique: boolean }[] };
      try {
        entry = JSON.parse(text);
      } catch {
        throw new HttpError(400, `Línea ${line}: JSON no válido`);
      }
      const coll = checkCollection(String(entry.collection ?? ''));
      ensureCollection(d, coll);
      if (entry.document) {
        wrapWrite(() => upsert.run(coll, docId(entry.document!), serialize(entry.document!), now, now));
        docs++;
      }
      for (const i of entry.indexes ?? []) createIndex(db, coll, i.field, i.unique);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { documents: docs };
}
