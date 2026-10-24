import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-134: con RLS FORCE y un owner sin SUPERUSER ni BYPASSRLS, la validación
// de una FOREIGN KEY lee la hija y la referenciada con la RLS del owner. Sin
// `app.current_tenant` no ve ninguna fila de clínica:
//   - FORCE en la hija: `ADD FOREIGN KEY` y `VALIDATE CONSTRAINT` aceptan la
//     FK aunque haya filas huérfanas, en silencio;
//   - FORCE en la referenciada: la FK falla aunque todas las filas sean
//     válidas.
//
// Regla (README, «Despliegue: roles de la BD»): añadir o validar una FK cuenta
// como leer filas: NO FORCE en la hija y en la referenciada, en la misma
// transacción. Este spec carga una huérfana oculta (como admin) y comprueba,
// como el owner:
//   - con la regla, la migración falla de forma RUIDOSA por la huérfana y no
//     deja nada a medias (igual con VALIDATE CONSTRAINT);
//   - sin ella, la misma FK entra en silencio con la huérfana dentro;
//   - control positivo: con solo filas válidas, NO FORCE solo en la hija
//     falla, y la regla completa deja entrar la FK y devuelve FORCE.
// El lint test/migrations/fk-under-force.spec.ts impide lo segundo (y el fallo
// por la referenciada) en migraciones nuevas.

const ROOT = join(__dirname, '..', '..');

const T_A = '00000000-0000-4000-8000-0000000134a1';
const PARENT = '00000000-0000-4000-8000-0000000134a2';
const ORPHAN_PARENT = '00000000-0000-4000-8000-0000000134ff';

const POLICY = `USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)`;

const TABLES = `
CREATE TABLE "parents" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL);
CREATE TABLE "children" ("id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                         "tenantId" UUID NOT NULL, "parentId" UUID NOT NULL);
ALTER TABLE "parents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "parents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "parents" ${POLICY};
ALTER TABLE "children" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "children" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "children" ${POLICY};
`;

const ADD_FK = `ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;

/** La regla: NO FORCE antes y FORCE después, en la misma migración. */
const ADD_FK_WITH_RULE = `SET LOCAL lock_timeout = '5s';
ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "parents" NO FORCE ROW LEVEL SECURITY;
${ADD_FK}
ALTER TABLE "parents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;

describe('DX-134 · FK sobre tablas con FORCE y filas huérfanas ocultas al owner (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx134_fk_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx134-fk-'));
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;
  let owner: PrismaClient;

  function migration(name: string, sql: string): void {
    mkdirSync(join(dir, 'migrations', name), { recursive: true });
    writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql);
  }

  /** Prisma CLI como el owner; si falla, el error lleva su salida. */
  function prisma(args: string[]): void {
    try {
      execFileSync(
        join(ROOT, 'node_modules/.bin/prisma'),
        [...args, '--schema', join(dir, 'schema.prisma')],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            DATABASE_URL: ownerUrlFor(env, db),
            DIRECT_URL: ownerUrlFor(env, db),
          },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma ${args.join(' ')} falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
      );
    }
  }

  /**
   * SQL como el owner con psql: varias sentencias en un -c son UNA
   * transacción, y el error trae el DETAIL (la clave que falla), que el
   * cliente de Prisma no da.
   */
  function ownerSql(sql: string): { status: number | null; out: string } {
    const u = new URL(ownerUrlFor(env, db));
    u.search = '';
    const r = spawnSync(
      'psql',
      [u.toString(), '-X', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8' },
    );
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  /** Mensaje de error de `migrate deploy` ('' si no falla). */
  function deployError(): string {
    try {
      prisma(['migrate', 'deploy']);
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  }

  /** Estado visto por el admin (sin RLS). */
  async function snapshot(): Promise<{
    orphans: number;
    fk: boolean | null;
    force: string;
  }> {
    const [row] = await target.$queryRaw<
      { orphans: number; fk: boolean | null; force: string }[]
    >`
      SELECT (SELECT count(*)::int FROM "children" c
               WHERE NOT EXISTS (SELECT 1 FROM "parents" p WHERE p."id" = c."parentId")) AS orphans,
             (SELECT convalidated FROM pg_constraint
               WHERE conname = 'children_parentId_fkey') AS fk,
             (SELECT string_agg(relname || '=' || relforcerowsecurity, ',' ORDER BY relname)
                FROM pg_class WHERE relname IN ('children', 'parents')) AS force`;
    return row;
  }

  beforeAll(async () => {
    const [role] = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    // Si el owner saltara la RLS, la FK vería las huérfanas y no se probaría nada.
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations', 'migration_lock.toml'),
    );
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
    owner = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: ownerUrlFor(env, db) } },
    });

    migration('20990101000000_tablas', TABLES);
    prisma(['migrate', 'deploy']);
    // Como admin (superusuario: sin RLS): una hija válida y una huérfana.
    await target.$executeRawUnsafe(
      `INSERT INTO "parents" ("id","tenantId") VALUES ('${PARENT}','${T_A}')`,
    );
    await target.$executeRawUnsafe(
      `INSERT INTO "children" ("tenantId","parentId") VALUES
         ('${T_A}','${PARENT}'), ('${T_A}','${ORPHAN_PARENT}')`,
    );
  }, 120_000);

  afterAll(async () => {
    await owner?.$disconnect();
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('el owner no ve las filas: la RLS se las oculta', async () => {
    const [{ n }] = await owner.$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM "children"`;
    expect(n).toBe(0);
    expect(await snapshot()).toEqual({
      orphans: 1,
      fk: null,
      force: 'children=true,parents=true',
    });
  });

  it('con NO FORCE en la misma migración, ADD FOREIGN KEY falla de forma RUIDOSA y no deja nada a medias', async () => {
    migration('20990102000000_fk_con_regla', ADD_FK_WITH_RULE);
    const error = deployError();
    expect(error).toMatch(
      /violates foreign key constraint "children_parentId_fkey"/,
    );
    // Es la huérfana la que lo hace fallar, no la fila válida.
    expect(error).toContain(ORPHAN_PARENT);
    // Una migración es una transacción: ni FK ni FORCE quitado.
    expect(await snapshot()).toEqual({
      orphans: 1,
      fk: null,
      force: 'children=true,parents=true',
    });
    prisma([
      'migrate',
      'resolve',
      '--rolled-back',
      '20990102000000_fk_con_regla',
    ]);
    rmSync(join(dir, 'migrations', '20990102000000_fk_con_regla'), {
      recursive: true,
    });
  }, 120_000);

  it('con NO FORCE en las dos tablas, VALIDATE CONSTRAINT falla de forma ruidosa por la huérfana', async () => {
    await owner.$executeRawUnsafe(`${ADD_FK.replace(/;$/, '')} NOT VALID`);
    const r = ownerSql(`
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "parents" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" VALIDATE CONSTRAINT "children_parentId_fkey";
      ALTER TABLE "parents" FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/violates foreign key constraint/);
    // Es la huérfana la que lo hace fallar, no la fila válida.
    expect(r.out).toContain(`(${ORPHAN_PARENT}) is not present`);
    expect(await snapshot()).toEqual({
      orphans: 1,
      fk: false,
      force: 'children=true,parents=true',
    });
  });

  it('SIN NO FORCE, VALIDATE CONSTRAINT acepta la FK en silencio con la huérfana dentro', async () => {
    await owner.$executeRawUnsafe(
      `ALTER TABLE "children" VALIDATE CONSTRAINT "children_parentId_fkey"`,
    );
    expect(await snapshot()).toEqual({
      orphans: 1,
      fk: true,
      force: 'children=true,parents=true',
    });
    await owner.$executeRawUnsafe(
      `ALTER TABLE "children" DROP CONSTRAINT "children_parentId_fkey"`,
    );
  });

  it('SIN NO FORCE, la misma migración aplica ADD FOREIGN KEY en silencio con la huérfana dentro', async () => {
    migration('20990103000000_fk_sin_regla', ADD_FK);
    prisma(['migrate', 'deploy']);
    expect(await snapshot()).toEqual({
      orphans: 1,
      fk: true,
      force: 'children=true,parents=true',
    });
  }, 120_000);
  it('control positivo: con solo filas válidas, la regla completa deja entrar la FK y devuelve FORCE', async () => {
    await target.$executeRawUnsafe(
      `DELETE FROM "children" WHERE "parentId" = '${ORPHAN_PARENT}'`,
    );
    await owner.$executeRawUnsafe(
      `ALTER TABLE "children" DROP CONSTRAINT "children_parentId_fkey"`,
    );
    // NO FORCE solo en la hija NO basta: con FORCE en la referenciada el owner
    // no ve el padre y la FK falla con una fila VÁLIDA.
    const childOnly = ownerSql(`
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ${ADD_FK}
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`);
    expect(childOnly.status).not.toBe(0);
    expect(childOnly.out).toContain(
      `(${PARENT}) is not present in table "parents"`,
    );

    migration('20990104000000_fk_con_regla_ok', ADD_FK_WITH_RULE);
    expect(deployError()).toBe('');
    expect(await snapshot()).toEqual({
      orphans: 0,
      fk: true,
      force: 'children=true,parents=true',
    });
  }, 120_000);
});
