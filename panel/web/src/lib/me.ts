import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export type Role = 'owner' | 'admin' | 'client';

export interface Me {
  username: string;
  email: string;
  totp: boolean;
  recovery_codes_left: number;
  role: Role;
  client: { id: number; name: string } | null;
  setup_pending: boolean;
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me'), staleTime: 60_000 });

/** Sections a reseller's client can open (the API enforces the same, see access.ts). */
export const CLIENT_SECTIONS = ['/', '/sites', '/domains', '/mail', '/databases', '/settings'];

export const isStaffRole = (role: Role | undefined) => role === 'owner' || role === 'admin';

export function clientCanOpen(pathname: string) {
  return CLIENT_SECTIONS.some((s) => (s === '/' ? pathname === '/' : pathname === s || pathname.startsWith(`${s}/`)));
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Titular', admin: 'Equipo', client: 'Cliente' };
