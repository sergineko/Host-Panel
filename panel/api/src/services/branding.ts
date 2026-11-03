/**
 * Own branding (Reseller plan): panel name, logo and accent colour instead of HostPanel's.
 * Saved settings are kept when the plan doesn't allow them, and come back after upgrading.
 */
import { getSetting, setSetting } from '../db.ts';
import { currentLicense } from './license.ts';

export interface Branding {
  name: string;
  /** data: URL (png, jpeg, webp or svg), or null for the default logo. */
  logo: string | null;
  /** #rrggbb, or null for the default orange. */
  color: string | null;
}

export const DEFAULT_BRANDING: Branding = { name: 'HostPanel', logo: null, color: null };

export function savedBranding(): Branding {
  try {
    return { ...DEFAULT_BRANDING, ...(JSON.parse(getSetting('branding') ?? '{}') as Partial<Branding>) };
  } catch {
    return DEFAULT_BRANDING;
  }
}

/** What the panel shows: the saved branding only if the plan includes it. */
export function activeBranding(): Branding & { custom: boolean } {
  if (!currentLicense().plan?.branding) return { ...DEFAULT_BRANDING, custom: false };
  const b = savedBranding();
  return { ...b, custom: b.name !== DEFAULT_BRANDING.name || !!b.logo || !!b.color };
}

export function saveBranding(b: Branding) {
  setSetting('branding', JSON.stringify(b));
}
