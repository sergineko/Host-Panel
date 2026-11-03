import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Branding {
  name: string;
  logo: string | null;
  color: string | null;
}

export const DEFAULT_NAME = 'HostPanel';

const CACHE_KEY = 'hp-branding';

/** Last branding seen in this browser, so the page doesn't flash the default colours. */
function cached(): Branding | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Branding) : undefined;
  } catch {
    return undefined;
  }
}

/** Name, logo and colour the panel shows (own branding on the Reseller plan). */
export function useBranding() {
  const q = useQuery({
    queryKey: ['branding-public'],
    queryFn: async () => {
      const b = await api.get<Branding>('/api/branding/public');
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(b));
      } catch {
        /* private mode */
      }
      return b;
    },
    placeholderData: cached,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return q.data ?? { name: DEFAULT_NAME, logo: null, color: null };
}

/** Black or white text, whichever reads better on the colour. */
function textOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  return lum > 0.45 ? '#111111' : '#ffffff';
}

/** Applies the branding to the whole document: tab title and accent colour. */
export function BrandingEffect() {
  const b = useBranding();
  useEffect(() => {
    document.title = b.name;
    const root = document.documentElement.style;
    if (b.color) {
      root.setProperty('--accent', b.color);
      root.setProperty('--accent-fg', textOn(b.color));
      root.setProperty('--accent-soft', `color-mix(in srgb, ${b.color} 14%, transparent)`);
    } else {
      for (const v of ['--accent', '--accent-fg', '--accent-soft']) root.removeProperty(v);
    }
  }, [b.name, b.color]);
  return null;
}
