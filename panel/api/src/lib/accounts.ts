/**
 * Rules for panel usernames and passwords (first-run setup and password changes).
 *
 * Usernames: bots try "admin", "root" and friends on every panel they find, so those are
 * refused. A non-obvious name is best; an email address is allowed too.
 * Passwords: at least 12 characters with three kinds of character, or a passphrase of 16+.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Names that brute-force bots try first. */
const RESERVED = new Set([
  'admin', 'administrator', 'administrador', 'admins', 'root', 'superuser', 'super', 'sysadmin', 'system', 'sistema',
  'user', 'usuario', 'test', 'tester', 'guest', 'invitado', 'demo', 'default', 'master', 'manager', 'operator', 'owner',
  'hostpanel', 'panel', 'cpanel', 'webmin', 'plesk', 'webmaster', 'hostmaster', 'postmaster', 'support', 'soporte',
  'info', 'mail', 'ubuntu', 'debian', 'pi', 'oracle', 'ftp', 'www', 'web', 'server', 'servidor', 'backup', 'dev',
]);

const COMMON_PASSWORDS = [
  'password', 'contraseña', 'contrasena', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', 'letmein', 'welcome', 'bienvenido',
  'iloveyou', 'monkey', 'dragon', 'football', 'futbol', 'baseball', 'superman', 'batman', 'trustno1', 'sunshine', 'princess',
  'abc123', '123456', '654321', '111111', '000000', 'passw0rd', 'p@ssw0rd', 'hostpanel', 'changeme', 'secret', 'secreto',
];

export function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

/** Error message, or null when the username is acceptable. */
export function usernameProblem(raw: string): string | null {
  const name = normalizeUsername(raw);
  if (!name) return 'Escribe un nombre de usuario';
  if (name.includes('@')) {
    if (!EMAIL_RE.test(name) || name.length > 120) return 'El correo electrónico no es válido';
    if (RESERVED.has(name.split('@')[0]!)) return 'Elige un correo menos evidente que admin@…, root@… o similares';
    return null;
  }
  if (!NAME_RE.test(name)) return 'Usa de 3 a 32 letras minúsculas, números, puntos, guiones o guiones bajos (o un correo electrónico)';
  const bare = name.replace(/[._-]?\d+$/, '');
  if (RESERVED.has(name) || RESERVED.has(bare)) return `«${name}» es de los primeros nombres que prueban los ataques automáticos. Elige otro menos evidente`;
  return null;
}

export const isEmail = (value: string) => EMAIL_RE.test(value.trim());

/** Error message, or null when the password is strong enough. */
export function passwordProblem(password: string, username = ''): string | null {
  if (password.length < 12) return 'La contraseña debe tener al menos 12 caracteres';
  if (password.length > 256) return 'La contraseña es demasiado larga';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (password.length < 16 && classes < 3) {
    return 'Combina al menos tres tipos de carácter (minúsculas, mayúsculas, números, símbolos) o usa una frase de 16 caracteres o más';
  }
  if (new Set(password).size < 6) return 'La contraseña repite demasiado los mismos caracteres';
  const lower = password.toLowerCase();
  const user = normalizeUsername(username).split('@')[0] ?? '';
  if (user.length >= 3 && lower.includes(user)) return 'La contraseña no puede contener el nombre de usuario';
  if (COMMON_PASSWORDS.some((w) => lower.includes(w))) return 'La contraseña contiene una palabra muy común (password, qwerty, 123456…)';
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/.test(lower)) return 'Evita secuencias como 1234 o abcd';
  return null;
}
