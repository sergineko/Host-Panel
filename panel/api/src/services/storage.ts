/**
 * Object storage: buckets are directories under
 * HP_STORAGE_DIR, objects are files. Public buckets can be served by Caddy on their own
 * hostname (cdn.example.com); private ones are read through the token API.
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import { exec } from '../lib/exec.ts';
import { HttpError } from '../lib/validate.ts';

export const BUCKET_RE = /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/;

export const bucketDir = (name: string) => join(config.storageDir, name);

/** Validates an object key and returns its absolute path inside the bucket. */
export function objectPath(bucket: string, key: string) {
  if (!key || key.length > 1024 || key.includes('\0') || key.startsWith('/') || key.endsWith('/')) {
    throw new HttpError(400, 'Clave de objeto no válida');
  }
  const parts = key.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.hp-'))) throw new HttpError(400, 'Clave de objeto no válida');
  const root = resolve(bucketDir(bucket));
  const full = resolve(root, ...parts);
  if (!full.startsWith(root + sep)) throw new HttpError(400, 'Clave de objeto no válida');
  return full;
}

export async function createBucketDir(name: string) {
  const dir = bucketDir(name);
  await mkdir(dir, { recursive: true });
  // Caddy (public buckets) needs read access; new files inherit the default ACL.
  await exec('setfacl', ['-R', '-m', `u:${config.caddyUser}:rX`, dir]);
  await exec('setfacl', ['-R', '-d', '-m', `u:${config.caddyUser}:rX`, dir]);
}

export async function removeBucketDir(name: string) {
  await rm(bucketDir(name), { recursive: true, force: true });
}

export interface ObjectEntry {
  key: string;
  size: number;
  modified: string;
  type: string;
}

/**
 * Lists one "folder" level, S3-style: objects directly under the prefix plus the
 * common prefixes (sub-folders).
 */
export async function listObjects(bucket: string, prefix = '', limit = 1000) {
  const base = prefix ? join(bucketDir(bucket), ...prefix.replace(/\/$/, '').split('/')) : bucketDir(bucket);
  const root = resolve(bucketDir(bucket));
  if (!resolve(base).startsWith(root)) throw new HttpError(400, 'Prefijo no válido');
  const objects: ObjectEntry[] = [];
  const folders: string[] = [];
  let truncated = false;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { objects, folders, truncated };
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.hp-')) continue;
    const key = prefix ? `${prefix.replace(/\/$/, '')}/${e.name}` : e.name;
    if (e.isDirectory()) folders.push(`${key}/`);
    else if (e.isFile()) {
      if (objects.length >= limit) {
        truncated = true;
        break;
      }
      const st = await stat(join(base, e.name));
      objects.push({ key, size: st.size, modified: st.mtime.toISOString(), type: mimeType(e.name) });
    }
  }
  return { objects, folders, truncated };
}

/** Total size and object count of a bucket (walks the tree; fine for panel-sized buckets). */
export async function bucketUsage(bucket: string) {
  let size = 0;
  let count = 0;
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && !e.name.startsWith('.hp-')) {
        size += (await stat(p)).size;
        count++;
      }
    }
  };
  await walk(bucketDir(bucket));
  return { size, count };
}

/** Streams a request body into an object (written to a temp file, then renamed). */
export async function putObject(bucket: string, key: string, body: Readable) {
  const path = objectPath(bucket, key);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.hp-upload-${process.pid}-${Date.now()}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > config.maxObjectSize) cb(new HttpError(413, 'El archivo supera el tamaño máximo permitido'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(body, limiter, createWriteStream(tmp, { mode: 0o644 }));
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { key, size, type: mimeType(key) };
}

export async function getObject(bucket: string, key: string) {
  const path = objectPath(bucket, key);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, 'Objeto no encontrado');
  return { stream: createReadStream(path), size: st.size, modified: st.mtime, type: mimeType(key) };
}

export async function deleteObject(bucket: string, key: string) {
  const path = objectPath(bucket, key);
  await rm(path, { force: true });
  // Remove now-empty parent folders (S3 has no real folders).
  const root = resolve(bucketDir(bucket));
  let dir = dirname(path);
  while (resolve(dir) !== root && resolve(dir).startsWith(root)) {
    try {
      await rmdir(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

export async function deletePrefix(bucket: string, prefix: string) {
  const dir = objectPath(bucket, prefix.replace(/\/$/, ''));
  await rm(dir, { recursive: true, force: true });
}

export const bucketExists = (name: string) => existsSync(bucketDir(name));
export const relativeKey = (bucket: string, path: string) => relative(bucketDir(bucket), path).split(sep).join('/');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml', '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};
export const mimeType = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
