import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

// DX-102: la migración que convierte audit_events en tabla particionada no
// pierde filas. Una BD desechable recibe todas las migraciones ANTERIORES,
// se llena con eventos de varios meses y dos clínicas, y luego se aplica la
// de DX-102: mismas filas, mismo contenido, cada una en su partición.
// Se prueba con dos dueños de la tabla: el superusuario de los tests y un rol
// SIN superusuario ni BYPASSRLS (como el owner `dentalix` de producción). Con
// RLS FORCE ese owner leería 0 filas de la tabla vieja: la copia no puede
// quedar vacía en silencio (revisión DX-102).

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

const SEED_EVENTS = `
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
  FROM generate_series(1, 3000) AS g`;

interface Scenario {
  db: string;
  dir: string;
  target: PrismaClient;
}

describe('DX-102 · migración de audit_events con datos (int)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  const scenarios: Scenario[] = [];

  /** BD desechable con todas las migraciones ANTERIORES y 3.000 eventos. */
  async function prepare(tag: string): Promise<Scenario> {
    const db = `dx102_mig_${tag}_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    const dir = mkdtempSync(join(tmpdir(), 'dx102-'));
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
    await target.$executeRawUnsafe(SEED_EVENTS);
    return scenario;
  }

  async function fingerprint(target: PrismaClient) {
    return target.$queryRaw<{ n: bigint; h: string }[]>`
      SELECT count(*) AS n, md5(string_agg(t::text, ',' ORDER BY t.id)) AS h
      FROM "audit_events" t`;
  }

  async function expectConverted(target: PrismaClient, before: unknown) {
    const [kind] = await target.$queryRaw<{ kind: string }[]>`
      SELECT relkind::text AS kind FROM pg_class
      WHERE oid = 'public.audit_events'::regclass`;
    expect(kind.kind).toBe('p');
    expect(await fingerprint(target)).toEqual(before);
    // Ninguna fila histórica quedó en DEFAULT: hay partición para cada mes.
    const [inDefault] = await target.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "audit_events_default"`;
    expect(Number(inDefault.n)).toBe(0);
    // La tabla antigua no queda colgando y el padre sigue con RLS FORCE.
    const [state] = await target.$queryRaw<
      { legacy: string | null; force: boolean }[]
    >`
      SELECT to_regclass('public.audit_events_dx009')::text AS legacy,
             relforcerowsecurity AS force
      FROM pg_class WHERE oid = 'public.audit_events'::regclass`;
    expect(state).toEqual({ legacy: null, force: true });
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
  });

  it('convierte la tabla con datos previos sin perder ni alterar filas', async () => {
    const { dir, db, target } = await prepare('su');
    const before = await fingerprint(target);
    expect(Number(before[0].n)).toBe(3000);

    cpSync(
      join(ROOT, 'prisma/migrations', MIGRATION),
      join(dir, 'migrations', MIGRATION),
      { recursive: true },
    );
    migrateDeploy(dir, urlFor(db));

    await expectConverted(target, before);
  }, 180_000);

  it('también cuando el owner NO es superusuario ni BYPASSRLS y la tabla tiene RLS FORCE', async () => {
    const { dir, db, target } = await prepare('owner');
    const before = await fingerprint(target);
    expect(Number(before[0].n)).toBe(3000);
    // Solo en esta BD desechable: la tabla pasa a un rol sin superusuario
    // (el de la app, que existe en todos los entornos de test) y la migración
    // corre como él, igual que la correría el owner de producción.
    await target.$executeRawUnsafe(
      'ALTER TABLE "audit_events" OWNER TO dentalix_app',
    );
    await target.$executeRawUnsafe(
      'GRANT CREATE ON SCHEMA public TO dentalix_app',
    );
    const sql = readFileSync(
      join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    mkdirSync(join(dir, 'migrations', MIGRATION));
    writeFileSync(
      join(dir, 'migrations', MIGRATION, 'migration.sql'),
      `SET ROLE dentalix_app;\n${sql}\nRESET ROLE;\n`,
    );
    migrateDeploy(dir, urlFor(db));

    await expectConverted(target, before);
    const [owner] = await target.$queryRaw<{ owner: string }[]>`
      SELECT relowner::regrole::text AS owner FROM pg_class
      WHERE oid = 'public.audit_events'::regclass`;
    expect(owner.owner).toBe('dentalix_app');
  }, 180_000);
});
