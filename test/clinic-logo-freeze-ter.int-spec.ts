import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { clinicLogoKeyToFreeze } from '../src/shared/storage/clinic-logo-url';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-019-ter contra Postgres: las tres migraciones del logo congelado de los
// consentimientos firmados y las indicaciones post-operatorias entregadas,
// con el mismo mecanismo que DX-019-bis (test/clinic-logo-freeze.int-spec.ts).
// El relleno (D5) reconstruye el logo de la firma o la entrega con la
// auditoría de CADA clínica, desactiva los triggers de inmutabilidad solo
// alrededor de su UPDATE y en la misma transacción, no toca ninguna otra
// columna y es idempotente. El CHECK admite exactamente lo que
// `clinicLogoKeyToFreeze` congela. Con el owner sin superusuario (RLS),
// test/owner-nosu/clinic-logo-freeze-ter.owner-spec.ts.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const ADD = read('20261214090000_dx019t_clinic_logo_key');
const BACKFILL = read('20261214090100_dx019t_clinic_logo_key_backfill');
const VALIDATE = read('20261214090200_dx019t_clinic_logo_key_validate');

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

const SIGNATURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('DX-019-ter: logo congelado en consentimientos y entregas — migraciones (Postgres)', () => {
  const consent: Record<string, string> = {};
  const postOp: Record<string, string> = {};

  async function clinic(tag: string, logoKey: string | null) {
    const tenant = await raw.tenant.create({
      data: { name: `DX019T ${tag}`, subdomain: `dx019t-${tag}`, logoKey },
    });
    const user = await raw.user.create({
      data: {
        email: `dx019t-${tag}@example.com`,
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
    let hour = 0;
    return {
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
      consent: async (name: string, signedAt: string) => {
        consent[name] = (
          await raw.patientConsent.create({
            data: {
              tenantId: tenant.id,
              patientId: patient.id,
              templateId: consentTemplate.id,
              templateVersion: 1,
              title: 'Exodoncia',
              body: 'Autorizo.',
              signerType: 'PATIENT',
              signerName: `Ana ${tag}`,
              professionalName: 'Dra. QA',
              patientSignature: SIGNATURE,
              professionalSignature: SIGNATURE,
              contentHash: 'a'.repeat(64),
              signedAt: at(signedAt),
              recordedById: user.id,
            },
          })
        ).id;
      },
      postOp: async (name: string, deliveredAt: string) => {
        const start = new Date(at(deliveredAt).getTime() + hour++ * 3600000);
        const appointment = await raw.appointment.create({
          data: {
            tenantId: tenant.id,
            locationId: location.id,
            patientId: patient.id,
            providerId: user.id,
            start,
            end: new Date(start.getTime() + 1800000),
          },
        });
        // `deliveredAt` lo pone un trigger con la hora de la BD: se siembra
        // sin triggers para fecharla en el pasado.
        postOp[name] = await raw.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'SET LOCAL session_replication_role = replica',
          );
          return (
            await tx.postOpInstructionDelivery.create({
              data: {
                tenantId: tenant.id,
                patientId: patient.id,
                appointmentId: appointment.id,
                locationId: location.id,
                templateId: postOpTemplate.id,
                templateCode: 'POI-EXO',
                templateTitle: 'Exodoncia',
                templateVersion: 1,
                channel: 'PRINT',
                renderedText: 'Muerde la gasa.',
                deliveredById: user.id,
                deliveredByName: 'Dra. QA',
                deliveredAt: at(deliveredAt),
                createdAt: at(deliveredAt),
              },
            })
          ).id;
        });
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
    await one.consent('beforeAny', '2025-12-01');
    await one.consent('afterA', '2026-02-01');
    await one.consent('atB', '2026-03-10');
    await one.consent('afterRemoval', '2026-06-01');
    await one.postOp('withB', '2026-04-01');
    await one.postOp('afterRemoval', '2026-06-01');
    // Clínica 2: solo un evento posterior a la emisión (su «antes» manda).
    const two = await clinic('dos', LOGO_B2);
    await two.logoEvent('2026-05-10', LOGO_A2, LOGO_B2);
    await two.consent('beforeOnlyEvent', '2026-02-01');
    await two.postOp('afterOnlyEvent', '2026-07-01');
    // Clínica 3: sin eventos, URL anterior a la subida: se copia tal cual.
    const three = await clinic('tres', LEGACY_URL);
    await three.consent('legacyUrl', '2026-02-01');
    await three.postOp('legacyUrl', '2026-02-01');
    // Clínica 4: sin eventos y un valor que no se pinta: NULL.
    const four = await clinic('cuatro', 'ftp://cdn.example.com/logo.png');
    await four.consent('unrenderable', '2026-02-01');
    // Clínica 5: sin eventos ni logo.
    const five = await clinic('cinco', null);
    await five.postOp('noLogo', '2026-02-01');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el relleno toma el logo de la firma o la entrega por la auditoría de su clínica, solo cambia esa columna, deja los triggers activos y es idempotente', async () => {
    const rowsOf = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ id: string; row: Record<string, unknown> }[]>`
        SELECT id::text, to_jsonb(c) - 'clinicLogoKey' AS row FROM patient_consents c
        UNION ALL
        SELECT id::text, to_jsonb(d) - 'clinicLogoKey' FROM post_op_instruction_deliveries d
        ORDER BY 1`;
    const frozenOf = async (tx: Prisma.TransactionClient) =>
      new Map(
        (
          await tx.$queryRaw<{ id: string; key: string | null }[]>`
            SELECT id::text, "clinicLogoKey" AS key FROM patient_consents
            UNION ALL
            SELECT id::text, "clinicLogoKey" FROM post_op_instruction_deliveries`
        ).map((r) => [r.id, r.key]),
      );
    const before = await rowsOf(raw);
    await expect(
      raw.$transaction(
        async (tx) => {
          // Estado anterior a la primera migración: sin la columna.
          await tx.$executeRawUnsafe(
            'ALTER TABLE patient_consents DROP COLUMN "clinicLogoKey"',
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE post_op_instruction_deliveries DROP COLUMN "clinicLogoKey"',
          );
          for (const sql of [ADD, BACKFILL, VALIDATE])
            for (const statement of statements(sql))
              await tx.$executeRawUnsafe(statement);

          const frozen = await frozenOf(tx);
          expect({
            beforeAny: frozen.get(consent.beforeAny),
            afterA: frozen.get(consent.afterA),
            atB: frozen.get(consent.atB),
            afterRemovalConsent: frozen.get(consent.afterRemoval),
            withB: frozen.get(postOp.withB),
            afterRemovalPostOp: frozen.get(postOp.afterRemoval),
            beforeOnlyEvent: frozen.get(consent.beforeOnlyEvent),
            afterOnlyEvent: frozen.get(postOp.afterOnlyEvent),
            legacyUrlConsent: frozen.get(consent.legacyUrl),
            legacyUrlPostOp: frozen.get(postOp.legacyUrl),
            unrenderable: frozen.get(consent.unrenderable),
            noLogo: frozen.get(postOp.noLogo),
          }).toEqual({
            // Antes del primer evento: su «antes» (sin logo), no el de hoy.
            beforeAny: null,
            afterA: LOGO_A1,
            // Firmado en el mismo instante del cambio: el nuevo.
            atB: LOGO_B1,
            afterRemovalConsent: null,
            withB: LOGO_B1,
            afterRemovalPostOp: null,
            beforeOnlyEvent: LOGO_A2,
            afterOnlyEvent: LOGO_B2,
            legacyUrlConsent: LEGACY_URL,
            legacyUrlPostOp: LEGACY_URL,
            unrenderable: null,
            noLogo: null,
          });
          // Ninguna otra columna cambia.
          expect(await rowsOf(tx)).toEqual(before);

          // Repetirlo (despliegue escalonado) no cambia nada.
          for (const statement of statements(BACKFILL))
            await tx.$executeRawUnsafe(statement);
          expect(await frozenOf(tx)).toEqual(frozen);
          expect(await rowsOf(tx)).toEqual(before);

          const triggers = await tx.$queryRaw<
            { tgname: string; tgenabled: string }[]
          >`SELECT tgname, tgenabled::text FROM pg_trigger
             WHERE tgname IN ('patient_consents_immutable', 'post_op_instruction_deliveries_immutable')
             ORDER BY tgname`;
          expect(triggers).toEqual([
            { tgname: 'patient_consents_immutable', tgenabled: 'O' },
            {
              tgname: 'post_op_instruction_deliveries_immutable',
              tgenabled: 'O',
            },
          ]);
          const [{ tenant }] = await tx.$queryRaw<{ tenant: string | null }[]>`
            SELECT current_setting('app.current_tenant', true) AS tenant`;
          expect(tenant ?? '').toBe('');
          const checks = await tx.$queryRaw<
            { conname: string; convalidated: boolean }[]
          >`SELECT conname, convalidated FROM pg_constraint
             WHERE conname IN ('patient_consents_clinic_logo_key_check', 'post_op_instruction_deliveries_clinic_logo_key_check')
             ORDER BY conname`;
          expect(checks).toEqual([
            {
              conname: 'patient_consents_clinic_logo_key_check',
              convalidated: true,
            },
            {
              conname: 'post_op_instruction_deliveries_clinic_logo_key_check',
              convalidated: true,
            },
          ]);

          // Ya en la misma transacción, el trigger rechaza cambiar la clave.
          for (const [table, id] of [
            ['patient_consents', consent.afterA],
            ['post_op_instruction_deliveries', postOp.withB],
          ]) {
            await tx.$executeRawUnsafe('SAVEPOINT dx019t');
            await expect(
              tx.$executeRawUnsafe(
                `UPDATE ${table} SET "clinicLogoKey" = $1 WHERE id = $2::uuid`,
                LOGO_NOW1,
                id,
              ),
            ).rejects.toThrow(/inmutable|inalterable/);
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dx019t');
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
      /ALTER TABLE "patient_consents" DISABLE TRIGGER "patient_consents_immutable";/,
      /ALTER TABLE "post_op_instruction_deliveries" DISABLE TRIGGER "post_op_instruction_deliveries_immutable";/,
      /^DO \$\$$/m,
      /^\$\$;$/m,
      /ALTER TABLE "patient_consents" ENABLE TRIGGER "patient_consents_immutable";/,
      /ALTER TABLE "post_op_instruction_deliveries" ENABLE TRIGGER "post_op_instruction_deliveries_immutable";/,
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
      'patient_consents_clinic_logo_key_check',
      'post_op_instruction_deliveries_clinic_logo_key_check',
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
