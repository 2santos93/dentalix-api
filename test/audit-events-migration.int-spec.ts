import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// DX-102: la migración que convierte audit_events en tabla particionada no
// pierde filas. Una BD desechable recibe todas las migraciones ANTERIORES,
// se llena con eventos de varios meses y dos clínicas, y luego se aplica la
// de DX-102: mismas filas, mismo contenido, cada una en su partición.

const MIGRATION = '20261017130000_audit_events_partitioned';
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

describe('DX-102 · migración de audit_events con datos (int)', () => {
  const db = `dx102_mig_${process.pid}_${Date.now()}`;
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let target: PrismaClient;
  let dir: string;

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx102-'));
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
    target = new PrismaClient({ datasources: { db: { url: urlFor(db) } } });
  }, 180_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('convierte la tabla con datos previos sin perder ni alterar filas', async () => {
    // Tabla de DX-009 (sin particionar) con 3 años de eventos de dos clínicas.
    await target.$executeRawUnsafe(`
      INSERT INTO "audit_events"
        ("id","tenantId","locationId","actorUserId","actorRole","action",
         "resourceType","resourceId","patientId","requestId","ip","userAgent",
         "occurredAt","metadata")
      SELECT gen_random_uuid(),
             CASE WHEN g % 2 = 0 THEN '00000000-0000-4000-8000-00000000000a'::uuid
                  ELSE '00000000-0000-4000-8000-00000000000b'::uuid END,
             NULL,
             CASE WHEN g % 50 = 0 THEN NULL ELSE gen_random_uuid() END,
             CASE WHEN g % 50 = 0 THEN NULL ELSE 'ADMIN'::"ClinicRole" END,
             CASE WHEN g % 50 = 0 THEN 'LOGIN_FAILED'::"AuditAction"
                  WHEN g % 7 = 0 THEN 'VOID'::"AuditAction"
                  ELSE 'VIEW'::"AuditAction" END,
             'PATIENT'::"AuditResourceType", NULL, gen_random_uuid(),
             'req-' || g, '10.0.0.1', 'jest',
             date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(days => g % 1100),
             jsonb_build_object('n', g)
      FROM generate_series(1, 3000) AS g`);
    const before = await target.$queryRaw<{ n: bigint; h: string }[]>`
      SELECT count(*) AS n, md5(string_agg(t::text, ',' ORDER BY t.id)) AS h
      FROM "audit_events" t`;
    expect(Number(before[0].n)).toBe(3000);

    cpSync(
      join(ROOT, 'prisma/migrations', MIGRATION),
      join(dir, 'migrations', MIGRATION),
      { recursive: true },
    );
    migrateDeploy(dir, urlFor(db));

    const [kind] = await target.$queryRaw<{ kind: string }[]>`
      SELECT relkind::text AS kind FROM pg_class
      WHERE oid = 'public.audit_events'::regclass`;
    expect(kind.kind).toBe('p');
    const after = await target.$queryRaw<{ n: bigint; h: string }[]>`
      SELECT count(*) AS n, md5(string_agg(t::text, ',' ORDER BY t.id)) AS h
      FROM "audit_events" t`;
    expect(after).toEqual(before);
    // Ninguna fila histórica quedó en DEFAULT: hay partición para cada mes.
    const [inDefault] = await target.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "audit_events_default"`;
    expect(Number(inDefault.n)).toBe(0);
    // La tabla antigua no queda colgando.
    const [legacy] = await target.$queryRaw<{ r: string | null }[]>`
      SELECT to_regclass('public.audit_events_dx009')::text AS r`;
    expect(legacy.r).toBeNull();
  }, 180_000);
});
