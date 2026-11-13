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

// DX-019-ter con un owner SIN superusuario ni BYPASSRLS: la RLS FORCE le
// aplica, así que el relleno del logo congelado de consentimientos y entregas
// post-operatorias solo ve las filas de cada clínica porque fija
// `app.current_tenant` clínica por clínica. Si no lo hiciera, se quedarían
// NULL «sin logo» y la migración pasaría igual: aquí se comprueba el valor de
// cada clínica. Mismo esquema que clinic-logo-freeze.owner-spec.ts (DX-019-bis).
const ROOT = join(__dirname, '../..');
const MIGRATIONS = [
  '20261214090000_dx019t_clinic_logo_key',
  '20261214090100_dx019t_clinic_logo_key_backfill',
  '20261214090200_dx019t_clinic_logo_key_validate',
];
const SIGNATURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('DX-019-ter: logo congelado en consentimientos y entregas con owner sin superusuario', () => {
  const env = requireOwnerNosuEnv();
  const database = `dx019t_owner_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx019t-owner-'));
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

  it('rellena el logo de la firma y de la entrega de dos clínicas y deja triggers y FORCE activos', async () => {
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
          name: `DX019T ${tag}`,
          subdomain: `dx019t-owner-${tag}`,
          logoKey: currentLogo,
        },
      });
      const user = await raw.user.create({
        data: {
          email: `dx019t-owner-${tag}@example.com`,
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
      const consentTemplate = await raw.consentTemplate.create({
        data: { tenantId: tenant.id, title: 'Exodoncia', body: 'Autorizo.' },
      });
      const postOpTemplate = await raw.postOpInstructionTemplate.create({
        data: {
          tenantId: tenant.id,
          code: 'POI-EXO',
          title: 'Exodoncia',
          body: 'Muerde la gasa.',
        },
      });
      const appointment = await raw.appointment.create({
        data: {
          tenantId: tenant.id,
          locationId: location.id,
          patientId: patient.id,
          providerId: user.id,
          start: new Date('2026-02-01T12:00:00.000Z'),
          end: new Date('2026-02-01T12:30:00.000Z'),
        },
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
      // Sin la columna todavía: SQL directo (el cliente ya la conoce). La
      // entrega sin triggers, para fecharla en el pasado.
      const consentId = `00000000-0000-4000-8000-0000000019${tag === 'a' ? '21' : '22'}`;
      const deliveryId = `00000000-0000-4000-8000-0000000019${tag === 'a' ? '31' : '32'}`;
      await raw.$executeRaw`INSERT INTO patient_consents (id, "tenantId", "patientId", "templateId", "templateVersion", title, body, "signerType", "signerName", "professionalName", "patientSignature", "professionalSignature", "contentHash", "signedAt", "recordedById")
        VALUES (${consentId}::uuid, ${tenant.id}::uuid, ${patient.id}::uuid, ${consentTemplate.id}::uuid, 1, 'Exodoncia', 'Autorizo.', 'PATIENT', 'QA', 'Dra. QA', ${SIGNATURE}, ${SIGNATURE}, ${'a'.repeat(64)}, '2026-02-01 12:00', ${user.id}::uuid)`;
      await raw.$transaction([
        raw.$executeRawUnsafe('SET LOCAL session_replication_role = replica'),
        raw.$executeRaw`INSERT INTO post_op_instruction_deliveries (id, "tenantId", "patientId", "appointmentId", "locationId", "templateId", "templateCode", "templateTitle", "templateVersion", channel, "renderedText", "deliveredById", "deliveredByName", "deliveredAt", "createdAt")
          VALUES (${deliveryId}::uuid, ${tenant.id}::uuid, ${patient.id}::uuid, ${appointment.id}::uuid, ${location.id}::uuid, ${postOpTemplate.id}::uuid, 'POI-EXO', 'Exodoncia', 1, 'PRINT', 'Muerde la gasa.', ${user.id}::uuid, 'Dra. QA', '2026-02-01 12:00', '2026-02-01 12:00')`,
      ]);
      const logo = tag === 'a' ? auditedLogo : currentLogo;
      expected[consentId] = logo;
      expected[deliveryId] = logo;
    }
    for (const name of MIGRATIONS)
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    deploy();

    const frozen = await raw.$queryRaw<{ id: string; key: string | null }[]>`
      SELECT id::text, "clinicLogoKey" AS key FROM patient_consents
      UNION ALL
      SELECT id::text, "clinicLogoKey" FROM post_op_instruction_deliveries`;
    expect(Object.fromEntries(frozen.map((r) => [r.id, r.key]))).toEqual(
      expected,
    );
    const triggers = await raw.$queryRaw<
      { tgname: string; tgenabled: string }[]
    >`SELECT tgname, tgenabled::text FROM pg_trigger
       WHERE tgname IN ('patient_consents_immutable', 'post_op_instruction_deliveries_immutable')
       ORDER BY tgname`;
    expect(triggers.map((t) => t.tgenabled)).toEqual(['O', 'O']);
    const flags = await raw.$queryRaw<{ name: string; forced: boolean }[]>`
      SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class
       WHERE relname IN ('patient_consents', 'post_op_instruction_deliveries', 'audit_events')
       ORDER BY relname`;
    expect(flags).toHaveLength(3);
    expect(flags.every((r) => r.forced)).toBe(true);
    const checks = await raw.$queryRaw<{ convalidated: boolean }[]>`
      SELECT convalidated FROM pg_constraint
       WHERE conname IN ('patient_consents_clinic_logo_key_check', 'post_op_instruction_deliveries_clinic_logo_key_check')`;
    expect(checks.map((c) => c.convalidated)).toEqual([true, true]);
    await expect(
      raw.$executeRaw`UPDATE patient_consents SET "clinicLogoKey" = NULL`,
    ).rejects.toThrow(/inmutable/);
  }, 120000);
});
