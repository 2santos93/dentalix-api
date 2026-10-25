import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

// SEC-009: la migración que sustituye el único de host (todos los vivos) por
// uno solo de VERIFIED vivos, añade el único (tenantId, host) y la caducidad
// de los PENDING. Una BD desechable recibe todas las migraciones ANTERIORES,
// se llena con dominios en todos los estados y se aplica la nueva: ninguna
// fila se pierde ni cambia salvo "expiresAt" de las PENDING. Si hubiera
// duplicados que rompieran los índices nuevos, la migración aborta con el
// desglose sin crear nada ni tocar datos.

const MIGRATION = '20261017234400_sec009_tenant_domain_verified_unique';
const ROOT = join(__dirname, '..');

function urlFor(db: string): string {
  const url = new URL(process.env.DIRECT_URL as string);
  url.pathname = `/${db}`;
  return url.toString();
}

function migrateDeploy(dir: string, url: string): void {
  execFileSync(
    join(ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
      stdio: 'pipe',
    },
  );
}

const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000b2';

// Dominios como los dejaba el código anterior (sin las columnas nuevas).
const SEED = [
  `INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt") VALUES
    ('${T1}', 'Clínica Uno', 'sec009-mig-uno', now()),
    ('${T2}', 'Clínica Dos', 'sec009-mig-dos', now())`,
  `INSERT INTO "tenant_domains"
    ("id", "tenantId", "host", "status", "verifyToken", "verifiedAt",
     "createdAt", "updatedAt", "deletedAt")
  VALUES
    ('10000000-0000-4000-8000-000000000001', '${T1}', 'citas.uno.com',
     'VERIFIED', 'tok-1', '2026-08-01T10:00:00Z', '2026-08-01T09:00:00Z', now(), NULL),
    ('10000000-0000-4000-8000-000000000002', '${T1}', 'citas.squat.com',
     'PENDING', 'tok-2', NULL, '2026-08-02T09:00:00Z', now(), NULL),
    ('10000000-0000-4000-8000-000000000003', '${T2}', 'citas.uno.com',
     'VERIFIED', 'tok-3', '2026-07-01T10:00:00Z', '2026-07-01T09:00:00Z', now(),
     '2026-07-15T00:00:00Z'),
    ('10000000-0000-4000-8000-000000000004', '${T2}', 'citas.dos.com',
     'PENDING', 'tok-4', NULL, '2026-10-17T00:00:00Z', now(), NULL)`,
];

const ORIGINAL_COLUMNS = `"id", "tenantId", "host", "status", "verifyToken",
  "verifiedAt", "createdAt", "updatedAt", "deletedAt"`;

interface Scenario {
  db: string;
  dir: string;
  target: PrismaClient;
}

describe('SEC-009 · migración de tenant_domains con datos (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  const scenarios: Scenario[] = [];

  /** BD desechable con todas las migraciones ANTERIORES y los dominios. */
  async function prepare(tag: string): Promise<Scenario> {
    const db = `sec009_mig_${tag}_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    const dir = mkdtempSync(join(tmpdir(), 'sec009-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    for (const name of readdirSync(join(ROOT, 'prisma/migrations'))) {
      if (name < MIGRATION && !name.endsWith('.toml')) {
        cpSync(
          join(ROOT, 'prisma/migrations', name),
          join(dir, 'migrations', name),
          { recursive: true },
        );
      }
    }
    migrateDeploy(dir, urlFor(db));
    const target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    const scenario = { db, dir, target };
    scenarios.push(scenario);
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
    return scenario;
  }

  function applyMigration({ dir, db }: Scenario): void {
    cpSync(
      join(ROOT, 'prisma/migrations', MIGRATION),
      join(dir, 'migrations', MIGRATION),
      { recursive: true },
    );
    migrateDeploy(dir, urlFor(db));
  }

  async function fingerprint(target: PrismaClient) {
    return target.$queryRawUnsafe<{ n: bigint; h: string }[]>(
      `SELECT count(*) AS n,
              md5(string_agg(row(${ORIGINAL_COLUMNS})::text, ',' ORDER BY "id")) AS h
         FROM "tenant_domains"`,
    );
  }

  async function indexes(target: PrismaClient): Promise<string[]> {
    const rows = await target.$queryRaw<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'tenant_domains'
       ORDER BY indexname`;
    return rows.map((r) => r.name);
  }

  afterAll(async () => {
    for (const s of scenarios) {
      await s.target.$disconnect();
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${s.db}" WITH (FORCE)`,
      );
      rmSync(s.dir, { recursive: true, force: true });
    }
    await admin.$disconnect();
  }, 60_000);

  it('sin duplicados: conserva todas las filas, caduca los PENDING a las 72 h de su alta y cambia los índices', async () => {
    const scenario = await prepare('ok');
    const { target } = scenario;
    const before = await fingerprint(target);
    expect(Number(before[0].n)).toBe(4);

    applyMigration(scenario);

    expect(await fingerprint(target)).toEqual(before);
    const rows = await target.$queryRaw<
      {
        id: string;
        status: string;
        expiresAt: Date | null;
        failedChecks: number;
        lastCheckedAt: Date | null;
        disabledAt: Date | null;
      }[]
    >`
      SELECT "id"::text, "status"::text, "expiresAt", "failedChecks",
             "lastCheckedAt", "disabledAt"
        FROM "tenant_domains" ORDER BY "id"`;
    expect(rows).toEqual([
      expect.objectContaining({ status: 'VERIFIED', expiresAt: null }),
      expect.objectContaining({
        status: 'PENDING',
        expiresAt: new Date('2026-08-05T09:00:00Z'),
      }),
      expect.objectContaining({ status: 'VERIFIED', expiresAt: null }),
      expect.objectContaining({
        status: 'PENDING',
        expiresAt: new Date('2026-10-20T00:00:00Z'),
      }),
    ]);
    expect(
      rows.every(
        (r) =>
          r.failedChecks === 0 &&
          r.lastCheckedAt === null &&
          r.disabledAt === null,
      ),
    ).toBe(true);
    expect(await indexes(target)).toEqual([
      'tenant_domains_host_idx',
      'tenant_domains_pkey',
      'tenant_domains_tenantId_idx',
      'tenant_domains_tenant_host_key',
      'tenant_domains_verified_host_key',
    ]);
    // Ahora otra clínica puede tener en PENDING el host que la 1 tiene en
    // PENDING (antes: violación del único de host).
    await expect(
      target.$executeRawUnsafe(`
        INSERT INTO "tenant_domains" ("id", "tenantId", "host", "verifyToken", "updatedAt")
        VALUES (gen_random_uuid(), '${T2}', 'citas.squat.com', 'tok-5', now())`),
    ).resolves.toBe(1);
  }, 180_000);

  it('con duplicados que romperían los índices nuevos: aborta con el desglose, sin crear índices ni tocar datos', async () => {
    const scenario = await prepare('dups');
    const { target } = scenario;
    // Solo en esta BD desechable: sin el único anterior, alguien coló a mano
    // dos VERIFIED vivos del mismo host (T1 y T2) y el mismo host dos veces
    // en T2 (citas.dos.com; su otro citas.uno.com está borrado y no cuenta).
    await target.$executeRawUnsafe('DROP INDEX "tenant_domains_host_key"');
    await target.$executeRawUnsafe(`
      INSERT INTO "tenant_domains" ("id", "tenantId", "host", "status", "verifyToken", "updatedAt")
      VALUES (gen_random_uuid(), '${T2}', 'citas.uno.com', 'VERIFIED', 'dup-1', now()),
             (gen_random_uuid(), '${T2}', 'citas.dos.com', 'PENDING', 'dup-2', now())`);
    const before = await fingerprint(target);

    let message = '';
    try {
      applyMigration(scenario);
    } catch (error) {
      const e = error as { stdout?: Buffer; stderr?: Buffer; message: string };
      message = `${e.message}${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
    }
    expect(message).toContain('SEC-009: hay dominios duplicados');
    expect(message).toContain('hosts VERIFIED vivos repetidos: 1');
    expect(message).toContain('(tenantId, host) vivos repetidos: 1');

    expect(await fingerprint(target)).toEqual(before);
    expect(await indexes(target)).toEqual([
      'tenant_domains_pkey',
      'tenant_domains_tenantId_idx',
    ]);
    const [col] = await target.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
       WHERE table_name = 'tenant_domains' AND column_name = 'expiresAt'`;
    expect(Number(col.n)).toBe(0);
  }, 180_000);
});
