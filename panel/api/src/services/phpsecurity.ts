/**
 * Only PHP builds with the "PHP2Shell" fixes are allowed (CVE-2026-109618 and CVE-2026-109619,
 * unauthenticated remote code execution, fixed upstream on 21 October 2026).
 *
 * A build counts as fixed when:
 *   - its upstream version is at least the fixed release of its branch, or
 *   - its Debian/Ubuntu package changelog mentions both CVEs (distributions backport the fix
 *     without changing the upstream version number; PHP 7.4/8.0/8.1 only get it this way).
 *
 * Results are cached: they are checked at start-up and after installing or upgrading PHP.
 */
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { config } from '../config.ts';
import { tryExec } from '../lib/exec.ts';

export const PHP2SHELL_CVES = ['CVE-2026-109618', 'CVE-2026-109619'] as const;

/** First fixed upstream release of each supported branch. */
export const PHP2SHELL_FIXED: Record<string, string> = {
  '8.2': '8.2.35',
  '8.3': '8.3.36',
  '8.4': '8.4.27',
  '8.5': '8.5.12',
};

export interface PhpSecurity {
  /** Upstream version reported by PHP, e.g. 8.4.27. */
  version: string;
  patched: boolean;
  /** How the fix was detected. */
  via: 'version' | 'backport' | null;
}

const cache = new Map<string, PhpSecurity>();

/** -1, 0 or 1 comparing dotted version numbers. */
export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Fixed by version number alone (for a branch with an official fixed release). */
export function versionHasFix(branch: string, version: string) {
  const fixed = PHP2SHELL_FIXED[branch];
  return !!fixed && compareVersions(version, fixed) >= 0;
}

/** The package changelog lists both CVEs (backported fix). */
export function changelogHasFix(text: string) {
  return PHP2SHELL_CVES.every((cve) => text.includes(cve));
}

function packageChangelog(branch: string) {
  for (const pkg of [`php${branch}-common`, `php${branch}-fpm`, `php${branch}-cli`]) {
    const file = `/usr/share/doc/${pkg}/changelog.Debian.gz`;
    if (!existsSync(file)) continue;
    try {
      return gunzipSync(readFileSync(file)).toString('utf8');
    } catch {
      /* try the next one */
    }
  }
  return '';
}

/** Checks the installed build of a branch and remembers the result. */
export async function checkPhp(branch: string): Promise<PhpSecurity> {
  let result: PhpSecurity;
  if (config.dev) {
    // Development: pretend the installed builds are the fixed releases (old branches are not).
    const version = PHP2SHELL_FIXED[branch] ?? `${branch}.33`;
    result = { version, patched: versionHasFix(branch, version), via: versionHasFix(branch, version) ? 'version' : null };
  } else {
    const r = await tryExec(`php${branch}`, ['-r', 'echo PHP_VERSION;']);
    const version = r.ok ? r.output.trim().split('\n').pop()!.replace(/[^0-9.].*$/, '') : '';
    if (version && versionHasFix(branch, version)) result = { version, patched: true, via: 'version' };
    else if (changelogHasFix(packageChangelog(branch))) result = { version, patched: true, via: 'backport' };
    else result = { version, patched: false, via: null };
  }
  cache.set(branch, result);
  return result;
}

export async function checkAllPhp(branches: string[]) {
  for (const b of branches) await checkPhp(b);
}

export const phpSecurity = (branch: string) => cache.get(branch) ?? null;

/** A site may use this version (unknown = not checked yet, allowed so start-up doesn't block). */
export const phpAllowed = (branch: string) => cache.get(branch)?.patched ?? true;

export const PHP2SHELL_MESSAGE = (branch: string) =>
  `PHP ${branch} instalado no tiene corregida la vulnerabilidad PHP2Shell (${PHP2SHELL_CVES.join(', ')}). ` +
  'Actualízalo en Sistema → PHP o elige otra versión.';
