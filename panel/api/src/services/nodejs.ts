/**
 * Several Node.js versions side by side. The admin installs them (by hand or from the
 * panel) under /opt/nodejs/<version>; installs made with n, nvm (global) or the official
 * tarball in /usr/local/lib/nodejs are detected too. Each site picks a version, a major
 * line ("22" = newest 22.x) or "latest" (the highest installed). Nothing is updated
 * automatically: installing a newer version is the admin's call, and "latest" sites
 * pick it up on their next deploy.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { arch } from 'node:os';
// Linux paths even when the panel runs in dev mode on another OS.
import { join } from 'node:path/posix';
import { config } from '../config.ts';
import { all } from '../db.ts';
import { exec, tryExec } from '../lib/exec.ts';
import type { JobLog } from './jobs.ts';

export const NODE_DIR = '/opt/nodejs';
const SEARCH_DIRS: { dir: string; source: string; nested?: boolean }[] = [
  { dir: NODE_DIR, source: 'HostPanel / manual' },
  { dir: '/usr/local/n/versions/node', source: 'n' },
  { dir: '/usr/local/nvm/versions/node', source: 'nvm' },
  { dir: '/usr/local/lib/nodejs', source: 'tarball' },
];
const SYSTEM_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node'];
export const BASE_PATH = '/usr/local/bin:/usr/bin:/bin';

export interface NodeInstall {
  version: string;
  /** Folder with node, npm and npx. */
  bin: string;
  source: string;
  system: boolean;
  /** Only versions under /opt/nodejs can be removed from the panel. */
  removable: boolean;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
export const NODE_SPEC_RE = /^(latest|system|\d{1,3}|\d{1,3}\.\d{1,3}\.\d{1,3})$/;

export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function versionOf(nodePath: string, hint: string): string | null {
  const m = VERSION_RE.exec(hint.replace(/^node-/, '').replace(/-linux-.*$/, ''));
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  try {
    const out = execFileSync(nodePath, ['--version'], { timeout: 3000, encoding: 'utf8' }).trim();
    const v = VERSION_RE.exec(out);
    return v ? `${v[1]}.${v[2]}.${v[3]}` : null;
  } catch {
    return null;
  }
}

// --- detection (cached briefly: it runs on every site listing) --------------------------

const devInstalled = new Map<string, NodeInstall>();
let cache: { at: number; list: NodeInstall[] } | null = null;

function devList(): NodeInstall[] {
  if (!devInstalled.size) {
    const system = process.versions.node;
    devInstalled.set(system, { version: system, bin: '/usr/bin', source: 'Sistema', system: true, removable: false });
    for (const v of ['20.18.1', '22.11.0']) devInstalled.set(v, { version: v, bin: join(NODE_DIR, v, 'bin'), source: 'HostPanel / manual', system: false, removable: true });
  }
  return [...devInstalled.values()];
}

export function installedNodeVersions(fresh = false): NodeInstall[] {
  if (config.dev) return devList().sort((a, b) => compareVersions(b.version, a.version));
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.list;
  const found = new Map<string, NodeInstall>();
  for (const { dir, source } of SEARCH_DIRS) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const bin = join(dir, name, 'bin');
      const node = join(bin, 'node');
      if (!existsSync(node)) continue;
      const version = versionOf(node, name);
      if (!version || found.has(version)) continue;
      found.set(version, { version, bin, source, system: false, removable: dir === NODE_DIR });
    }
  }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    let real = candidate;
    try {
      real = realpathSync(candidate);
    } catch {
      /* keep path */
    }
    const version = versionOf(candidate, '');
    if (!version) continue;
    // A symlink into one of the folders above is the same install, not a separate one.
    if ([...found.values()].some((f) => real.startsWith(f.bin))) continue;
    if (!found.has(version)) found.set(version, { version, bin: candidate.replace(/\/node$/, ''), source: 'Sistema', system: true, removable: false });
    break;
  }
  const list = [...found.values()].sort((a, b) => compareVersions(b.version, a.version));
  cache = { at: Date.now(), list };
  return list;
}

/** The install a version spec points at, or null when nothing matches. */
export function resolveNode(spec: string, list = installedNodeVersions()): NodeInstall | null {
  if (!list.length) return null;
  const s = spec || 'latest';
  if (s === 'latest') return list[0]!;
  if (s === 'system') return list.find((n) => n.system) ?? list[0]!;
  if (/^\d+$/.test(s)) return list.find((n) => n.version.split('.')[0] === s) ?? null;
  return list.find((n) => n.version === s) ?? null;
}

export function describeSpec(spec: string) {
  if (!spec || spec === 'latest') return 'Siempre la última instalada';
  if (spec === 'system') return 'La del sistema';
  if (/^\d+$/.test(spec)) return `Última ${spec}.x instalada`;
  return `Node.js ${spec}`;
}

/** Resolves a site's version or explains how to fix it. */
export function siteNode(site: { node_version: string }): NodeInstall {
  const n = resolveNode(site.node_version);
  if (n) return n;
  const wanted = describeSpec(site.node_version);
  throw new Error(
    `${wanted} no está instalada en este servidor. Instálala en ${NODE_DIR}/<versión> (o desde Sistema → Node.js) o elige otra versión en la configuración del sitio.`,
  );
}

export const nodePathEnv = (n: NodeInstall) => `${n.bin}:${BASE_PATH}`;

/** Sites that need Node (Node apps, or any site with a build step) and what they resolve to. */
export function nodeUsage(): Record<string, { id: number; name: string; spec: string }[]> {
  const rows = all<{ id: number; name: string; type: string; build_command: string; install_command: string; node_version: string; source: string }>(
    'SELECT id, name, type, build_command, install_command, node_version, source FROM sites',
  );
  const list = installedNodeVersions();
  const usage: Record<string, { id: number; name: string; spec: string }[]> = {};
  for (const r of rows) {
    if (r.source === 'wordpress') continue;
    if (r.type !== 'node' && !r.build_command && !/\b(npm|npx|yarn|pnpm|node)\b/.test(r.install_command)) continue;
    const n = resolveNode(r.node_version, list);
    const key = n?.version ?? 'missing';
    (usage[key] ??= []).push({ id: r.id, name: r.name, spec: r.node_version || 'latest' });
  }
  return usage;
}

// --- optional install from the panel (official binaries from nodejs.org) ---------------------

const nodeArch = () => ({ x64: 'x64', arm64: 'arm64' })[arch() as 'x64' | 'arm64'] ?? 'x64';

interface DistEntry {
  version: string;
  date: string;
  lts: string | false;
  security: boolean;
}
let distCache: { at: number; list: DistEntry[] } | null = null;

export async function availableNodeVersions(): Promise<{ major: string; latest: string; lts: string | false; date: string }[]> {
  if (!distCache || Date.now() - distCache.at > 3600_000) {
    try {
      const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) });
      distCache = { at: Date.now(), list: (await res.json()) as DistEntry[] };
    } catch {
      if (!distCache) return [];
    }
  }
  const byMajor = new Map<string, { major: string; latest: string; lts: string | false; date: string }>();
  for (const e of distCache!.list) {
    const v = e.version.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue; // skip pre-releases (alpha, rc, nightly)
    const major = v.split('.')[0]!;
    if (Number(major) < 18 || byMajor.has(major)) continue;
    byMajor.set(major, { major, latest: v, lts: e.lts, date: e.date });
  }
  return [...byMajor.values()].sort((a, b) => Number(b.major) - Number(a.major)).slice(0, 6);
}

export async function installNode(version: string, log: JobLog) {
  if (!VERSION_RE.test(version)) throw new Error(`Versión no válida: ${version}`);
  const v = version.replace(/^v/, '');
  const target = join(NODE_DIR, v);
  if (config.dev) {
    log(`[dev] descargando node-v${v}-linux-${nodeArch()}.tar.xz en ${target}`);
    await new Promise((r) => setTimeout(r, 1200));
    devInstalled.set(v, { version: v, bin: join(target, 'bin'), source: 'HostPanel / manual', system: false, removable: true });
    return;
  }
  if (existsSync(join(target, 'bin', 'node'))) throw new Error(`Node.js ${v} ya está instalado en ${target}`);
  const file = `node-v${v}-linux-${nodeArch()}.tar.xz`;
  const url = `https://nodejs.org/dist/v${v}/${file}`;
  log(`$ curl ${url}`);
  await exec('sh', ['-c', `set -e
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/${file}" "${url}"
curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v${v}/SHASUMS256.txt"
(cd "$tmp" && grep " ${file}\\$" SHASUMS256.txt | sha256sum -c -)
mkdir -p "${target}"
tar -xJf "$tmp/${file}" -C "${target}" --strip-components=1
chown -R root:root "${target}"
chmod -R a+rX "${target}"`], { onLine: log, timeoutMs: 10 * 60_000 });
  const out = await exec(join(target, 'bin', 'node'), ['--version']);
  installedNodeVersions(true);
  log(`✔ Node.js ${out.trim()} instalado en ${target}`);
}

export async function removeNode(version: string, log: JobLog) {
  const n = installedNodeVersions(true).find((x) => x.version === version);
  if (!n) throw new Error(`Node.js ${version} no está instalado`);
  if (!n.removable) throw new Error(`Node.js ${version} no está en ${NODE_DIR}: desinstálalo con la herramienta con la que lo instalaste (${n.source}).`);
  const users = nodeUsage()[version] ?? [];
  const pinned = users.filter((u) => u.spec === version);
  if (pinned.length) throw new Error(`Lo usan estos sitios: ${pinned.map((u) => u.name).join(', ')}. Cámbiales la versión antes.`);
  if (config.dev) {
    devInstalled.delete(version);
    log(`[dev] rm -rf ${join(NODE_DIR, version)}`);
    return;
  }
  log(`$ rm -rf ${join(NODE_DIR, version)}`);
  await tryExec('rm', ['-rf', join(NODE_DIR, version)]);
  installedNodeVersions(true);
  if (users.length) log(`Aviso: ${users.length} sitio(s) usarán otra versión en su próximo despliegue.`);
  log(`✔ Node.js ${version} eliminado`);
}

/**
 * Shell snippet for a remote node: makes sure the same version exists there
 * (downloads the official build into /opt/nodejs/<version> when missing).
 */
export function ensureNodeOnRemoteScript(n: NodeInstall) {
  if (n.system) return `command -v node >/dev/null || { echo "Este nodo no tiene Node.js"; exit 1; }`;
  const target = join(NODE_DIR, n.version);
  return `if [ ! -x ${target}/bin/node ]; then
  echo "Instalando Node.js ${n.version} en el nodo…"
  case "$(uname -m)" in aarch64|arm64) a=arm64 ;; *) a=x64 ;; esac
  f="node-v${n.version}-linux-$a.tar.xz"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$f" "https://nodejs.org/dist/v${n.version}/$f"
  mkdir -p ${target} && tar -xJf "$tmp/$f" -C ${target} --strip-components=1 && rm -rf "$tmp"
  chmod -R a+rX ${target}
fi`;
}

/** Where the version lives on a remote node (same layout as here). */
export const remoteNodeBin = (n: NodeInstall) => (n.system ? n.bin : join(NODE_DIR, n.version, 'bin'));
