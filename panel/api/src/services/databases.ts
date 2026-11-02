/** MariaDB management through the local unix socket (root uses unix_socket auth). */
import mysql from 'mysql2/promise';
import { config } from '../config.ts';
import { HttpError } from '../lib/validate.ts';

async function withRoot<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  if (config.dev) return undefined as T;
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({ socketPath: config.mysqlSocket, user: 'root' });
  } catch {
    throw new HttpError(502, 'No se pudo conectar con MariaDB');
  }
  try {
    return await fn(conn);
  } finally {
    await conn.end();
  }
}

// Names are validated with a strict regex before reaching here; identifiers are also escaped.
const ident = (s: string) => `\`${s.replace(/`/g, '')}\``;

export async function createDatabase(name: string, username: string, password: string) {
  await withRoot(async (c) => {
    await c.query(`CREATE DATABASE ${ident(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [username, 'localhost', password]);
    await c.query(`GRANT ALL PRIVILEGES ON ${ident(name)}.* TO ?@?`, [username, 'localhost']);
    await c.query('FLUSH PRIVILEGES');
  });
}

export async function dropDatabase(name: string, username: string) {
  await withRoot(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(name)}`);
    await c.query('DROP USER IF EXISTS ?@?', [username, 'localhost']);
  });
}

export async function resetDatabasePassword(username: string, password: string) {
  await withRoot(async (c) => {
    await c.query('ALTER USER ?@? IDENTIFIED BY ?', [username, 'localhost', password]);
  });
}

export async function databaseSizes(): Promise<Record<string, number>> {
  const rows = await withRoot(async (c) => {
    const [r] = await c.query(
      'SELECT table_schema AS name, SUM(data_length + index_length) AS size FROM information_schema.tables GROUP BY table_schema',
    );
    return r as { name: string; size: number }[];
  });
  return Object.fromEntries((rows ?? []).map((r) => [r.name, Number(r.size)]));
}
