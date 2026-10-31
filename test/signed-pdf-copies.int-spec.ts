import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { InMemoryFileStorage } from '../src/shared/storage/__fixtures__/in-memory-file-storage';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { PrismaSignedConsentPdfRepository } from '../src/modules/consents/infrastructure/repositories/prisma-signed-consent-pdf.repository';
import { PrismaSignedPdfCopyRepository } from '../src/modules/consents/infrastructure/repositories/prisma-signed-pdf-copy.repository';
import { PdfkitSignedConsentPdfRenderer } from '../src/modules/consents/infrastructure/pdf/signed-consent-pdf.renderer';
import {
  GenerateSignedConsentPdf,
  SIGNED_CONSENT_PDF_JOB,
  SignedConsentPdfAudit,
  SignedConsentPdfQueue,
  signedConsentPdfJobKey,
} from '../src/modules/consents/application/signed-consent-pdf.service';
import {
  BackfillSignedConsentPdfs,
  SIGNED_PDF_COPY_JOB,
  SendSignedPdfCopyJob,
  SignedPdfCopyQueue,
  SignedPdfCopySender,
  signedPdfCopyJobKey,
} from '../src/modules/consents/application/signed-pdf-copy.service';
import { hashSignedPdfCopyToken } from '../src/modules/consents/domain/signed-pdf-copy-link';
import type { SignedConsentCopyEmailVars } from '../src/modules/notifications/email/domain/email-message';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobRegistry } from '../src/modules/jobs/application/job-registry';
import { PrismaJobRepository } from '../src/modules/jobs/infrastructure/prisma-job.repository';
import type { JobContext } from '../src/modules/jobs/domain/job';
import type { JobsConfig } from '../src/modules/jobs/infrastructure/jobs-config';
import { resetDatabase } from './support/e2e-fixtures';
import {
  signedConsentFixtures,
  type Seeded,
} from './support/signed-consent-fixtures';

// DX-443 contra Postgres: el enlace de la copia del PDF firmado
// (signed_consent_pdf_links) con RLS FORCE, solo el hash del token, un solo
// uso (UPDATE condicional), uno vivo por consentimiento (índice parcial),
// auditoría PUBLIC_LINK sin actor que el CHECK admite, y el barrido
// retroactivo idempotente.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const requests = new PrismaSignatureRequestRepository(prisma, tenantContext);
const consents = new PrismaPatientConsentRepository(prisma, tenantContext);
const pdfs = new PrismaSignedConsentPdfRepository(prisma, tenantContext);
const copies = new PrismaSignedPdfCopyRepository(prisma, tenantContext);
const { seedClinic, asClinic, remoteSigned, countersign } =
  signedConsentFixtures({ owner, tenantContext, requests, consents });

const jobsConfig: JobsConfig = {
  role: 'worker',
  workerEnabled: false,
  workerId: 'int:443:00000000',
  pollIntervalMs: 100,
  concurrency: 1,
  leaseSeconds: 300,
  maxAttempts: 5,
  retryBaseMs: 60_000,
  shutdownGraceMs: 5_000,
  heartbeatMs: 50,
  retentionDays: 14,
  healthPort: null,
  version: null,
};
const registry = new JobRegistry();
registry.register({
  name: SIGNED_CONSENT_PDF_JOB,
  handle: () => Promise.resolve(),
});
registry.register({
  name: SIGNED_PDF_COPY_JOB,
  handle: () => Promise.resolve(),
});
const jobs = new JobQueue(
  new PrismaJobRepository(prisma),
  registry,
  jobsConfig,
  tenantContext,
);
const pdfQueue = new SignedConsentPdfQueue(jobs);
const copyQueue = new SignedPdfCopyQueue(jobs);

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
  copyQueue,
);

const emails: {
  to: string;
  referenceId: string;
  vars: SignedConsentCopyEmailVars;
}[] = [];
const sender = new SignedPdfCopySender(
  copies,
  {
    send: (input) => {
      emails.push(input);
      return Promise.resolve();
    },
  },
  { forTenant: () => Promise.resolve('http://int.localhost:3001') },
  tenantContext,
  { ttlHours: 168 },
  () => new Date(),
);
const sendJob = new SendSignedPdfCopyJob(copies, sender);
const META = { requestId: null, ip: '203.0.113.9', userAgent: 'int-public' };

const jobContext = (tenantId: string): JobContext => ({
  jobId: randomUUID(),
  attempt: 1,
  maxAttempts: 6,
  tenantId,
  signal: new AbortController().signal,
});

/** Completo, archivado (READY) y con su copia enviada: devuelve el token. */
async function readyWithCopy(s: Seeded): Promise<{
  consentId: string;
  token: string;
}> {
  const consentId = await remoteSigned(s);
  await countersign(s, consentId, (tx) => pdfQueue.schedule(tx, consentId));
  await asClinic(s.tenantId, () =>
    generator.handle({ consentId }, jobContext(s.tenantId)),
  );
  await asClinic(s.tenantId, () => sendJob.handle({ consentId }));
  const email = emails[emails.length - 1];
  return { consentId, token: email.vars.url.split('/copia/')[1] };
}

const asApp = <T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(tenantId, fn);

describe('Copia del PDF firmado en Postgres (DX-443)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx443-int-a');
    b = await seedClinic('dx443-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('al archivar el PDF se encola la copia EN la misma transacción, y el envío guarda solo el hash', async () => {
    const consentId = await remoteSigned(a);
    await countersign(a, consentId, (tx) => pdfQueue.schedule(tx, consentId));
    await asClinic(a.tenantId, () =>
      generator.handle({ consentId }, jobContext(a.tenantId)),
    );
    const job = await owner.job.findFirstOrThrow({
      where: { idempotencyKey: signedPdfCopyJobKey(consentId) },
    });
    expect(job).toMatchObject({
      name: SIGNED_PDF_COPY_JOB,
      tenantId: a.tenantId,
      payload: { consentId },
    });

    await asClinic(a.tenantId, () => sendJob.handle({ consentId }));
    const email = emails[emails.length - 1];
    expect(email.to).toBe('ana@example.com');
    const token = email.vars.url.split('/copia/')[1];
    const links = await owner.signedConsentPdfLink.findMany({
      where: { consentId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      tenantId: a.tenantId,
      patientId: a.patientId,
      tokenHash: hashSignedPdfCopyToken(token),
      createdById: null,
      usedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(links)).not.toContain(token);
    expect(email.referenceId).toBe(links[0].id);
    // El email no lleva el título del documento.
    expect(JSON.stringify(email.vars)).not.toMatch(/Exodoncia|Consentimiento/);
  });

  it('un solo uso: la primera descarga lo gasta y lo audita (PUBLIC_LINK, sin actor); la segunda es USED', async () => {
    const { consentId, token } = await readyWithCopy(a);
    const link = await asClinic(a.tenantId, () =>
      copies.findLinkByTokenHash(hashSignedPdfCopyToken(token)),
    );
    expect(link).not.toBeNull();
    const now = new Date();
    const first = await asClinic(a.tenantId, () =>
      copies.consumeLink(link!.id, now, META),
    );
    expect(first.kind).toBe('CONSUMED');
    if (first.kind === 'CONSUMED') {
      expect(first.download.mimeType).toBe('application/pdf');
      expect(storage.files.has(first.download.storageKey)).toBe(true);
    }
    const second = await asClinic(a.tenantId, () =>
      copies.consumeLink(link!.id, new Date(), META),
    );
    expect(second).toEqual({ kind: 'USED' });
    const events = await owner.auditEvent.findMany({
      where: { resourceId: consentId, action: 'EXPORT' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: a.tenantId,
      actorUserId: null,
      actorRole: null,
      resourceType: 'CONSENT',
      patientId: a.patientId,
      locationId: a.locationId,
      ip: '203.0.113.9',
      metadata: {
        origin: 'PUBLIC_LINK',
        reason: 'SIGNED_PDF_COPY_DOWNLOADED',
      },
    });
  });

  it('dos descargas a la vez: una gana y queda un solo evento', async () => {
    const { consentId, token } = await readyWithCopy(a);
    const link = await asClinic(a.tenantId, () =>
      copies.findLinkByTokenHash(hashSignedPdfCopyToken(token)),
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        asClinic(a.tenantId, () =>
          copies.consumeLink(link!.id, new Date(), META),
        ),
      ),
    );
    expect(results.map((r) => r.kind).sort()).toEqual(['CONSUMED', 'USED']);
    expect(
      await owner.auditEvent.count({
        where: { resourceId: consentId, action: 'EXPORT' },
      }),
    ).toBe(1);
  });

  it('caducado: no se gasta (GONE)', async () => {
    const { token } = await readyWithCopy(a);
    const link = await asClinic(a.tenantId, () =>
      copies.findLinkByTokenHash(hashSignedPdfCopyToken(token)),
    );
    const later = new Date(link!.expiresAt.getTime() + 1);
    await expect(
      asClinic(a.tenantId, () => copies.consumeLink(link!.id, later, META)),
    ).resolves.toEqual({ kind: 'GONE' });
  });

  it('reenviar invalida el anterior en la misma transacción; como mucho uno vivo', async () => {
    const { consentId, token } = await readyWithCopy(a);
    const target = await asClinic(a.tenantId, () =>
      copies.loadTarget(consentId, a.patientId),
    );
    expect(target).toMatchObject({ ready: true, notifyPatient: true });
    await asClinic(a.tenantId, () => sender.send(target!, a.userId));
    const rows = await owner.signedConsentPdfLink.findMany({
      where: { consentId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1]).toMatchObject({ createdById: a.userId, revokedAt: null });
    const old = await asClinic(a.tenantId, () =>
      copies.findLinkByTokenHash(hashSignedPdfCopyToken(token)),
    );
    await expect(
      asClinic(a.tenantId, () => copies.consumeLink(old!.id, new Date(), META)),
    ).resolves.toEqual({ kind: 'GONE' });
    // Índice parcial: un segundo enlace vivo del mismo consentimiento no entra.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.signedConsentPdfLink.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            consentId,
            tokenHash: 'f'.repeat(64),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        }),
      ),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('dos reenvíos a la vez se serializan: ninguno choca con el índice parcial y queda un solo enlace vivo', async () => {
    const { consentId } = await readyWithCopy(a);
    const target = await asClinic(a.tenantId, () =>
      copies.loadTarget(consentId, a.patientId),
    );
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        asClinic(a.tenantId, () => sender.send(target!, a.userId)),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const live = await owner.signedConsentPdfLink.count({
      where: { consentId, usedAt: null, revokedAt: null },
    });
    expect(live).toBe(1);
    expect(
      await owner.signedConsentPdfLink.count({ where: { consentId } }),
    ).toBe(4);
  });

  it('RLS: desde otra clínica el enlace y el consentimiento no existen', async () => {
    const { consentId, token } = await readyWithCopy(a);
    await expect(
      asClinic(b.tenantId, () =>
        copies.findLinkByTokenHash(hashSignedPdfCopyToken(token)),
      ),
    ).resolves.toBeNull();
    await expect(
      asClinic(b.tenantId, () => copies.loadTarget(consentId)),
    ).resolves.toBeNull();
    // WITH CHECK: no se puede crear un enlace con la clínica de otra.
    await expect(
      asApp(b.tenantId, (tx) =>
        tx.signedConsentPdfLink.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            consentId,
            tokenHash: 'e'.repeat(64),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('trigger y grants: solo se marca usado o invalidado, una vez; sin DELETE', async () => {
    const { consentId } = await readyWithCopy(a);
    const [row] = await owner.signedConsentPdfLink.findMany({
      where: { consentId },
    });
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.signedConsentPdfLink.update({
          where: { id: row.id },
          data: { tokenHash: 'd'.repeat(64) },
        }),
      ),
    ).rejects.toThrow(/solo se marca usado o invalidado/);
    await asApp(a.tenantId, (tx) =>
      tx.signedConsentPdfLink.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
    );
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.signedConsentPdfLink.update({
          where: { id: row.id },
          data: { usedAt: null },
        }),
      ),
    ).rejects.toThrow(/usado o invalidado no cambia/);
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.signedConsentPdfLink.delete({ where: { id: row.id } }),
      ),
    ).rejects.toThrow();
    // CHECK: nunca un token en claro.
    await expect(
      asApp(a.tenantId, (tx) =>
        tx.signedConsentPdfLink.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            consentId,
            tokenHash: 'token-en-claro',
            expiresAt: new Date(Date.now() + 3600_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('retroactivo: genera el estado de los completos sin PDF, sin duplicar y repetible sin efectos', async () => {
    const consentId = await remoteSigned(b);
    // Un consentimiento completado antes de DX-422 (o en una réplica
    // antigua): la firma del profesional sin fila en signed_consent_pdfs.
    const consent = await owner.patientConsent.findFirstOrThrow({
      where: { id: consentId },
    });
    await owner.patientConsentCountersignature.create({
      data: {
        tenantId: b.tenantId,
        patientId: b.patientId,
        consentId,
        professionalUserId: b.userId,
        professionalName: consent.professionalName,
        professionalSignature: consent.patientSignature,
        contentHash: 'a'.repeat(64),
        signedAt: new Date(),
      },
    });
    // Uno ya con PDF en la misma clínica no se toca.
    const withPdf = await remoteSigned(b);
    await countersign(b, withPdf, (tx) => pdfQueue.schedule(tx, withPdf));

    const sweep = new BackfillSignedConsentPdfs(copies, pdfQueue);
    const first = await sweep.run();
    expect(first.queued).toBeGreaterThanOrEqual(1);
    const state = await owner.signedConsentPdf.findFirstOrThrow({
      where: { consentId },
    });
    expect(state).toMatchObject({
      tenantId: b.tenantId,
      status: 'PENDING',
      notifyPatient: false,
    });
    expect(
      await owner.job.count({
        where: { idempotencyKey: signedConsentPdfJobKey(consentId) },
      }),
    ).toBe(1);
    expect(
      await owner.signedConsentPdf.count({ where: { consentId: withPdf } }),
    ).toBe(1);

    await expect(sweep.run()).resolves.toEqual({ queued: 0 });
    expect(await owner.signedConsentPdf.count({ where: { consentId } })).toBe(
      1,
    );
    expect(
      await owner.job.count({
        where: { idempotencyKey: signedConsentPdfJobKey(consentId) },
      }),
    ).toBe(1);

    // Ya generado, no se le escribe al paciente.
    const emailsBefore = emails.length;
    const loaded = await asClinic(b.tenantId, () =>
      copies.loadTarget(consentId),
    );
    expect(loaded).toMatchObject({ notifyPatient: false });
    await asClinic(b.tenantId, () => sendJob.handle({ consentId }));
    expect(emails).toHaveLength(emailsBefore);
  });
});
