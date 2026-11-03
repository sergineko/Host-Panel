/**
 * File manager for a site's files (like cPanel's File Manager).
 *
 * Every path from the browser is relative to a root (the site's published release, its
 * persistent "shared" folder or the WordPress folder) and is resolved with realpath, so
 * neither "..", absolute paths nor symlinks planted by the site can reach other files.
 * The panel works as root, so whatever it creates is handed back to the site user.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.ts';
import type { SiteRow } from '../db.ts';
import { HttpError } from '../lib/validate.ts';
import { exec } from '../lib/exec.ts';
import { chownSite, RUNUSER, sitePaths } from './system.ts';
import { wpDir } from './wordpress.ts';

export interface FileRoot {
  id: 'site' | 'shared';
  label: string;
  description: string;
  /** Changes survive the next deploy. */
  persistent: boolean;
}

export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  modified: string;
  mode: string;
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/** Folder of the live release (the whole checkout, not only the published subfolder). */
function releaseDir(site: SiteRow) {
  if (!site.active_release) return null;
  return join(sitePaths(site.id).releases, site.active_release);
}

export function fileRoots(site: SiteRow): FileRoot[] {
  if (site.source === 'wordpress') {
    return [{ id: 'site', label: 'WordPress', description: 'Archivos de WordPress (temas, plugins y subidas incluidos).', persistent: true }];
  }
  const roots: FileRoot[] = [];
  if (site.active_release) {
    roots.push(
      site.repo_url
        ? {
            id: 'site',
            label: 'Versión publicada',
            description: 'Código de la release activa. Se reemplaza en cada despliegue desde Git: cambia el repositorio para cambios duraderos.',
            persistent: false,
          }
        : { id: 'site', label: 'Archivos del sitio', description: 'Lo que sirve tu web. Se conservan en cada nueva publicación.', persistent: true },
    );
  }
  roots.push({
    id: 'shared',
    label: 'Compartido',
    description: 'Carpeta persistente fuera de las releases (subidas, datos, .env). No se toca al desplegar.',
    persistent: true,
  });
  return roots;
}

async function rootPath(site: SiteRow, id: string): Promise<string> {
  let dir: string | null;
  if (site.source === 'wordpress') dir = id === 'site' ? wpDir(site.id) : null;
  else dir = id === 'site' ? releaseDir(site) : id === 'shared' ? sitePaths(site.id).shared : null;
  if (!dir) throw new HttpError(404, 'Esa carpeta no existe para este sitio');
  dir = resolve(dir);
  if (config.dev && !existsSync(dir)) seedDevFolder(dir, id);
  try {
    return await realpath(dir);
  } catch {
    throw new HttpError(404, 'La carpeta del sitio todavía no existe (publica el sitio primero)');
  }
}

/** Dev mode has no real deploys: give the file manager something to show. */
function seedDevFolder(dir: string, id: string) {
  mkdirSync(dir, { recursive: true });
  if (id === 'shared') {
    writeFileSync(join(dir, '.env'), 'APP_ENV=production\n');
    mkdirSync(join(dir, 'uploads'), { recursive: true });
    return;
  }
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html>\n<html lang="es">\n<head><meta charset="utf-8"><title>Mi web</title><link rel="stylesheet" href="assets/style.css"></head>\n<body>\n  <h1>Hola 👋</h1>\n</body>\n</html>\n');
  writeFileSync(join(dir, 'assets', 'style.css'), 'body { font-family: system-ui; margin: 4rem; }\n');
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

function cleanRel(rel: string) {
  const parts = rel.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..' || x.includes('\0'))) throw new HttpError(400, 'Ruta no válida');
  return parts.join('/');
}

export function checkName(name: string) {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || name.length > 255) throw new HttpError(400, `Nombre no válido: ${name || '(vacío)'}`);
  return name;
}

/** Existing path inside the root (symlinks are followed, but must stay inside). */
async function existing(root: string, rel: string) {
  const target = join(root, cleanRel(rel));
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new HttpError(404, 'No existe ese archivo o carpeta');
  }
  if (!inside(root, real)) throw new HttpError(403, 'Ese enlace apunta fuera de la carpeta del sitio');
  return { target, real };
}

/** Path for something new: its folder must exist inside the root and the name must be free or a regular file. */
async function creatable(root: string, rel: string, overwrite = false) {
  const clean = cleanRel(rel);
  if (!clean) throw new HttpError(400, 'Falta el nombre');
  const parent = await existing(root, dirname(clean) === '.' ? '' : dirname(clean));
  const name = checkName(basename(clean));
  const target = join(parent.real, name);
  const st = await lstat(target).catch(() => null);
  if (st?.isSymbolicLink()) throw new HttpError(403, 'No se puede escribir sobre un enlace simbólico');
  if (st && !overwrite) throw new HttpError(409, `Ya existe "${name}"`);
  if (st?.isDirectory()) throw new HttpError(409, `"${name}" es una carpeta`);
  return target;
}

const giveBack = (site: SiteRow, path: string) => chownSite(site.id, path);

// --- operations ---------------------------------------------------------------------

export async function listDir(site: SiteRow, rootId: string, rel: string) {
  const root = await rootPath(site, rootId);
  const { real } = await existing(root, rel);
  const st = await stat(real);
  if (!st.isDirectory()) throw new HttpError(400, 'No es una carpeta');
  const names = (await readdir(real)).slice(0, MAX_ENTRIES);
  const entries: FileEntry[] = [];
  for (const name of names) {
    const l = await lstat(join(real, name)).catch(() => null);
    if (!l) continue;
    let type: FileEntry['type'] = l.isDirectory() ? 'dir' : l.isSymbolicLink() ? 'link' : 'file';
    let size = l.size;
    if (type === 'link') {
      const t = await stat(join(real, name)).catch(() => null);
      if (t?.isDirectory()) type = 'dir';
      else if (t) size = t.size;
    }
    entries.push({ name, type, size: type === 'dir' ? 0 : size, modified: l.mtime.toISOString(), mode: (l.mode & 0o777).toString(8).padStart(3, '0') });
  }
  entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name, 'es', { numeric: true }) : a.type === 'dir' ? -1 : 1);
  return { path: relative(root, real).split(sep).join('/'), entries, truncated: names.length >= MAX_ENTRIES };
}

export async function readText(site: SiteRow, rootId: string, rel: string) {
  const root = await rootPath(site, rootId);
  const { real } = await existing(root, rel);
  const st = await stat(real);
  if (!st.isFile()) throw new HttpError(400, 'No es un archivo');
  if (st.size > MAX_EDIT_BYTES) throw new HttpError(413, 'El archivo es demasiado grande para editarlo aquí (máx. 2 MB): descárgalo');
  const buf = await readFile(real);
  if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, 'Es un archivo binario: descárgalo para abrirlo');
  return { content: buf.toString('utf8'), size: st.size, modified: st.mtime.toISOString() };
}

export async function writeText(site: SiteRow, rootId: string, rel: string, content: string, opts: { create?: boolean; expectedModified?: string }) {
  const root = await rootPath(site, rootId);
  if (Buffer.byteLength(content) > MAX_EDIT_BYTES) throw new HttpError(413, 'Contenido demasiado grande (máx. 2 MB)');
  let target: string;
  if (opts.create) {
    target = await creatable(root, rel);
  } else {
    const { real } = await existing(root, rel);
    if (!(await stat(real)).isFile()) throw new HttpError(400, 'No es un archivo');
    // Someone (a deploy, the app, another tab) changed it since it was opened.
    if (opts.expectedModified && (await stat(real)).mtime.toISOString() !== opts.expectedModified) {
      throw new HttpError(409, 'El archivo ha cambiado desde que lo abriste. Recárgalo para no perder esos cambios.');
    }
    target = real;
  }
  await writeFile(target, content);
  await giveBack(site, target);
  return { modified: (await stat(target)).mtime.toISOString() };
}

export async function makeDir(site: SiteRow, rootId: string, rel: string) {
  const root = await rootPath(site, rootId);
  const target = await creatable(root, rel);
  await mkdir(target);
  await giveBack(site, target);
}

export async function renamePath(site: SiteRow, rootId: string, from: string, to: string) {
  const root = await rootPath(site, rootId);
  const src = await existing(root, from);
  if (src.real === root) throw new HttpError(400, 'No se puede mover la carpeta raíz');
  const dest = await creatable(root, to);
  if (inside(src.real, dest)) throw new HttpError(400, 'No se puede mover una carpeta dentro de sí misma');
  // Move the link itself when the source is a symlink.
  const l = await lstat(src.target);
  await rename(l.isSymbolicLink() ? src.target : src.real, dest);
}

export async function removePaths(site: SiteRow, rootId: string, paths: string[]) {
  const root = await rootPath(site, rootId);
  for (const rel of paths) {
    const clean = cleanRel(rel);
    if (!clean) throw new HttpError(400, 'No se puede borrar la carpeta raíz');
    const target = join(root, clean);
    const l = await lstat(target).catch(() => null);
    if (!l) continue;
    if (l.isSymbolicLink()) {
      await rm(target); // only the link
      continue;
    }
    const { real } = await existing(root, clean);
    if (real === root) throw new HttpError(400, 'No se puede borrar la carpeta raíz');
    await rm(real, { recursive: true, force: true });
  }
}

export async function saveUpload(site: SiteRow, rootId: string, rel: string, body: Readable, overwrite: boolean) {
  const root = await rootPath(site, rootId);
  const target = await creatable(root, rel, overwrite);
  const tmp = `${target}.hp-upload-${process.pid}-${Date.now()}`;
  let size = 0;
  body.on('data', (c: Buffer) => {
    size += c.length;
    if (size > config.maxObjectSize) body.destroy(new HttpError(413, 'Archivo demasiado grande'));
  });
  try {
    await pipeline(body, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await giveBack(site, target);
  return { size };
}

export async function openDownload(site: SiteRow, rootId: string, rel: string) {
  const root = await rootPath(site, rootId);
  const { real } = await existing(root, rel);
  const st = await stat(real);
  if (!st.isFile()) throw new HttpError(400, 'Solo se pueden descargar archivos');
  return { stream: createReadStream(real), size: st.size, name: basename(real) };
}

/** Extracts a .zip / .tar.gz / .tgz / .tar next to it, as the site user (no files outside its folder). */
export async function extractArchive(site: SiteRow, rootId: string, rel: string) {
  const root = await rootPath(site, rootId);
  const { real } = await existing(root, rel);
  const dir = dirname(real);
  const lower = real.toLowerCase();
  let cmd: string[];
  if (lower.endsWith('.zip')) cmd = ['unzip', '-o', '-q', real, '-d', dir];
  else if (/\.(tar\.gz|tgz)$/.test(lower)) cmd = ['tar', '--no-same-owner', '-xzf', real, '-C', dir];
  else if (lower.endsWith('.tar')) cmd = ['tar', '--no-same-owner', '-xf', real, '-C', dir];
  else throw new HttpError(400, 'Formato no soportado: usa .zip, .tar.gz, .tgz o .tar');
  // Runs as the site user: an archive with "../" or absolute paths cannot write elsewhere.
  await exec(RUNUSER, ['-u', `hp-${site.id}`, '--', ...cmd], { timeoutMs: 10 * 60_000 });
  await giveBack(site, dir);
}

/** Total size of a root (du), for the header. */
export async function folderSize(site: SiteRow, rootId: string): Promise<number | null> {
  if (config.dev) return null;
  const root = await rootPath(site, rootId);
  const out = await exec('du', ['-sb', root]).catch(() => '');
  const n = Number(out.split(/\s/)[0]);
  return Number.isFinite(n) ? n : null;
}
