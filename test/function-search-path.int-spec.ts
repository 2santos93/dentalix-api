import { Prisma, PrismaClient } from '@prisma/client';

// SEC-032, search_path fijo en las funciones de trigger y SECURITY DEFINER.
// Con el search_path por defecto, pg_temp se busca ANTES que pg_catalog y que
// public para tablas y tipos, y dentalix_app tiene TEMP en la BD: sin
// search_path fijo, una tabla temporal con el nombre de un catálogo
// (pg_roles) o de una tabla de la app (perio_exams, prescriptions,
// treatment_plan_acceptances…) suplanta a la real DENTRO del trigger y lo
// desactiva. Cada caso corre como dentalix_app (DATABASE_URL, sujeto a RLS)
// con su `app.current_tenant`, igual que la API; `raw` (DIRECT_URL,
// superusuario) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

class Rollback extends Error {}

const SUBDOMAIN = 'sec032-search-path';
const EMAIL = 'sec032@search-path.test';
const FAKE_SUPERUSER = [
  'CREATE TEMP TABLE pg_roles (rolname name, rolsuper boolean) ON COMMIT DROP',
  'INSERT INTO pg_roles VALUES (current_user, true)',
];

interface Seeded {
  tenantId: string;
  userId: string;
  patientId: string;
  locationId: string;
  policyId: string;
  unusedPolicyId: string;
  consentId: string;
  auditEventId: string;
  finalExamId: string;
  siteMeasureId: string;
  toothMeasureId: string;
  prescriptionId: string;
  signedPlanId: string;
  signedItemId: string;
}

/**
 * Corre `setup` y luego `stmt` como dentalix_app con el tenant fijado, en una
 * sola transacción (las tablas temporales son ON COMMIT DROP).
 */
function asApp(
  tenantId: string,
  setup: string[],
  stmt: string,
  ...params: unknown[]
): Promise<number> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    for (const sql of setup) await tx.$executeRawUnsafe(sql);
    return tx.$executeRawUnsafe(stmt, ...params);
  });
}

async function purge(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario y sin `app.current_tenant`: los triggers dejan borrar.
  await raw.treatmentPlanAcceptance.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.prescription.deleteMany({ where });
  await raw.perioExam.deleteMany({ where });
  await raw.dataProcessingConsent.deleteMany({ where });
  await raw.privacyPolicyVersion.deleteMany({ where });
  await raw.auditEvent.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

async function seed(): Promise<Seeded> {
  const { id: tenantId } = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const { id: userId } = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Prueba' },
  });
  const { id: locationId } = await raw.location.create({
    data: { tenantId, name: 'Sede' },
  });
  const { id: patientId } = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: 'Search-path' },
  });
  const { id: policyId } = await raw.privacyPolicyVersion.create({
    data: {
      tenantId,
      version: 1,
      policyText: 'p',
      generalText: 'g',
      sensitiveHealthText: 's',
      marketingText: 'm',
      contentHash: 'h',
      publishedById: userId,
    },
  });
  const { id: unusedPolicyId } = await raw.privacyPolicyVersion.create({
    data: {
      tenantId,
      version: 2,
      policyText: 'p2',
      generalText: 'g',
      sensitiveHealthText: 's',
      marketingText: 'm',
      contentHash: 'h2',
      publishedById: userId,
    },
  });
  const { id: consentId } = await raw.dataProcessingConsent.create({
    data: {
      tenantId,
      patientId,
      policyVersionId: policyId,
      scope: 'GENERAL',
      granted: true,
      channel: 'IN_PERSON',
      recordedById: userId,
    },
  });
  const { id: auditEventId } = await raw.auditEvent.create({
    data: {
      tenantId,
      actorUserId: userId,
      action: 'VIEW',
      resourceType: 'PATIENT',
      patientId,
    },
  });
  const { id: finalExamId } = await raw.perioExam.create({
    data: {
      tenantId,
      patientId,
      providerId: userId,
      examDate: new Date('2026-10-01T00:00:00.000Z'),
      status: 'FINAL',
      finalizedAt: new Date(),
    },
  });
  const { id: siteMeasureId } = await raw.perioSiteMeasure.create({
    data: {
      tenantId,
      examId: finalExamId,
      toothFdi: 16,
      site: 'MB',
      probingMm: 4,
    },
  });
  const { id: toothMeasureId } = await raw.perioToothMeasure.create({
    data: { tenantId, examId: finalExamId, toothFdi: 16, mobility: 1 },
  });
  const { id: prescriptionId } = await raw.prescription.create({
    data: {
      tenantId,
      locationId,
      patientId,
      professionalId: userId,
      country: 'CO',
      issuedAt: new Date(),
      dispensationDate: new Date('2026-10-16T00:00:00.000Z'),
      validUntil: new Date('2026-11-14T00:00:00.000Z'),
      patientName: 'Ana',
      clinicalRecordNumber: '123',
      professionalName: 'Dra. Prueba',
      professionalLicense: 'RM-1',
      clinicName: 'Clínica',
      locationName: 'Sede',
      contentHash: 'b'.repeat(64),
      items: {
        create: [
          {
            position: 1,
            activeIngredient: 'Amoxicilina',
            concentration: '500 mg',
            pharmaceuticalForm: 'Cápsula',
            route: 'Oral',
            dose: '1 cápsula',
            frequency: 'Cada 8 horas',
            durationDays: 7,
            totalQuantity: 21,
            quantityUnit: 'cápsulas',
            quantityInWords: 'veintiuno',
          },
        ],
      },
    },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: `c-${SUBDOMAIN}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  const { id: signedPlanId } = await raw.treatmentPlan.create({
    data: { tenantId, patientId, currency: 'USD' },
  });
  const { id: signedItemId } = await raw.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: signedPlanId,
      toothNumber: '11',
      catalogItemId: catalog.id,
      price: 100,
      discount: 10,
      status: 'ACCEPTED',
    },
  });
  await raw.treatmentPlanAcceptance.create({
    data: {
      tenantId,
      planId: signedPlanId,
      patientId,
      locationId,
      signerName: 'Ana',
      signature:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      content: { version: 1 },
      contentHash: 'a'.repeat(64),
      acceptanceHash: 'a'.repeat(64),
      acceptedAt: new Date(),
      acceptedById: userId,
    },
  });
  return {
    tenantId,
    userId,
    patientId,
    locationId,
    policyId,
    unusedPolicyId,
    consentId,
    auditEventId,
    finalExamId,
    siteMeasureId,
    toothMeasureId,
    prescriptionId,
    signedPlanId,
    signedItemId,
  };
}

describe('SEC-032 · search_path fijo en funciones de trigger y SECURITY DEFINER (int)', () => {
  let s: Seeded;

  beforeAll(async () => {
    await purge();
    s = await seed();
  });

  afterAll(async () => {
    await purge();
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  describe('catálogo', () => {
    it('toda función de trigger o SECURITY DEFINER del esquema public fija search_path con pg_temp al final', async () => {
      const rows = await raw.$queryRaw<
        { name: string; search_path: string | null }[]
      >`
        SELECT p.proname AS name,
               (SELECT substr(c, length('search_path=') + 1)
                  FROM unnest(p.proconfig) AS c
                 WHERE c LIKE 'search_path=%') AS search_path
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.prorettype = 'pg_catalog.trigger'::regtype OR p.prosecdef)
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.classid = 'pg_proc'::regclass
                              AND d.objid = p.oid AND d.deptype = 'e')
         ORDER BY 1`;
      expect(rows.length).toBeGreaterThan(0);
      const unsafe = rows.filter((r) => {
        if (r.search_path === null) return true;
        const parts = r.search_path.split(',').map((p) => p.trim());
        const tempAt = parts.indexOf('pg_temp');
        // pg_temp ausente = Postgres lo busca PRIMERO: también inseguro.
        return tempAt !== parts.length - 1;
      });
      expect(unsafe).toEqual([]);
    });
  });

  describe('consentimientos y autorizaciones Ley 1581 (dx_forbid_consent_mutation)', () => {
    it('data_processing_consents: rechaza el DELETE aunque una tabla temporal suplante pg_roles', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_SUPERUSER,
          'DELETE FROM "data_processing_consents" WHERE "id" = $1::uuid',
          s.consentId,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('data_processing_consents: rechaza el UPDATE aunque una tabla temporal suplante pg_roles', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_SUPERUSER,
          'UPDATE "data_processing_consents" SET "granted" = false WHERE "id" = $1::uuid',
          s.consentId,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('privacy_policy_versions: rechaza el DELETE aunque una tabla temporal suplante pg_roles', async () => {
      // Versión sin autorizaciones: la FK RESTRICT no la protege, solo el trigger.
      await expect(
        asApp(
          s.tenantId,
          FAKE_SUPERUSER,
          'DELETE FROM "privacy_policy_versions" WHERE "id" = $1::uuid',
          s.unusedPolicyId,
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('las filas siguen intactas', async () => {
      await expect(
        raw.dataProcessingConsent.findUniqueOrThrow({
          where: { id: s.consentId },
        }),
      ).resolves.toMatchObject({ granted: true });
      await expect(
        raw.privacyPolicyVersion.count({
          where: { id: { in: [s.policyId, s.unusedPolicyId] } },
        }),
      ).resolves.toBe(2);
    });
  });

  describe('audit_events (dx_forbid_audit_mutation)', () => {
    it('como dentalix_app el DELETE y el UPDATE fallan aunque una tabla temporal suplante pg_roles', async () => {
      for (const stmt of [
        'DELETE FROM "audit_events" WHERE "id" = $1::uuid',
        `UPDATE "audit_events" SET "metadata" = '{"x":1}' WHERE "id" = $1::uuid`,
      ]) {
        await expect(
          asApp(s.tenantId, FAKE_SUPERUSER, stmt, s.auditEventId),
        ).rejects.toThrow(/42501|permission denied|append-only/);
      }
    });

    it('el trigger frena el DELETE aunque se filtre el privilegio (defensa en profundidad)', async () => {
      // DX-102 quitó UPDATE/DELETE a la app; si un GRANT se colara (p. ej.
      // ALTER DEFAULT PRIVILEGES sobre una partición nueva), el trigger debe
      // seguir siendo la última barrera. El GRANT vive solo en esta
      // transacción, que se deshace SIEMPRE (también si el DELETE pasara).
      let outcome: unknown = 'sin ejecutar';
      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'GRANT DELETE ON "audit_events" TO dentalix_app',
          );
          await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
          for (const sql of FAKE_SUPERUSER) await tx.$executeRawUnsafe(sql);
          try {
            outcome = await tx.$executeRawUnsafe(
              'DELETE FROM "audit_events" WHERE "id" = $1::uuid',
              s.auditEventId,
            );
          } catch (err) {
            outcome = err;
          }
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toMatch(/append-only/);
      await expect(
        raw.$queryRaw<{ ok: boolean }[]>`
          SELECT has_table_privilege('dentalix_app', 'audit_events', 'DELETE') AS ok`,
      ).resolves.toEqual([{ ok: false }]);
      await expect(
        raw.auditEvent.count({ where: { id: s.auditEventId } }),
      ).resolves.toBe(1);
    });
  });

  describe('periodontograma FINAL (perio_measures_final_immutable)', () => {
    const FAKE_EXAMS = [
      'CREATE TEMP TABLE perio_exams (id uuid, status text) ON COMMIT DROP',
    ];

    it.each([
      ['perio_site_measures', 'probingMm', 'siteMeasureId'],
      ['perio_tooth_measures', 'mobility', 'toothMeasureId'],
    ] as const)(
      '%s: rechaza el UPDATE de un examen final aunque una tabla temporal suplante perio_exams',
      async (table, column, key) => {
        await expect(
          asApp(
            s.tenantId,
            FAKE_EXAMS,
            `UPDATE "${table}" SET "${column}" = 3 WHERE "id" = $1::uuid`,
            s[key],
          ),
        ).rejects.toThrow(/examen finalizado/);
      },
    );

    it('perio_site_measures: rechaza el DELETE de un examen final aunque una tabla temporal suplante perio_exams', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_EXAMS,
          'DELETE FROM "perio_site_measures" WHERE "id" = $1::uuid',
          s.siteMeasureId,
        ),
      ).rejects.toThrow(/examen finalizado/);
    });
  });

  describe('recetas (prescription_items_immutable)', () => {
    it('prescription_items: no deja añadir un medicamento a una receta ya emitida aunque una tabla temporal suplante prescriptions', async () => {
      await expect(
        asApp(
          s.tenantId,
          [
            'CREATE TEMP TABLE prescriptions (id uuid, "tenantId" uuid, status text) ON COMMIT DROP',
            // xmin de la fila temporal = transacción actual: imita la receta
            // recién emitida que el trigger exige.
            `INSERT INTO prescriptions VALUES ('${s.prescriptionId}', '${s.tenantId}', 'ISSUED')`,
          ],
          `INSERT INTO "prescription_items" ("id", "tenantId", "prescriptionId", "position",
             "activeIngredient", "concentration", "pharmaceuticalForm", "route", "dose",
             "frequency", "durationDays", "totalQuantity", "quantityUnit", "quantityInWords")
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 2, 'Ibuprofeno', '400 mg',
             'Tableta', 'Oral', '1 tableta', 'Cada 8 horas', 3, 9, 'tabletas', 'nueve')`,
          s.tenantId,
          s.prescriptionId,
        ),
      ).rejects.toThrow(/ya emitida/);
      await expect(
        raw.prescriptionItem.count({
          where: { prescriptionId: s.prescriptionId },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('plan de tratamiento firmado (treatment_plan_items / treatment_plans)', () => {
    const FAKE_ACCEPTANCES = [
      'CREATE TEMP TABLE treatment_plan_acceptances ("planId" uuid) ON COMMIT DROP',
    ];

    it('treatment_plan_items: rechaza cambiar el precio aunque una tabla temporal suplante treatment_plan_acceptances', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_ACCEPTANCES,
          'UPDATE "treatment_plan_items" SET "price" = 150 WHERE "id" = $1::uuid',
          s.signedItemId,
        ),
      ).rejects.toThrow(/aceptado y firmado/);
    });

    it('treatment_plan_items: rechaza el DELETE aunque una tabla temporal suplante treatment_plan_acceptances', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_ACCEPTANCES,
          'DELETE FROM "treatment_plan_items" WHERE "id" = $1::uuid',
          s.signedItemId,
        ),
      ).rejects.toThrow(/aceptado y firmado/);
    });

    it('treatment_plans: rechaza cambiar la moneda aunque una tabla temporal suplante treatment_plan_acceptances', async () => {
      await expect(
        asApp(
          s.tenantId,
          FAKE_ACCEPTANCES,
          `UPDATE "treatment_plans" SET "currency" = 'EUR' WHERE "id" = $1::uuid`,
          s.signedPlanId,
        ),
      ).rejects.toThrow(/aceptado y firmado/);
    });

    it('el plan y su ítem siguen intactos', async () => {
      await expect(
        raw.treatmentPlan.findUniqueOrThrow({ where: { id: s.signedPlanId } }),
      ).resolves.toMatchObject({ currency: 'USD' });
      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: s.signedItemId },
      });
      expect(Number(item.price)).toBe(100);
    });
  });
});
