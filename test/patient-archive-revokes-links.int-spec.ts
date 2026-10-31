import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, SignatureRequestType } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import { PrismaPatientPublicLinksRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient-public-links.repository';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { assertNoPendingAppointments } from '../src/modules/patients/application/retention-guard';
import { PATIENT_ARCHIVED_LINKS_REVOKED_REASON } from '../src/modules/patients/domain/live-public-links';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { resetDatabase } from './support/e2e-fixtures';
import {
  signedConsentFixtures,
  type Seeded,
} from './support/signed-consent-fixtures';

// DX-461 contra Postgres (rol dentalix_app, RLS FORCE): archivar un paciente
// anula en LA MISMA transacción sus enlaces públicos vivos —oferta de hueco,
// firma y presupuesto a distancia, copia del PDF firmado y anamnesis— y deja
// en audit_event cuántos de cada tipo. Lo caducado, usado o de otro paciente
// (o de otra clínica) no se toca; si archivar falla, no se anula nada; y
// desarchivar no los reactiva. DIRECT_URL (superusuario) siembra y comprueba.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const patients = new PrismaPatientRepository(prisma, tenantContext);
const links = new PrismaPatientPublicLinksRepository(prisma, tenantContext);
const requests = new PrismaSignatureRequestRepository(prisma, tenantContext);
const consents = new PrismaPatientConsentRepository(prisma, tenantContext);
const { seedClinic, asClinic, remoteSigned } = signedConsentFixtures({
  owner,
  tenantContext,
  requests,
  consents,
});

const HOUR = 3_600_000;
const hash = () => randomBytes(32).toString('hex');
const inHours = (h: number) => new Date(Date.now() + h * HOUR);
const noAssert = () => undefined;

function ctxOf(s: Seeded, userId = s.userId): AuditRequestContext {
  return {
    tenantId: s.tenantId,
    locationId: null,
    actor: { userId, role: 'ADMIN' },
    requestId: 'int-dx461',
    ip: '203.0.113.61',
    userAgent: 'int-dx461',
  };
}

async function newPatient(s: Seeded, name: string): Promise<string> {
  return (
    await owner.patient.create({
      data: {
        tenantId: s.tenantId,
        firstName: name,
        lastName: 'DX461',
        docNumber: randomUUID().slice(0, 12),
      },
    })
  ).id;
}

/** Oferta de hueco; con enlace salvo `channel: 'PHONE'`. */
async function slotOffer(
  s: Seeded,
  patientId: string,
  expiresAt: Date,
  channel: 'LINK_EMAIL' | 'PHONE' = 'LINK_EMAIL',
): Promise<string> {
  const slotStart = new Date(expiresAt.getTime() + HOUR);
  const withLink = channel === 'LINK_EMAIL';
  return (
    await owner.waitlistOffer.create({
      data: {
        tenantId: s.tenantId,
        locationId: s.locationId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + HOUR),
        providerId: s.userId,
        patientId,
        channel,
        offerDay: new Date(slotStart.toISOString().slice(0, 10)),
        createdById: s.userId,
        tokenHash: withLink ? hash() : null,
        expiresAt: withLink ? expiresAt : null,
      },
    })
  ).id;
}

async function signatureRequest(
  s: Seeded,
  patientId: string,
  type: SignatureRequestType,
  expiresAt: Date,
): Promise<string> {
  const plan =
    type === 'BUDGET'
      ? await owner.treatmentPlan.create({
          data: {
            tenantId: s.tenantId,
            patientId,
            currency: 'COP',
          },
        })
      : null;
  return (
    await owner.signatureRequest.create({
      data: {
        tenantId: s.tenantId,
        locationId: s.locationId,
        patientId,
        type,
        channel: 'EMAIL',
        templateId: type === 'CONSENT' ? s.templateId : null,
        templateVersion: type === 'CONSENT' ? 1 : null,
        treatmentPlanId: plan?.id ?? null,
        title: 'Documento a distancia',
        body: 'Texto del documento',
        professionalUserId: s.userId,
        professionalName: 'Dra. Int',
        signerType: 'PATIENT',
        signerName: 'Paciente DX461',
        destination: 'paciente@example.com',
        destinationMasked: 'pa***@example.com',
        tokenHash: hash(),
        expiresAt,
        createdById: s.userId,
        createdAt: new Date(expiresAt.getTime() - 72 * HOUR),
        budgetContent: type === 'BUDGET' ? { items: [] } : undefined,
        budgetContentHash: type === 'BUDGET' ? hash() : null,
      },
    })
  ).id;
}

/** Copia del PDF de un consentimiento firmado a distancia (uno por enlace). */
async function pdfCopyLink(
  s: Seeded,
  patientId: string,
  expiresAt: Date,
  usedAt: Date | null = null,
): Promise<string> {
  const consentId = await remoteSigned({ ...s, patientId });
  await owner.signedConsentPdf.create({
    data: { tenantId: s.tenantId, patientId, consentId },
  });
  return (
    await owner.signedConsentPdfLink.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        consentId,
        tokenHash: hash(),
        expiresAt,
        createdAt: new Date(expiresAt.getTime() - 72 * HOUR),
        usedAt,
      },
    })
  ).id;
}

async function anamnesis(
  s: Seeded,
  patientId: string,
  expiresAt: Date,
): Promise<string> {
  return (
    await owner.medicalHistorySubmission.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        locationId: s.locationId,
        tokenHash: hash(),
        expiresAt,
        questionnaireVersion: 'v1',
        createdById: s.userId,
      },
    })
  ).id;
}

/**
 * Un enlace vivo de cada tipo. La copia del PDF va primero: su consentimiento
 * se envía con la misma plantilla y enviar anula la solicitud anterior aún sin
 * firmar (un solo enlace vivo por documento).
 */
async function liveLinksFor(s: Seeded, patientId: string) {
  const pdf = await pdfCopyLink(s, patientId, inHours(72));
  return {
    pdf,
    offer: await slotOffer(s, patientId, inHours(24)),
    consent: await signatureRequest(s, patientId, 'CONSENT', inHours(48)),
    budget: await signatureRequest(s, patientId, 'BUDGET', inHours(48)),
    anamnesis: await anamnesis(s, patientId, inHours(24)),
  };
}

const revokedEvents = (s: Seeded, patientId: string) =>
  owner.auditEvent.findMany({
    where: {
      tenantId: s.tenantId,
      resourceType: 'PATIENT',
      resourceId: patientId,
      metadata: {
        path: ['reason'],
        equals: PATIENT_ARCHIVED_LINKS_REVOKED_REASON,
      },
    },
  });

describe('Archivar un paciente anula sus enlaces públicos (DX-461, Postgres)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx461-int-a');
    b = await seedClinic('dx461-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('anula en la misma transacción solo los vivos de ese paciente y audita el número por tipo', async () => {
    const p = await newPatient(a, 'Archivada');
    // Lo que ya no vale (caducado, usado) o no lleva enlace no se toca.
    const usedPdf = await pdfCopyLink(a, p, inHours(72), new Date());
    const live = await liveLinksFor(a, p);
    const expiredOffer = await slotOffer(a, p, inHours(-1));
    const phoneOffer = await slotOffer(a, p, inHours(24), 'PHONE');
    const expiredConsent = await signatureRequest(a, p, 'CONSENT', inHours(-1));
    const expiredAnamnesis = await anamnesis(a, p, inHours(-1));
    // Otro paciente de la clínica y otra clínica: intactos.
    const other = await newPatient(a, 'Vecina');
    const otherLive = await liveLinksFor(a, other);
    const foreign = await liveLinksFor(b, b.patientId);

    await expect(
      asClinic(a.tenantId, () => links.countLive(p, new Date())),
    ).resolves.toEqual({
      slotOffers: 1,
      consentSignatures: 1,
      budgetSignatures: 1,
      signedPdfCopies: 1,
      anamnesis: 1,
    });

    const now = new Date();
    await asClinic(a.tenantId, () =>
      patients.archive(p, noAssert, { now, ctx: ctxOf(a) }),
    );

    const patient = await owner.patient.findUniqueOrThrow({ where: { id: p } });
    expect(patient.deletedAt).not.toBeNull();

    const offers = await owner.waitlistOffer.findMany({
      where: { id: { in: [live.offer, expiredOffer, phoneOffer] } },
    });
    const offer = (id: string) => offers.find((o) => o.id === id);
    expect(offer(live.offer)).toMatchObject({
      outcome: 'EXPIRED',
      outcomeAt: now,
    });
    expect(offer(expiredOffer)?.outcome).toBe('PENDING');
    expect(offer(phoneOffer)?.outcome).toBe('PENDING');

    const sigs = await owner.signatureRequest.findMany({
      where: { id: { in: [live.consent, live.budget, expiredConsent] } },
    });
    const sig = (id: string) => sigs.find((r) => r.id === id);
    for (const id of [live.consent, live.budget]) {
      expect(sig(id)).toMatchObject({
        revokedAt: now,
        revokedById: a.userId,
        codeHash: null,
        sessionHash: null,
      });
    }
    expect(sig(expiredConsent)?.revokedAt).toBeNull();

    const pdfs = await owner.signedConsentPdfLink.findMany({
      where: { id: { in: [live.pdf, usedPdf] } },
    });
    expect(pdfs.find((l) => l.id === live.pdf)?.revokedAt).toEqual(now);
    expect(pdfs.find((l) => l.id === usedPdf)?.revokedAt).toBeNull();

    const forms = await owner.medicalHistorySubmission.findMany({
      where: { id: { in: [live.anamnesis, expiredAnamnesis] } },
    });
    expect(forms.find((f) => f.id === live.anamnesis)).toMatchObject({
      status: 'EXPIRED',
      revokedAt: now,
    });
    expect(forms.find((f) => f.id === expiredAnamnesis)?.revokedAt).toBeNull();

    // El vecino y la otra clínica conservan sus enlaces vivos.
    await expect(
      asClinic(a.tenantId, () => links.countLive(other, new Date())),
    ).resolves.toEqual({
      slotOffers: 1,
      consentSignatures: 1,
      budgetSignatures: 1,
      signedPdfCopies: 1,
      anamnesis: 1,
    });
    await expect(
      asClinic(b.tenantId, () => links.countLive(b.patientId, new Date())),
    ).resolves.toMatchObject({ slotOffers: 1, signedPdfCopies: 1 });
    expect(otherLive.offer).not.toBe(foreign.offer);

    const events = await revokedEvents(a, p);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      actorUserId: a.userId,
      actorRole: 'ADMIN',
      patientId: p,
      requestId: 'int-dx461',
      metadata: {
        reason: PATIENT_ARCHIVED_LINKS_REVOKED_REASON,
        revokedLinks: {
          slotOffers: 1,
          consentSignatures: 1,
          budgetSignatures: 1,
          signedPdfCopies: 1,
          anamnesis: 1,
        },
      },
    });
    // Nada del token ni del destinatario en la auditoría.
    expect(JSON.stringify(events[0].metadata)).not.toMatch(
      /example\.com|[0-9a-f]{64}/,
    );
  });

  it('desarchivar no reactiva los enlaces anulados', async () => {
    const p = await newPatient(a, 'Vuelve');
    const live = await liveLinksFor(a, p);
    await asClinic(a.tenantId, () =>
      patients.archive(p, noAssert, { now: new Date(), ctx: ctxOf(a) }),
    );
    await owner.patient.update({ where: { id: p }, data: { deletedAt: null } });

    await expect(
      asClinic(a.tenantId, () => links.countLive(p, new Date())),
    ).resolves.toEqual({
      slotOffers: 0,
      consentSignatures: 0,
      budgetSignatures: 0,
      signedPdfCopies: 0,
      anamnesis: 0,
    });
    const offer = await owner.waitlistOffer.findUniqueOrThrow({
      where: { id: live.offer },
    });
    expect(offer.outcome).toBe('EXPIRED');
    const consent = await owner.signatureRequest.findUniqueOrThrow({
      where: { id: live.consent },
    });
    expect(consent.revokedAt).not.toBeNull();
  });

  it('si archivar se rechaza (citas abiertas), no se anula nada ni se audita', async () => {
    const p = await newPatient(a, 'ConCita');
    await liveLinksFor(a, p);
    await owner.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: p,
        providerId: a.userId,
        start: inHours(24 * 30),
        end: inHours(24 * 30 + 1),
        status: 'SCHEDULED',
      },
    });

    await expect(
      asClinic(a.tenantId, () =>
        patients.archive(
          p,
          (state) => assertNoPendingAppointments(state.pendingAppointments),
          { now: new Date(), ctx: ctxOf(a) },
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const patient = await owner.patient.findUniqueOrThrow({ where: { id: p } });
    expect(patient.deletedAt).toBeNull();
    await expect(
      asClinic(a.tenantId, () => links.countLive(p, new Date())),
    ).resolves.toMatchObject({ slotOffers: 1, anamnesis: 1 });
    expect(await revokedEvents(a, p)).toHaveLength(0);
  });

  it('es UNA transacción: si la anulación falla, el paciente sigue sin archivar', async () => {
    const p = await newPatient(a, 'Atomica');
    const live = await liveLinksFor(a, p);
    // Un actor que no existe rompe la FK de revokedById al anular la firma,
    // DESPUÉS de haber escrito el archivado y la oferta en la transacción.
    await expect(
      asClinic(a.tenantId, () =>
        patients.archive(p, noAssert, {
          now: new Date(),
          ctx: ctxOf(a, randomUUID()),
        }),
      ),
    ).rejects.toThrow();

    const patient = await owner.patient.findUniqueOrThrow({ where: { id: p } });
    expect(patient.deletedAt).toBeNull();
    const offer = await owner.waitlistOffer.findUniqueOrThrow({
      where: { id: live.offer },
    });
    expect(offer).toMatchObject({ outcome: 'PENDING', outcomeAt: null });
    expect(await revokedEvents(a, p)).toHaveLength(0);
  });

  it('sin enlaces vivos archiva sin evento de anulación', async () => {
    const p = await newPatient(a, 'SinEnlaces');
    await asClinic(a.tenantId, () =>
      patients.archive(p, noAssert, { now: new Date(), ctx: ctxOf(a) }),
    );
    expect(await revokedEvents(a, p)).toHaveLength(0);
  });

  it('contar: null para un paciente archivado o de otra clínica (RLS)', async () => {
    const p = await newPatient(a, 'YaArchivada');
    await owner.patient.update({
      where: { id: p },
      data: { deletedAt: new Date() },
    });
    await expect(
      asClinic(a.tenantId, () => links.countLive(p, new Date())),
    ).resolves.toBeNull();
    await expect(
      asClinic(a.tenantId, () => links.countLive(b.patientId, new Date())),
    ).resolves.toBeNull();
  });
});
