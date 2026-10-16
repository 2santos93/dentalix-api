import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-037, capa de BD: backfill LEGACY de la migración (extraído del .sql, no
// copiado), triggers de inmutabilidad y RLS de las dos tablas nuevas.
const MIGRATION = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261016170000_data_processing_consents/migration.sql',
  ),
  'utf8',
);
const BACKFILL =
  /^INSERT INTO "data_processing_consents"[\s\S]*?;$/m.exec(MIGRATION)?.[0] ??
  '';

// Owner/superusuario (DIRECT_URL): fixtures y limpieza.
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Rol de la app (DATABASE_URL) sujeto a RLS, como la API.
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['consents-db-a', 'consents-db-b'];
const EMAIL = 'consents-db@x.com';

class Rollback extends Error {}

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await owner.dataProcessingConsent.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await owner.privacyPolicyVersion.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await owner.patient.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  await owner.user.deleteMany({ where: { email: EMAIL } });
}

describe('DX-037 · autorizaciones de datos en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let userId: string;
  let policyA: string;
  let consentA: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
    userId = (
      await owner.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Recepción' },
      })
    ).id;
    const patientA = await owner.patient.create({
      data: { tenantId: tenantA, firstName: 'Ana', lastName: 'A' },
    });
    policyA = (
      await owner.privacyPolicyVersion.create({
        data: {
          tenantId: tenantA,
          version: 1,
          policyText: 'p',
          generalText: 'g',
          sensitiveHealthText: 's',
          marketingText: 'm',
          contentHash: 'h',
          publishedById: userId,
        },
      })
    ).id;
    consentA = (
      await owner.dataProcessingConsent.create({
        data: {
          tenantId: tenantA,
          patientId: patientA.id,
          policyVersionId: policyA,
          scope: 'GENERAL',
          granted: true,
          channel: 'IN_PERSON',
          recordedById: userId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  describe('backfill LEGACY de la migración', () => {
    it('la migración apaga row_security antes de la primera sentencia', () => {
      expect(BACKFILL).toContain('FROM "patients" p');
      const before = MIGRATION.slice(
        0,
        MIGRATION.indexOf('SET LOCAL row_security = off;'),
      )
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
      expect(before).toEqual([]);
    });

    it('pasa cada decisión del booleano a una fila GENERAL LEGACY, sin pérdida', async () => {
      const acceptedAt = new Date('2026-03-01T09:30:00.000Z');
      const rejectedAt = new Date('2026-03-02T10:00:00.000Z');
      const updatedAt = new Date('2026-03-03T11:00:00.000Z');
      await expect(
        owner.$transaction(async (tx) => {
          const mk = (data: Prisma.PatientUncheckedCreateInput) =>
            tx.patient.create({ data });
          const accepted = await mk({
            tenantId: tenantB,
            firstName: 'Acepta',
            lastName: 'B',
            dataConsentAccepted: true,
            dataConsentAt: acceptedAt,
            dataConsentPolicyVersion: 'v1',
          });
          const acceptedNoDate = await mk({
            tenantId: tenantB,
            firstName: 'SinFecha',
            lastName: 'B',
            dataConsentAccepted: true,
            updatedAt,
          });
          const rejected = await mk({
            tenantId: tenantB,
            firstName: 'Rechaza',
            lastName: 'B',
            dataConsentAccepted: false,
            dataConsentAt: rejectedAt,
          });
          const silent = await mk({
            tenantId: tenantB,
            firstName: 'Silencio',
            lastName: 'B',
          });
          const retired = await mk({
            tenantId: tenantB,
            firstName: 'Retirado',
            lastName: 'B',
            dataConsentAccepted: true,
            dataConsentAt: acceptedAt,
            deletedAt: new Date(),
          });

          await tx.$executeRawUnsafe(BACKFILL);
          const rows = await tx.dataProcessingConsent.findMany({
            where: { tenantId: tenantB },
          });
          const byPatient = new Map(rows.map((r) => [r.patientId, r]));

          expect(byPatient.get(accepted.id)).toMatchObject({
            scope: 'GENERAL',
            granted: true,
            channel: 'LEGACY',
            policyVersionId: null,
            legacyPolicyVersion: 'v1',
            recordedById: null,
            recordedAt: acceptedAt,
          });
          // Sin fecha: la de la última modificación del paciente.
          expect(byPatient.get(acceptedNoDate.id)?.recordedAt.getTime()).toBe(
            (
              await tx.patient.findUniqueOrThrow({
                where: { id: acceptedNoDate.id },
              })
            ).updatedAt.getTime(),
          );
          expect(byPatient.get(rejected.id)).toMatchObject({
            granted: false,
            recordedAt: rejectedAt,
          });
          // `false` sin fecha es el valor por defecto, no una decisión.
          expect(byPatient.has(silent.id)).toBe(false);
          // La prueba de un paciente retirado también se conserva.
          expect(byPatient.get(retired.id)?.granted).toBe(true);
          expect(rows).toHaveLength(4);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
    });
  });

  describe('inmutabilidad (triggers)', () => {
    it('una política publicada no se puede editar, ni siquiera como owner', async () => {
      await expect(
        owner.privacyPolicyVersion.update({
          where: { id: policyA },
          data: { policyText: 'texto cambiado' },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('una autorización no se puede modificar, ni siquiera como owner', async () => {
      await expect(
        owner.dataProcessingConsent.update({
          where: { id: consentA },
          data: { granted: false },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('el rol de la app no puede borrar ni políticas ni autorizaciones', async () => {
      // SQL crudo a propósito: `guardHardDeletes` ya frena `.delete()` en
      // runWithTenant; aquí se prueba la barrera de la propia BD.
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`DELETE FROM "data_processing_consents" WHERE "id" = ${consentA}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`DELETE FROM "privacy_policy_versions" WHERE "id" = ${policyA}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
      expect(
        await owner.dataProcessingConsent.count({ where: { id: consentA } }),
      ).toBe(1);
    });
  });

  describe('RLS por tenant', () => {
    it('la clínica B no ve las políticas ni las autorizaciones de la clínica A', async () => {
      const seen = await prisma.runWithTenant(tenantB, async (tx) => ({
        policies: await tx.privacyPolicyVersion.count(),
        consents: await tx.dataProcessingConsent.count(),
      }));
      expect(seen).toEqual({ policies: 0, consents: 0 });
      const own = await prisma.runWithTenant(tenantA, (tx) =>
        tx.dataProcessingConsent.count(),
      );
      expect(own).toBe(1);
    });

    it('una fila que no es LEGACY exige versión de política y quién la registró', async () => {
      const patient = await owner.patient.findFirstOrThrow({
        where: { tenantId: tenantA },
      });
      await expect(
        owner.dataProcessingConsent.create({
          data: {
            tenantId: tenantA,
            patientId: patient.id,
            scope: 'MARKETING',
            granted: true,
            channel: 'IN_PERSON',
          },
        }),
      ).rejects.toThrow(/data_processing_consents_evidence_check/);
    });

    it('la FK compuesta impide citar la política de otra clínica', async () => {
      const patientB = await owner.patient.create({
        data: { tenantId: tenantB, firstName: 'Bea', lastName: 'B' },
      });
      await expect(
        owner.dataProcessingConsent.create({
          data: {
            tenantId: tenantB,
            patientId: patientB.id,
            policyVersionId: policyA,
            scope: 'GENERAL',
            granted: true,
            channel: 'IN_PERSON',
            recordedById: userId,
          },
        }),
      ).rejects.toThrow(/Foreign key constraint/);
    });
  });
});
