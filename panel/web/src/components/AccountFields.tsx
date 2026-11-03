import { cx } from './ui';

/** Same idea as the API rules (lib/accounts.ts); the server has the final word. */
const RESERVED = new Set([
  'admin', 'administrator', 'administrador', 'admins', 'root', 'superuser', 'super', 'sysadmin', 'system', 'sistema',
  'user', 'usuario', 'test', 'tester', 'guest', 'invitado', 'demo', 'default', 'master', 'manager', 'operator', 'owner',
  'hostpanel', 'panel', 'cpanel', 'webmin', 'plesk', 'webmaster', 'hostmaster', 'postmaster', 'support', 'soporte',
  'info', 'mail', 'ubuntu', 'debian', 'pi', 'oracle', 'ftp', 'www', 'web', 'server', 'servidor', 'backup', 'dev',
]);

export function usernameHint(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!name) return null;
  if (name.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(name)) return 'El correo electrónico no es válido';
    if (RESERVED.has(name.split('@')[0]!)) return 'Elige un correo menos evidente que admin@…';
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) return 'De 3 a 32 letras minúsculas, números, «.», «-» o «_»';
  if (RESERVED.has(name) || RESERVED.has(name.replace(/[._-]?\d+$/, ''))) return `«${name}» es de los primeros que prueban los ataques automáticos`;
  return null;
}

/** 0 (empty) … 4 (very strong) plus the first problem found. */
export function passwordStrength(pw: string, username = ''): { score: number; problem: string | null } {
  if (!pw) return { score: 0, problem: null };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const lower = pw.toLowerCase();
  const user = username.trim().toLowerCase().split('@')[0] ?? '';
  let problem: string | null = null;
  if (pw.length < 12) problem = `Faltan ${12 - pw.length} caracteres (mínimo 12)`;
  else if (pw.length < 16 && classes < 3) problem = 'Combina mayúsculas, minúsculas, números y símbolos, o usa una frase de 16+ caracteres';
  else if (new Set(pw).size < 6) problem = 'Repite demasiado los mismos caracteres';
  else if (user.length >= 3 && lower.includes(user)) problem = 'No puede contener el nombre de usuario';
  else if (/(password|contrase|qwerty|123456|abc123|letmein|admin)/.test(lower)) problem = 'Contiene una palabra muy común';
  else if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/.test(lower)) problem = 'Evita secuencias como 1234 o abcd';
  if (problem) return { score: 1, problem };
  const score = pw.length >= 20 && classes >= 3 ? 4 : pw.length >= 16 || classes === 4 ? 3 : 2;
  return { score, problem: null };
}

/** 24 random characters from four classes, without look-alikes (0/O, 1/l/I). */
export function generatePassword(length = 24) {
  const sets = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '-_.!@#%+=?'];
  const all = sets.join('');
  const rnd = (n: number) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0]! % n;
  };
  for (;;) {
    const chars = Array.from({ length }, () => all[rnd(all.length)]!);
    // Guarantee every class and no accidental sequence.
    if (sets.every((set) => chars.some((c) => set.includes(c))) && !passwordStrength(chars.join('')).problem) return chars.join('');
  }
}

export function StrengthMeter({ password, username }: { password: string; username?: string }) {
  const { score, problem } = passwordStrength(password, username);
  if (!password) return null;
  const labels = ['', 'Débil', 'Aceptable', 'Fuerte', 'Muy fuerte'];
  const tone = score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="mt-1.5" aria-live="polite">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={cx('h-1 flex-1 rounded-full transition-colors', i <= score ? tone : 'bg-surface-2')} />
        ))}
      </div>
      <div className={cx('mt-1 text-xs', problem ? 'text-danger' : 'text-muted')}>{problem ?? labels[score]}</div>
    </div>
  );
}
