import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { InMemoryFileStorage } from '../src/shared/storage/__fixtures__/in-memory-file-storage';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { PrismaSignedConsentPdfRepository } from '../src/modules/consents/infrastructure/repositories/prisma-signed-consent-pdf.repository';
import { PdfkitSignedConsentPdfRenderer } from '../src/modules/consents/infrastructure/pdf/signed-consent-pdf.renderer';
import {
  GenerateSignedConsentPdf,
  SignedConsentPdfAudit,
} from '../src/modules/consents/application/signed-consent-pdf.service';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import type { JobContext } from '../src/modules/jobs/domain/job';
import { resetDatabase } from './support/e2e-fixtures';
import {
  signedConsentFixtures,
  type Seeded,
} from './support/signed-consent-fixtures';

// DX-422 contra Postgres: el estado del PDF firmado (signed_consent_pdfs) con
// RLS FORCE y FK compuestas; nace PENDING con la firma del profesional (en
// la misma transacción); el trabajo lo archiva en patient_documents
// (inalterable) y la fila READY queda congelada; sin DELETE.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const requests = new PrismaSignatureRequestRepository(prisma, tenantContext);
const consents = new PrismaPatientConsentRepository(prisma, tenantContext);
const pdfs = new PrismaSignedConsentPdfRepository(prisma, tenantContext);

const { seedClinic, asClinic, remoteSigned, countersign } =
  signedConsentFixtures({ owner, tenantContext, requests, consents });

const jobContext = (tenantId: string, attempt = 1): JobContext => ({
  jobId: randomUUID(),
  attempt,
  maxAttempts: 6,
  tenantId,
  signal: new AbortController().signal,
});

describe('PDF firmado en Postgres (DX-422)', () => {
  let a: Seeded;
  let b: Seeded;
  const storage = new InMemoryFileStorage();
  const generator = new GenerateSignedConsentPdf(
    pdfs,
    storage,
    new PdfkitSignedConsentPdfRenderer(),
    tenantContext,
    new SignedConsentPdfAudit(
      new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
      tenantContext,
    ),
    // DX-443: el envío de la copia se prueba en signed-pdf-copies.int-spec.ts.
    { schedule: () => Promise.resolve() },
  );
  const generate = (s: Seeded, consentId: string) =>
    asClinic(s.tenantId, () =>
      generator.handle({ consentId }, jobContext(s.tenantId)),
    );

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx422-int-a');
    b = await seedClinic('dx422-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('nace PENDING con la firma del profesional, en la misma transacción que el encolado', async () => {
    const consentId = await remoteSigned(a);
    const seen: string[] = [];
    await countersign(a, consentId, async (tx) => {
      const rows = await tx.signedConsentPdf.findMany({ where: { consentId } });
      seen.push(...rows.map((r) => r.status));
    });
    expect(seen).toEqual(['PENDING']);
    // Si el encolado falla, la firma tampoco queda (outbox).
    const other = await remoteSigned(a);
    await expect(
      countersign(a, other, () => Promise.reject(new Error('cola caída'))),
    ).rejects.toThrow('cola caída');
    expect(
      await owner.patientConsentCountersignature.count({
        where: { consentId: other },
      }),
    ).toBe(0);
    expect(
      await owner.signedConsentPdf.count({ where: { consentId: other } }),
    ).toBe(0);
  });

  it('el trabajo archiva el PDF en los documentos del paciente (SIGNED_CONSENT) y queda READY', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId);
    await generate(a, consentId);
    const state = await owner.signedConsentPdf.findFirstOrThrow({
      where: { consentId },
    });
    expect(state).toMatchObject({ status: 'READY', lastErrorCode: null });
    const doc = await owner.patientDocument.findUniqueOrThrow({
      where: { id: state.documentId! },
    });
    expect(doc).toMatchObject({
      patientId: a.patientId,
      locationId: a.locationId,
      category: 'SIGNED_CONSENT',
      mimeType: 'application/pdf',
      uploadedById: a.userId,
    });
    const stored = storage.files.get(doc.storageKey);
    expect(stored?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(stored!.bytes).digest('hex')).toBe(
      doc.sha256,
    );
    expect(stored!.bytes.length).toBe(doc.sizeBytes);
    // Repetir el trabajo no crea otro documento.
    await generate(a, consentId);
    expect(
      await owner.patientDocument.count({
        where: { patientId: a.patientId, category: 'SIGNED_CONSENT' },
      }),
    ).toBe(1);
  });

  it('inmutable: ni el documento archivado ni su estado READY cambian, y no se borran', async () => {
    const { consentId, documentId } =
      (await owner.signedConsentPdf.findFirstOrThrow({
        where: { tenantId: a.tenantId, status: 'READY' },
      })) as { consentId: string; documentId: string };
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "patient_documents" SET "originalName" = 'otro.pdf' WHERE "id" = ${documentId}::uuid`,
      ),
    ).rejects.toThrow(/inalterable/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "signed_consent_pdfs" SET "status" = 'FAILED', "documentId" = NULL WHERE "consentId" = ${consentId}::uuid`,
      ),
    ).rejects.toThrow(/inalterable/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "signed_consent_pdfs" WHERE "consentId" = ${consentId}::uuid`,
      ),
    ).rejects.toThrow(/no se borra|permission denied/);
  });

  it('RLS: el consentimiento de A no existe con el tenant de B (ni para generar ni para reintentar)', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId);
    await expect(
      asClinic(b.tenantId, () => pdfs.loadForJob(consentId)),
    ).resolves.toBeNull();
    await expect(
      asClinic(b.tenantId, () =>
        pdfs.requestRetry(a.patientId, consentId, () => Promise.resolve()),
      ),
    ).resolves.toBe('NOT_FOUND');
    expect(
      await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.signedConsentPdf.count(),
      ),
    ).toBe(0);
    // WITH CHECK: B no puede crear un estado con el tenant de A.
    await expect(
      prisma.runWithTenant(b.tenantId, (tx) =>
        tx.signedConsentPdf.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            consentId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('FK compuesta: el estado no puede apuntar a un consentimiento de otro paciente', async () => {
    const consentId = await remoteSigned(a);
    const other = await owner.patient.create({
      data: { tenantId: a.tenantId, firstName: 'Otro', lastName: 'Int' },
    });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.signedConsentPdf.create({
          data: { tenantId: a.tenantId, patientId: other.id, consentId },
        }),
      ),
    ).rejects.toThrow();
  });

  it('un fallo definitivo queda FAILED; «Reintentar» lo vuelve a PENDING una sola vez', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId);
    await asClinic(a.tenantId, () =>
      pdfs.recordFailure(consentId, { code: 'STORAGE_ERROR', final: false }),
    );
    expect(
      await owner.signedConsentPdf.findFirstOrThrow({ where: { consentId } }),
    ).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastErrorCode: 'STORAGE_ERROR',
    });
    await asClinic(a.tenantId, () =>
      pdfs.recordFailure(consentId, { code: 'STORAGE_ERROR', final: true }),
    );
    const enqueued: number[] = [];
    const retry = () =>
      asClinic(a.tenantId, () =>
        pdfs.requestRetry(a.patientId, consentId, (_tx, attempt) => {
          enqueued.push(attempt);
          return Promise.resolve();
        }),
      );
    await expect(retry()).resolves.toBe('RETRYING');
    await expect(retry()).resolves.toBe('NOT_FAILED');
    expect(enqueued).toEqual([2]);
    expect(
      await owner.signedConsentPdf.findFirstOrThrow({ where: { consentId } }),
    ).toMatchObject({ status: 'PENDING', lastErrorCode: null });
  });

  it('CHECK: READY exige documento y el código de error es técnico', async () => {
    const consentId = await remoteSigned(a);
    await expect(
      owner.signedConsentPdf.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          consentId,
          status: 'READY',
        },
      }),
    ).rejects.toThrow(/signed_consent_pdfs_ready_check/);
    await expect(
      owner.signedConsentPdf.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patientId,
          consentId,
          lastErrorCode: 'ana@example.com',
        },
      }),
    ).rejects.toThrow(/signed_consent_pdfs_error_check/);
  });

  it('M2: un consentimiento alterado no se archiva y deja un evento de sistema (sin actor, solo ids) que la BD admite', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId);
    // Alterar el texto firmado por fuera de la app (superusuario sin triggers).
    await owner.$transaction([
      owner.$executeRaw`SET LOCAL session_replication_role = replica`,
      owner.$executeRaw`UPDATE "patient_consents" SET "body" = 'Otro texto' WHERE "id" = ${consentId}::uuid`,
    ]);
    await generate(a, consentId);
    expect(
      await owner.signedConsentPdf.findFirstOrThrow({ where: { consentId } }),
    ).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'INTEGRITY_MISMATCH',
      documentId: null,
    });
    const events = await owner.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceId: consentId,
        resourceType: 'CONSENT',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'VIEW',
      actorUserId: null,
      actorRole: null,
      patientId: a.patientId,
      metadata: { reason: 'SIGNED_PDF_INTEGRITY_MISMATCH', origin: 'JOB' },
    });
  });

  it('M1: el aviso de intento agotado deja FAILED con LEASE_EXPIRED', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId);
    await asClinic(a.tenantId, () => generator.exhausted({ consentId }));
    expect(
      await owner.signedConsentPdf.findFirstOrThrow({ where: { consentId } }),
    ).toMatchObject({ status: 'FAILED', lastErrorCode: 'LEASE_EXPIRED' });
  });

  it('RLS ENABLE + FORCE en la tabla nueva', async () => {
    const rows = await owner.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'signed_consent_pdfs'`;
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
});
