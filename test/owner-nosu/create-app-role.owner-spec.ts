import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-134: docker/prod/create-app-role.sql, ejecutado como el owner sin
// superusuario, se puede repetir sin `-v app_password` cuando el rol de la app
// ya existe (no toca su contraseña) y, si no existe, la exige con un error
// claro en vez de un error de sintaxis de psql.
//
// `dentalix_app` es un rol del clúster que ya existe (lo creó el job): para
// probar el caso «no existe» se ejecuta una copia del script con otro nombre
// de rol, desechable.

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'docker/prod/create-app-role.sql');

/** psql no acepta el `?schema=public` de las URL de Prisma. */
const psqlUrl = (url: string): string => {
  const u = new URL(url);
  u.search = '';
  return u.toString();
};

describe('DX-134 · create-app-role.sql idempotente sin app_password (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx134_role_${process.pid}_${Date.now()}`;
  const appRole = `${env.owner}_app134`.slice(0, 63);
  const dir = mkdtempSync(join(tmpdir(), 'dx134-role-'));
  const copy = join(dir, 'create-app-role.sql');
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });

  function psql(
    url: string,
    args: string[],
  ): { status: number | null; out: string } {
    const r = spawnSync(
      'psql',
      [psqlUrl(url), '-X', '-v', 'ON_ERROR_STOP=1', ...args],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  const asOwner = (args: string[]) => psql(ownerUrlFor(env, db), args);

  function asApp(password: string, sql: string): string {
    const u = new URL(ownerUrlFor(env, db));
    u.username = appRole;
    u.password = password;
    return psql(u.toString(), ['-tAc', sql]).out.trim();
  }

  const canLogin = (password: string): boolean =>
    asApp(password, 'SELECT 1') === '1';

  async function roleExists(): Promise<boolean> {
    const rows = await admin.$queryRaw<
      unknown[]
    >`SELECT 1 FROM pg_roles WHERE rolname = ${appRole}`;
    return rows.length === 1;
  }

  beforeAll(async () => {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    writeFileSync(
      copy,
      readFileSync(SCRIPT, 'utf8').replaceAll('dentalix_app', appRole),
    );
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${appRole}"`);
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('el rol no existe y falta app_password: falla con un error claro y no crea nada', async () => {
    const r = asOwner(['-f', copy]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(
      `El rol ${appRole} no existe: pasa su contraseña con -v app_password=`,
    );
    expect(r.out).not.toMatch(/syntax error/);
    expect(await roleExists()).toBe(false);
  });

  it('el rol no existe y app_password está vacía: falla con el mismo error', async () => {
    const r = asOwner(['-v', 'app_password=', '-f', copy]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`El rol ${appRole} no existe`);
    expect(await roleExists()).toBe(false);
  });

  it('el rol no existe y app_password es solo espacios: falla igual', async () => {
    const r = asOwner(['-v', 'app_password=   ', '-f', copy]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`El rol ${appRole} no existe`);
    expect(await roleExists()).toBe(false);
  });

  it('con app_password crea el rol, que entra con esa contraseña', () => {
    const r = asOwner(['-v', 'app_password=primera-134', '-f', copy]);
    expect(r.out).toContain('CREATE ROLE');
    expect(r.status).toBe(0);
    expect(canLogin('primera-134')).toBe(true);
  });

  it('DX-236: repetir el script conserva SELECT sin reabrir escritura de referencia', async () => {
    expect(
      asOwner([
        '-c',
        'CREATE TABLE icd10_codes (code text); CREATE TABLE currencies (code text); CREATE TABLE countries (code text); CREATE TABLE cities (id int);',
      ]).status,
    ).toBe(0);
    const r = asOwner(['-f', copy]);
    expect(r.status).toBe(0);
    const target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    try {
      const rows = await target.$queryRaw<
        { table: string; read: boolean; write: boolean }[]
      >`
        SELECT c.relname AS table, has_table_privilege(${appRole}, c.oid, 'SELECT') AS read,
               has_table_privilege(${appRole}, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') AS write
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;
      expect(rows).toEqual(
        ['cities', 'countries', 'currencies', 'icd10_codes'].map((table) => ({
          table,
          read: true,
          write: false,
        })),
      );
    } finally {
      await target.$disconnect();
    }
  });

  it('repetido sin app_password: termina bien y no cambia la contraseña', () => {
    const r = asOwner(['-f', copy]);
    expect(r.out).not.toContain('CREATE ROLE');
    expect(r.status).toBe(0);
    expect(canLogin('primera-134')).toBe(true);
  });

  it('repetido con otra app_password: tampoco la cambia (no es un cambio de contraseña)', () => {
    const r = asOwner(['-v', 'app_password=otra-134', '-f', copy]);
    expect(r.status).toBe(0);
    expect(canLogin('primera-134')).toBe(true);
    expect(canLogin('otra-134')).toBe(false);
  });

  // DX-431 (OPS-012): el script fija los topes de la sesión de la app; los
  // comprueba conectado COMO la app (lo que ve una conexión nueva del pool).
  it('DX-431: la app arranca con statement_timeout 15s e idle_in_transaction_session_timeout 30s', () => {
    expect(asApp('primera-134', 'SHOW statement_timeout')).toBe('15s');
    expect(
      asApp('primera-134', 'SHOW idle_in_transaction_session_timeout'),
    ).toBe('30s');
  });

  it('DX-431: repetir el script devuelve los topes a su valor si alguien los quitó', async () => {
    await admin.$executeRawUnsafe(
      `ALTER ROLE "${appRole}" SET statement_timeout = 0`,
    );
    expect(asApp('primera-134', 'SHOW statement_timeout')).toBe('0');

    const r = asOwner(['-f', copy]);
    expect(r.status).toBe(0);
    expect(r.out).not.toContain('DX-431');
    expect(asApp('primera-134', 'SHOW statement_timeout')).toBe('15s');
  });

  it('el script real, sin app_password, sobre una base nueva con dentalix_app ya en el clúster', async () => {
    const r = asOwner(['-f', SCRIPT]);
    expect(r.status).toBe(0);
    const target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    try {
      const [row] = await target.$queryRaw<{ connect: boolean }[]>`
        SELECT has_database_privilege('dentalix_app', current_database(), 'CONNECT') AS connect`;
      expect(row.connect).toBe(true);
    } finally {
      await target.$disconnect();
    }
  });
});
