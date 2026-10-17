import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// DX-128: la migración del canal de contacto con datos previos. Una BD
// desechable recibe todas las migraciones ANTERIORES, se llena con pacientes
// de dos clínicas (con y sin móvil, uno retirado) y eventos de auditoría, y
// luego se aplica la de DX-128: los pacientes quedan con el canal por defecto
// de su clínica (EMAIL), sin opt-in de WhatsApp ni baja, y el teléfono (el
// del botón wa.me manual) intacto; la auditoría no pierde filas.

const MIGRATION = '20261017233300_dx128_contact_channel';
const ROOT = join(__dirname, '..');

const T_A = '00000000-0000-4000-8000-00000000a128';
const T_B = '00000000-0000-4000-8000-00000000b128';

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

const SEED = [
  `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
     ('${T_A}','Clínica A','dx128-mig-a',now()),
     ('${T_B}','Clínica B','dx128-mig-b',now())`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","phone","email","updatedAt","deletedAt") VALUES
     (gen_random_uuid(),'${T_A}','Ana','Uno','310 123 4567','ana@example.com',now(),NULL),
     (gen_random_uuid(),'${T_A}','Beto','Dos',NULL,NULL,now(),NULL),
     (gen_random_uuid(),'${T_A}','Ceci','Tres','llamar a la mamá',NULL,now(),now()),
     (gen_random_uuid(),'${T_B}','Dani','Cuatro','+34 612 34 56 78','dani@example.com',now(),NULL)`,
  `INSERT INTO "audit_events"
     ("id","tenantId","actorUserId","actorRole","action","resourceType","occurredAt","metadata")
   SELECT gen_random_uuid(), '${T_A}', gen_random_uuid(), 'ADMIN', 'VIEW', 'PATIENT',
          date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(days => g * 11),
          jsonb_build_object('n', g)
     FROM generate_series(1, 30) AS g`,
];

describe('DX-128 · migración del canal de contacto con datos (int)', () => {
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  const db = `dx128_mig_${process.pid}_${Date.now()}`;
  let dir: string;
  let target: PrismaClient;

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx128-'));
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
    for (const sql of SEED) await target.$executeRawUnsafe(sql);
  }, 180_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  });

  it('migra los pacientes con el canal de su clínica, sin opt-in ni baja, y no toca el teléfono', async () => {
    const phonesBefore = await target.$queryRaw<
      { firstName: string; phone: string | null }[]
    >`SELECT "firstName", "phone" FROM "patients" ORDER BY "firstName"`;
    const [auditBefore] = await target.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "audit_events"`;

    cpSync(
      join(ROOT, 'prisma/migrations', MIGRATION),
      join(dir, 'migrations', MIGRATION),
      { recursive: true },
    );
    migrateDeploy(dir, urlFor(db));

    const tenants = await target.$queryRaw<
      { id: string; channel: string }[]
    >`SELECT "id"::text, "defaultContactChannel"::text AS channel
        FROM "tenants" ORDER BY "id"`;
    expect(tenants).toEqual([
      { id: T_A, channel: 'EMAIL' },
      { id: T_B, channel: 'EMAIL' },
    ]);

    const patients = await target.$queryRaw<
      {
        firstName: string;
        phone: string | null;
        channel: string;
        optIn: Date | null;
        optInSource: string | null;
        optInBy: string | null;
        optOut: Date | null;
        optOutSource: string | null;
      }[]
    >`SELECT "firstName", "phone", "contactChannel"::text AS channel,
             "whatsappOptInAt" AS "optIn", "whatsappOptInSource"::text AS "optInSource",
             "whatsappOptInById"::text AS "optInBy",
             "reminderOptOutAt" AS "optOut", "reminderOptOutSource"::text AS "optOutSource"
        FROM "patients" ORDER BY "firstName"`;
    expect(patients).toHaveLength(4);
    for (const p of patients) {
      expect(p).toMatchObject({
        channel: 'EMAIL',
        optIn: null,
        optInSource: null,
        optInBy: null,
        optOut: null,
        optOutSource: null,
      });
    }
    expect(
      patients.map(({ firstName, phone }) => ({ firstName, phone })),
    ).toEqual(phonesBefore);

    const [auditAfter] = await target.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "audit_events"`;
    expect(auditAfter.n).toBe(auditBefore.n);

    // La regla del backfill: una clínica con otro canal por defecto deja a
    // sus pacientes con ese canal (la misma sentencia de la migración).
    await target.$executeRawUnsafe(
      `UPDATE "tenants" SET "defaultContactChannel" = 'NONE' WHERE "id" = '${T_B}'`,
    );
    await target.$executeRawUnsafe(`
      UPDATE "patients" p
         SET "contactChannel" = t."defaultContactChannel"
        FROM "tenants" t
       WHERE t."id" = p."tenantId"
         AND p."contactChannel" IS DISTINCT FROM t."defaultContactChannel"`);
    const byTenant = await target.$queryRaw<
      { tenant: string; channel: string }[]
    >`
      SELECT DISTINCT "tenantId"::text AS tenant, "contactChannel"::text AS channel
        FROM "patients" ORDER BY 1`;
    expect(byTenant).toEqual([
      { tenant: T_A, channel: 'EMAIL' },
      { tenant: T_B, channel: 'NONE' },
    ]);

    // Las CHECK nuevas: fecha y origen juntos.
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "patients" SET "whatsappOptInAt" = now() WHERE "tenantId" = '${T_A}'`,
      ),
    ).rejects.toThrow(/patients_whatsapp_opt_in_check/);
    await expect(
      target.$executeRawUnsafe(
        `UPDATE "patients" SET "reminderOptOutSource" = 'LINK' WHERE "tenantId" = '${T_A}'`,
      ),
    ).rejects.toThrow(/patients_reminder_opt_out_check/);

    // Y el CHECK de auditoría quedó VALIDADO (no NOT VALID).
    const [check] = await target.$queryRaw<{ validated: boolean }[]>`
      SELECT convalidated AS validated FROM pg_constraint
       WHERE conname = 'audit_events_actor_check'
         AND conrelid = 'public.audit_events'::regclass`;
    expect(check.validated).toBe(true);
  }, 180_000);
});
