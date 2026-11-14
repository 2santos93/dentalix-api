import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { clinicLogoKeyToFreeze } from '../src/shared/storage/clinic-logo-url';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-019-bis (B) contra Postgres: las tres migraciones del logo congelado de
// recetas y aceptaciones firmadas. El relleno (D5) reconstruye el logo de la
// emisión con la auditoría de CADA clínica, desactiva los triggers de
// inmutabilidad solo alrededor de su UPDATE y en la misma transacción, y no
// toca ninguna otra columna. El CHECK admite exactamente lo que
// `clinicLogoKeyToFreeze` congela. Con el owner sin superusuario (RLS),
// test/owner-nosu/clinic-logo-freeze.owner-spec.ts.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const ADD = read('20261203090000_dx019b_clinic_logo_key');
const BACKFILL = read('20261203090100_dx019b_clinic_logo_key_backfill');
const VALIDATE = read('20261203090200_dx019b_clinic_logo_key_validate');

/**
 * Las sentencias de una migración, sin comentarios ni BEGIN/COMMIT (el test
 * la corre dentro de su propia transacción). Los cuerpos `$$ … $$` van
 * enteros aunque lleven `;`.
 */
function statements(sql: string): string[] {
  const parts = sql.replace(/--[^\n]*/g, '').split('$$');
  const out: string[] = [];
  let current = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      current += `$$${part}$$`;
      return;
    }
    const pieces = part.split(';');
    pieces.forEach((piece, j) => {
      current += piece;
      if (j < pieces.length - 1) {
        out.push(current.trim());
        current = '';
      }
    });
  });
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
}

const LOGO_A1 = 'logos/a1-0000000000000001.png';
const LOGO_B1 = 'logos/b1-0000000000000002.png';
const LOGO_NOW1 = 'logos/hoy-0000000000000003.png';
const LOGO_A2 = 'logos/a2-0000000000000004.jpg';
const LOGO_B2 = 'logos/b2-0000000000000005.png';
const LEGACY_URL = 'https://cdn.example.com/logo.png';

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('DX-019-bis (B): logo congelado — migraciones (Postgres)', () => {
  const rx: Record<string, string> = {};
  const acc: Record<string, string> = {};

  async function clinic(tag: string, logoKey: string | null) {
    const tenant = await raw.tenant.create({
      data: { name: `DX019B ${tag}`, subdomain: `dx019b-${tag}`, logoKey },
    });
    const user = await raw.user.create({
      data: {
        email: `dx019b-${tag}@example.com`,
        fullName: 'Dra. QA',
        passwordHash: 'unused',
      },
    });
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: 'Ana', lastName: tag },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede Caracas',
      }),
    });
    const ids = {
      tenantId: tenant.id,
      userId: user.id,
      patientId: patient.id,
      locationId: location.id,
    };
    return {
      ...ids,
      logoEvent: (
        occurredAt: string,
        before: string | null,
        after: string | null,
        reason = 'CLINIC_LOGO',
      ) =>
        raw.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actorUserId: user.id,
            action: 'UPDATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: tenant.id,
            occurredAt: at(occurredAt),
            metadata:
              reason === 'CLINIC_LOGO'
                ? {
                    reason,
                    changedFields: ['logo'],
                    configChange: {
                      before: { logo: before },
                      after: { logo: after },
                    },
                  }
                : {
                    reason,
                    changedFields: ['legalName'],
                    configChange: {
                      before: { legalName: before },
                      after: { legalName: after },
                    },
                  },
          },
        }),
      prescription: async (name: string, issuedAt: string) => {
        rx[name] = (
          await raw.prescription.create({
            data: {
              tenantId: tenant.id,
              locationId: location.id,
              patientId: patient.id,
              professionalId: user.id,
              singleFormat: true,
              printQuantityInWords: false,
              issuedAt: at(issuedAt),
              dispensationDate: new Date(`${issuedAt}T00:00:00.000Z`),
              validUntil: new Date(`${issuedAt}T00:00:00.000Z`),
              patientName: `Ana ${tag}`,
              professionalName: 'Dra. QA',
              professionalLicense: 'MPPS-1',
              clinicName: `DX019B ${tag}`,
              locationName: 'Sede Caracas',
              contentHash: 'b'.repeat(64),
            },
          })
        ).id;
      },
      acceptance: async (name: string, acceptedAt: string) => {
        const plan = await raw.treatmentPlan.create({
          data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
        });
        acc[name] = (
          await raw.treatmentPlanAcceptance.create({
            data: {
              tenantId: tenant.id,
              planId: plan.id,
              patientId: patient.id,
              locationId: location.id,
              signerName: `Ana ${tag}`,
              signature:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
              content: { version: 4 },
              contentHash: 'a'.repeat(64),
              acceptanceHash: 'c'.repeat(64),
              acceptedAt: at(acceptedAt),
              acceptedById: user.id,
            },
          })
        ).id;
      },
    };
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    // Clínica 1: logo subido (A1), cambiado (B1) y quitado; un cambio de
    // otro motivo en medio no cuenta. Hoy tiene otro logo sin auditar, que
    // NO se usa: hay eventos.
    const one = await clinic('uno', LOGO_NOW1);
    await one.logoEvent('2026-01-10', null, LOGO_A1);
    await one.logoEvent(
      '2026-02-15',
      'Vieja S.A.',
      'Nueva S.A.',
      'CLINIC_PROFILE',
    );
    await one.logoEvent('2026-03-10', LOGO_A1, LOGO_B1);
    await one.logoEvent('2026-05-10', LOGO_B1, null);
    await one.prescription('beforeAny', '2025-12-01');
    await one.prescription('afterA', '2026-02-01');
    await one.prescription('atB', '2026-03-10');
    await one.prescription('afterRemoval', '2026-06-01');
    await one.acceptance('withB', '2026-04-01');
    // Clínica 2: solo un evento posterior a la emisión (su «antes» manda).
    const two = await clinic('dos', LOGO_B2);
    await two.logoEvent('2026-05-10', LOGO_A2, LOGO_B2);
    await two.prescription('beforeOnlyEvent', '2026-02-01');
    await two.acceptance('afterOnlyEvent', '2026-07-01');
    // Clínica 3: sin eventos, URL anterior a la subida: se copia tal cual.
    const three = await clinic('tres', LEGACY_URL);
    await three.prescription('legacyUrl', '2026-02-01');
    await three.acceptance('legacyUrl', '2026-02-01');
    // Clínica 4: sin eventos y un valor que no se pinta: NULL.
    const four = await clinic('cuatro', 'ftp://cdn.example.com/logo.png');
    await four.prescription('unrenderable', '2026-02-01');
    // Clínica 5: sin eventos ni logo.
    const five = await clinic('cinco', null);
    await five.acceptance('noLogo', '2026-02-01');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el relleno toma el logo de la emisión por la auditoría de su clínica, solo cambia esa columna y deja los triggers activos en la misma transacción', async () => {
    const rowsOf = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ id: string; row: Record<string, unknown> }[]>`
        SELECT id::text, to_jsonb(p) - 'clinicLogoKey' AS row FROM prescriptions p
        UNION ALL
        SELECT id::text, to_jsonb(a) - 'clinicLogoKey' FROM treatment_plan_acceptances a
        ORDER BY 1`;
    const before = await rowsOf(raw);
    await expect(
      raw.$transaction(
        async (tx) => {
          // Estado anterior a la primera migración: sin la columna.
          await tx.$executeRawUnsafe(
            'ALTER TABLE prescriptions DROP COLUMN "clinicLogoKey"',
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE treatment_plan_acceptances DROP COLUMN "clinicLogoKey"',
          );
          for (const sql of [ADD, BACKFILL, VALIDATE])
            for (const statement of statements(sql))
              await tx.$executeRawUnsafe(statement);

          const frozen = new Map(
            (
              await tx.$queryRaw<{ id: string; key: string | null }[]>`
                SELECT id::text, "clinicLogoKey" AS key FROM prescriptions
                UNION ALL
                SELECT id::text, "clinicLogoKey" FROM treatment_plan_acceptances`
            ).map((r) => [r.id, r.key]),
          );
          expect({
            beforeAny: frozen.get(rx.beforeAny),
            afterA: frozen.get(rx.afterA),
            atB: frozen.get(rx.atB),
            afterRemoval: frozen.get(rx.afterRemoval),
            withB: frozen.get(acc.withB),
            beforeOnlyEvent: frozen.get(rx.beforeOnlyEvent),
            afterOnlyEvent: frozen.get(acc.afterOnlyEvent),
            legacyUrlRx: frozen.get(rx.legacyUrl),
            legacyUrlAcc: frozen.get(acc.legacyUrl),
            unrenderable: frozen.get(rx.unrenderable),
            noLogo: frozen.get(acc.noLogo),
          }).toEqual({
            // Antes del primer evento: su «antes» (sin logo), no el de hoy.
            beforeAny: null,
            afterA: LOGO_A1,
            // Emitida en el mismo instante del cambio: el nuevo.
            atB: LOGO_B1,
            afterRemoval: null,
            withB: LOGO_B1,
            beforeOnlyEvent: LOGO_A2,
            afterOnlyEvent: LOGO_B2,
            legacyUrlRx: LEGACY_URL,
            legacyUrlAcc: LEGACY_URL,
            unrenderable: null,
            noLogo: null,
          });
          // Ninguna otra columna cambia.
          expect(await rowsOf(tx)).toEqual(before);

          const triggers = await tx.$queryRaw<
            { tgname: string; tgenabled: string }[]
          >`SELECT tgname, tgenabled::text FROM pg_trigger
             WHERE tgname IN ('prescriptions_immutable', 'treatment_plan_acceptances_immutable')
             ORDER BY tgname`;
          expect(triggers).toEqual([
            { tgname: 'prescriptions_immutable', tgenabled: 'O' },
            { tgname: 'treatment_plan_acceptances_immutable', tgenabled: 'O' },
          ]);
          const [{ tenant }] = await tx.$queryRaw<{ tenant: string | null }[]>`
            SELECT current_setting('app.current_tenant', true) AS tenant`;
          expect(tenant ?? '').toBe('');
          const checks = await tx.$queryRaw<
            { conname: string; convalidated: boolean }[]
          >`SELECT conname, convalidated FROM pg_constraint
             WHERE conname IN ('prescriptions_clinic_logo_key_check', 'treatment_plan_acceptances_clinic_logo_key_check') ORDER BY conname`;
          expect(checks).toEqual([
            {
              conname: 'prescriptions_clinic_logo_key_check',
              convalidated: true,
            },
            {
              conname: 'treatment_plan_acceptances_clinic_logo_key_check',
              convalidated: true,
            },
          ]);

          // Ya en la misma transacción, el trigger rechaza cambiar la clave.
          for (const [table, id] of [
            ['prescriptions', rx.afterA],
            ['treatment_plan_acceptances', acc.withB],
          ]) {
            await tx.$executeRawUnsafe('SAVEPOINT dx019b');
            await expect(
              tx.$executeRawUnsafe(
                `UPDATE ${table} SET "clinicLogoKey" = $1 WHERE id = $2::uuid`,
                LOGO_NOW1,
                id,
              ),
            ).rejects.toThrow(/inmutable/);
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dx019b');
          }
          throw new Error('ROLLBACK_QA');
        },
        { timeout: 30000 },
      ),
    ).rejects.toThrow('ROLLBACK_QA');
  });

  it('el relleno desactiva SOLO los triggers *_immutable, solo alrededor del UPDATE, dentro de BEGIN … COMMIT, y solo escribe "clinicLogoKey"', () => {
    const body = BACKFILL.replace(/--[^\n]*/g, '');
    const order = [
      /^BEGIN;$/m,
      /SET LOCAL lock_timeout = '5s';/,
      /ALTER TABLE "prescriptions" DISABLE TRIGGER "prescriptions_immutable";/,
      /ALTER TABLE "treatment_plan_acceptances" DISABLE TRIGGER "treatment_plan_acceptances_immutable";/,
      /^DO \$\$$/m,
      /^\$\$;$/m,
      /ALTER TABLE "prescriptions" ENABLE TRIGGER "prescriptions_immutable";/,
      /ALTER TABLE "treatment_plan_acceptances" ENABLE TRIGGER "treatment_plan_acceptances_immutable";/,
      /^COMMIT;$/m,
    ].map((re) => body.search(re));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(body.match(/DISABLE TRIGGER/g)).toHaveLength(2);
    expect(body.match(/ENABLE TRIGGER/g)).toHaveLength(2);
    expect(body).not.toMatch(
      /FORCE ROW LEVEL SECURITY|TRIGGER ALL|TRIGGER USER/,
    );
    const sets = [...body.matchAll(/\bSET\s+("?\w+"?)\s*=/g)].map((m) => m[1]);
    expect(sets).toEqual(['"clinicLogoKey"', '"clinicLogoKey"']);
  });

  it('el CHECK de las dos columnas admite exactamente lo que congela la API', async () => {
    const samples = [
      'logos/0f8fad5b-d9cb-469f-a165-70867728950e-0123456789abcdef.png',
      'logos/x.webp',
      'logos/a..b.png',
      'logos/../x.png',
      'logos/a/b.png',
      'logos/.oculto',
      'avatars/u1.png',
      'https://cdn.example.com/logo.png',
      'HTTP://cdn.example.com/logo.png',
      'ftp://cdn.example.com/logo.png',
      'javascript:alert(1)',
      '',
    ];
    for (const conname of [
      'prescriptions_clinic_logo_key_check',
      'treatment_plan_acceptances_clinic_logo_key_check',
    ]) {
      const [{ expr }] = await raw.$queryRaw<{ expr: string }[]>`
        SELECT pg_get_expr(conbin, conrelid) AS expr FROM pg_constraint
         WHERE conname = ${conname}`;
      for (const sample of samples) {
        const [{ ok }] = await raw.$queryRawUnsafe<{ ok: boolean }[]>(
          `SELECT (${expr}) AS ok FROM (SELECT $1::text AS "clinicLogoKey") s`,
          sample,
        );
        expect({ conname, sample, ok }).toEqual({
          conname,
          sample,
          ok: clinicLogoKeyToFreeze(sample) === sample,
        });
      }
    }
  });
});
