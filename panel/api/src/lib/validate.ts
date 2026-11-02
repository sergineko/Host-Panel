import { z } from 'zod';

export const DOMAIN_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;
export const HOST_RE = /^(\*\.)?(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/;

export const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(DOMAIN_RE, 'Dominio no válido');

export const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOST_RE, 'Hostname no válido');

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} no encontrado`);
export const badRequest = (msg: string) => new HttpError(400, msg);

/** Parses with zod and throws a 400 with the first readable message. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.');
    throw badRequest(path ? `${path}: ${issue?.message}` : (issue?.message ?? 'Datos no válidos'));
  }
  return result.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Returns the registered domain that contains the host (longest suffix match). */
export function matchDomain<T extends { name: string }>(host: string, domains: T[]): T | undefined {
  const clean = host.replace(/^\*\./, '');
  let best: T | undefined;
  for (const d of domains) {
    if (clean === d.name || clean.endsWith(`.${d.name}`)) {
      if (!best || d.name.length > best.name.length) best = d;
    }
  }
  return best;
}
