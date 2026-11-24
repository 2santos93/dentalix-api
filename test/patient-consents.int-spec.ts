import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import {
  TemplateVersionChangedError,
  type CreatePatientConsentRepoInput,
} from '../src/modules/consents/domain/ports/patient-consent-repository.port';

// DX-006, capa DB de patient_consents / consent_templates. Cada caso escribe
// POR LA MISMA RUTA que la app (runWithTenant, rol dentalix_app, sujeto a RLS);
// `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'a'.repeat(64);

interface Seeded {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  planId: string;
  templateId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const other = await raw.patient.create({
    data: { tenantId, firstName: 'Otra', lastName: subdomain },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: patient.id, currency: 'USD' },
  });
  const template = await raw.consentTemplate.create({
    data: { tenantId, title: 'Exodoncia', body: 'Texto {{paciente}}' },
  });
  return {
    tenantId,
    patientId: patient.id,
    otherPatientId: other.id,
    planId: plan.id,
    templateId: template.id,
  };
}

function consentData(
  s: Seeded,
  extra: Partial<Prisma.PatientConsentUncheckedCreateInput> = {},
): Prisma.PatientConsentUncheckedCreateInput {
  return {
    tenantId: s.tenantId,
    patientId: s.patientId,
    templateId: s.templateId,
    templateVersion: 1,
    title: 'Exodoncia',
    body: 'Texto Ana',
    signerType: 'PATIENT',
    signerName: 'Ana',
    professionalName: 'Dra.',
    patientSignature: PNG,
    professionalSignature: PNG,
    contentHash: HASH,
    signedAt: new Date(),
    recordedById: s.patientId,
    ...extra,
  };
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  // Sin `app.current_tenant` (conexión owner): el trigger deja borrar.
  await raw.patientConsent.deleteMany({ where });
  await raw.consentTemplate.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const FK_VIOLATION = { code: 'P2003' };

describe('patient_consents: FK compuestas, RLS, inmutabilidad y CHECKs (DX-006, int)', () => {
  let a: Seeded;
  let b: Seeded;
  let consentA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('consent-int-a');
    b = await seedClinic('consent-int-b');
    const created = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.patientConsent.create({
        data: consentData(a, { treatmentPlanId: a.planId }),
      }),
    );
    consentA = created.id;
  });

  afterAll(async () => {
    await cleanup([a.tenantId, b.tenantId]);
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  describe('FK compuestas por tenant', () => {
    it('no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, { patientId: b.patientId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('no admite la plantilla de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, { templateId: b.templateId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('no admite el plan de otra clínica ni el de otro paciente', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, { treatmentPlanId: b.planId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, {
              patientId: a.otherPatientId,
              treatmentPlanId: a.planId,
            }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('RLS', () => {
    it('la clínica B no ve los consentimientos ni las plantillas de A', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, async (tx) => ({
        consents: await tx.patientConsent.findMany(),
        templates: await tx.consentTemplate.findMany(),
      }));
      expect(seen.consents).toEqual([]);
      expect(seen.templates.map((t) => t.id)).toEqual([b.templateId]);
    });

    it('no deja insertar con el tenantId de otra clínica (WITH CHECK)', async () => {
      await expect(
        asA((tx) =>
          tx.consentTemplate.create({
            data: { tenantId: b.tenantId, title: 'Intrusa', body: 'x' },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('inmutabilidad', () => {
    it('rechaza cualquier UPDATE, incluso del propio tenant', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`UPDATE "patient_consents" SET "body" = 'alterado' WHERE "id" = ${consentA}::uuid`,
        ),
      ).rejects.toThrow(/(?:inmutable)|permission denied for table/);
      await expect(
        raw.$executeRaw`UPDATE "patient_consents" SET "body" = 'alterado' WHERE "id" = ${consentA}::uuid`,
      ).rejects.toThrow(/inmutable/);
    });

    it('rechaza el DELETE dentro de un contexto de tenant (la app)', async () => {
      await expect(
        asA(
          (tx) =>
            tx.$executeRaw`DELETE FROM "patient_consents" WHERE "id" = ${consentA}::uuid`,
        ),
      ).rejects.toThrow(/(?:inmutable)|permission denied for table/);
      const row = await raw.patientConsent.findUniqueOrThrow({
        where: { id: consentA },
      });
      expect(row.body).toBe('Texto Ana');
    });

    it('un paciente con consentimientos no se puede borrar en duro (RESTRICT)', async () => {
      // `otherPatientId` no tiene plan: lo único que lo retiene es el consentimiento.
      await asA((tx) =>
        tx.patientConsent.create({
          data: consentData(a, { patientId: a.otherPatientId }),
        }),
      );
      await expect(
        raw.patient.delete({ where: { id: a.otherPatientId } }),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });

  describe('CHECKs', () => {
    it('exige un hash SHA-256 en hex', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, { contentHash: 'no-es-hash' }),
          }),
        ),
      ).rejects.toThrow(/patient_consents_content_hash_check/);
    });

    it('limita el tamaño de la firma', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, { patientSignature: 'A'.repeat(273072) }),
          }),
        ),
      ).rejects.toThrow(/patient_consents_patient_signature_check/);
    });

    it('si firma un tutor, exige su documento', async () => {
      await expect(
        asA((tx) =>
          tx.patientConsent.create({
            data: consentData(a, {
              signerType: 'GUARDIAN',
              signerDocument: ' ',
            }),
          }),
        ),
      ).rejects.toThrow(/patient_consents_guardian_document_check/);
    });
  });

  // DX-058: la versión de la plantilla se comprueba DENTRO de la transacción
  // del INSERT, con la fila en FOR SHARE: una edición en curso no se cuela.
  describe('versión de la plantilla en la transacción del INSERT (DX-058)', () => {
    const repo = new PrismaPatientConsentRepository(prisma, tenantContext);

    function repoInput(templateVersion: number): CreatePatientConsentRepoInput {
      return {
        patientId: a.patientId,
        templateId: a.templateId,
        templateVersion,
        treatmentPlanId: null,
        title: 'Exodoncia',
        body: 'Texto Ana',
        signerType: 'PATIENT',
        signerName: 'Ana',
        signerDocument: null,
        professionalName: 'Dra.',
        patientSignature: PNG,
        professionalSignature: PNG,
        contentHash: HASH,
        signedAt: new Date(),
        recordedById: a.patientId,
        ipAddress: null,
        userAgent: null,
      };
    }

    it('una edición confirmada mientras el INSERT espera: TemplateVersionChangedError y nada guardado', async () => {
      const { version } = await raw.consentTemplate.findUniqueOrThrow({
        where: { id: a.templateId },
      });
      const before = await raw.patientConsent.count({
        where: { tenantId: a.tenantId },
      });
      let insert: Promise<unknown> | undefined;
      await raw.$transaction(
        async (tx) => {
          // La edición de la plantilla: fila en FOR UPDATE y versión + 1.
          await tx.$queryRaw`
            SELECT "id" FROM "consent_templates"
             WHERE "id" = ${a.templateId}::uuid FOR UPDATE`;
          await tx.consentTemplate.update({
            where: { id: a.templateId },
            data: { version: { increment: 1 } },
          });
          // La firma (con la versión que vio) llega mientras tanto y espera.
          insert = tenantContext
            .run(a.tenantId, () => repo.create(repoInput(version)))
            .catch((error: unknown) => error);
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
        { timeout: 10_000 },
      );
      expect(await insert).toBeInstanceOf(TemplateVersionChangedError);
      expect(
        await raw.patientConsent.count({ where: { tenantId: a.tenantId } }),
      ).toBe(before);

      // Con la versión vigente, la misma firma entra.
      await expect(
        tenantContext.run(a.tenantId, () =>
          repo.create(repoInput(version + 1)),
        ),
      ).resolves.toMatchObject({ templateVersion: version + 1 });
    });
  });
});
