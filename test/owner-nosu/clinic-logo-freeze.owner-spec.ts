import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from '../support/location-fixtures';

// DX-019-bis (B) con un owner SIN superusuario ni BYPASSRLS: la RLS FORCE le
// aplica, así que el relleno del logo congelado solo ve las filas de cada
// clínica porque fija `app.current_tenant` clínica por clínica. Si no lo
// hiciera, las recetas y aceptaciones se quedarían NULL «sin logo» y la
// migración pasaría igual: aquí se comprueba el valor de cada clínica.
const ROOT = join(__dirname, '../..');
const MIGRATIONS = [
  '20261203090000_dx019b_clinic_logo_key',
  '20261203090100_dx019b_clinic_logo_key_backfill',
  '20261203090200_dx019b_clinic_logo_key_validate',
];
const SIGNATURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('DX-019-bis (B): logo congelado con owner sin superusuario', () => {
  const env = requireOwnerNosuEnv();
  const database = `dx019b_owner_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx019b-owner-'));
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let raw: PrismaClient;
  function deploy() {
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DIRECT_URL: ownerUrlFor(env, database),
          DATABASE_URL: ownerUrlFor(env, database),
        },
        stdio: 'pipe',
      },
    );
  }
  beforeAll(async () => {
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${database}" OWNER "${env.owner}"`,
    );
    raw = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, database) } },
    });
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(join(ROOT, 'prisma/migrations'), join(dir, 'migrations'), {
      recursive: true,
    });
    for (const name of MIGRATIONS)
      rmSync(join(dir, 'migrations', name), { recursive: true });
    deploy();
  }, 120000);
  afterAll(async () => {
    await raw?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rellena el logo de la emisión de dos clínicas y deja triggers y FORCE activos', async () => {
    const role = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const expected: Record<string, string> = {};
    for (const tag of ['a', 'b']) {
      // A: el logo sale de la auditoría (hoy tiene otro); B: sin eventos, el
      // de hoy.
      const auditedLogo = `logos/${tag}-000000000000000a.png`;
      const currentLogo = `logos/${tag}-000000000000000b.png`;
      const tenant = await raw.tenant.create({
        data: {
          name: `DX019B ${tag}`,
          subdomain: `dx019b-owner-${tag}`,
          logoKey: currentLogo,
        },
      });
      const user = await raw.user.create({
        data: {
          email: `dx019b-owner-${tag}@example.com`,
          fullName: 'Dra. QA',
          passwordHash: 'unused',
        },
      });
      const patient = await raw.patient.create({
        data: { tenantId: tenant.id, firstName: 'QA', lastName: tag },
      });
      const location = await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: tenant.id,
          name: 'Sede Caracas',
        }),
      });
      const plan = await raw.treatmentPlan.create({
        data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
      });
      if (tag === 'a') {
        await raw.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorUserId: user.id,
            action: 'UPDATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: tenant.id,
            occurredAt: new Date('2026-01-10T12:00:00.000Z'),
            metadata: {
              reason: 'CLINIC_LOGO',
              changedFields: ['logo'],
              configChange: {
                before: { logo: null },
                after: { logo: auditedLogo },
              },
            },
          },
        });
      }
      // Sin la columna todavía: SQL directo (el cliente ya la conoce).
      const rxId = `00000000-0000-4000-8000-0000000019${tag === 'a' ? '01' : '02'}`;
      const accId = `00000000-0000-4000-8000-0000000019${tag === 'a' ? '11' : '12'}`;
      await raw.$executeRaw`INSERT INTO prescriptions (id, "tenantId", "locationId", "patientId", "professionalId", "singleFormat", "printQuantityInWords", "issuedAt", "dispensationDate", "validUntil", "patientName", "professionalName", "professionalLicense", "clinicName", "locationName", "contentHash")
        VALUES (${rxId}::uuid, ${tenant.id}::uuid, ${location.id}::uuid, ${patient.id}::uuid, ${user.id}::uuid, true, false, '2026-02-01 12:00', '2026-02-01', '2026-02-01', 'QA', 'Dra. QA', 'MPPS-1', 'Clínica', 'Sede Caracas', ${'b'.repeat(64)})`;
      await raw.$executeRaw`INSERT INTO treatment_plan_acceptances (id, "tenantId", "planId", "patientId", "locationId", "signerName", signature, content, "contentHash", "acceptanceHash", "acceptedAt", "acceptedById")
        VALUES (${accId}::uuid, ${tenant.id}::uuid, ${plan.id}::uuid, ${patient.id}::uuid, ${location.id}::uuid, 'QA', ${SIGNATURE}, '{"version": 4}'::jsonb, ${'a'.repeat(64)}, ${'c'.repeat(64)}, '2026-02-01 12:00', ${user.id}::uuid)`;
      const logo = tag === 'a' ? auditedLogo : currentLogo;
      expected[rxId] = logo;
      expected[accId] = logo;
    }
    for (const name of MIGRATIONS)
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    deploy();

    const frozen = await raw.$queryRaw<{ id: string; key: string | null }[]>`
      SELECT id::text, "clinicLogoKey" AS key FROM prescriptions
      UNION ALL
      SELECT id::text, "clinicLogoKey" FROM treatment_plan_acceptances`;
    expect(Object.fromEntries(frozen.map((r) => [r.id, r.key]))).toEqual(
      expected,
    );
    const triggers = await raw.$queryRaw<
      { tgname: string; tgenabled: string }[]
    >`SELECT tgname, tgenabled::text FROM pg_trigger
       WHERE tgname IN ('prescriptions_immutable', 'treatment_plan_acceptances_immutable')
       ORDER BY tgname`;
    expect(triggers.map((t) => t.tgenabled)).toEqual(['O', 'O']);
    const flags = await raw.$queryRaw<{ name: string; forced: boolean }[]>`
      SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class
       WHERE relname IN ('prescriptions', 'treatment_plan_acceptances', 'audit_events')
       ORDER BY relname`;
    expect(flags).toHaveLength(3);
    expect(flags.every((r) => r.forced)).toBe(true);
    const checks = await raw.$queryRaw<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
       WHERE conname LIKE '%clinic_logo_key_check'`;
    expect(checks.map((c) => c.convalidated)).toEqual([true, true]);
    await expect(
      raw.$executeRaw`UPDATE prescriptions SET "clinicLogoKey" = NULL`,
    ).rejects.toThrow(/inmutable/);
  }, 120000);
});
