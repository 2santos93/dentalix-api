import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { signedConsentFixtures } from './support/signed-consent-fixtures';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';
import {
  generateSlotOfferToken,
  hashSlotOfferToken,
} from '../src/modules/waitlist/domain/slot-offer-link';
import {
  SIGNED_PDF_COPY_NOT_FOUND_MESSAGE,
  generateSignedPdfCopyToken,
  hashSignedPdfCopyToken,
} from '../src/modules/consents/domain/signed-pdf-copy-link';
import {
  generateAnamnesisToken,
  hashAnamnesisToken,
} from '../src/modules/medical-history-submissions/domain/anamnesis-token';
import { ANAMNESIS_LINK_GONE_MESSAGE } from '../src/modules/medical-history-submissions/application/use-cases/public-anamnesis.use-cases';
import { PATIENT_ARCHIVED_LINKS_REVOKED_REASON } from '../src/modules/patients/domain/live-public-links';

// DX-461 en HTTP real: archivar a un paciente anula sus enlaces públicos vivos
// y cada ruta pública por token responde como a un enlace caducado: la oferta
// de hueco «Este enlace ya no está disponible» sin crear cita, la firma y el
// presupuesto a distancia «Enlace no válido», la copia del PDF el 404
// genérico y la anamnesis su 410. Además, defensa en profundidad: un paciente
// archivado cuyos enlaces siguieran vivos (datos de antes de DX-461) recibe lo
// mismo. GET /patients/:id/live-public-links cuenta lo que se anulará (solo
// ADMIN, aislado por clínica). DIRECT_URL (superusuario, sin RLS) siembra lo
// que no tiene ruta de alta sencilla (oferta, copia del PDF, anamnesis).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const { remoteSigned } = signedConsentFixtures({
  owner: raw,
  tenantContext,
  requests: new PrismaSignatureRequestRepository(prisma, tenantContext),
  consents: new PrismaPatientConsentRepository(prisma, tenantContext),
});

const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const HOUR = 3_600_000;
const GONE_OFFER = {
  state: 'EXPIRED',
  message: 'Este enlace ya no está disponible',
  offer: null,
};

interface Links {
  offer: string;
  offerId: string;
  consent: string;
  budget: string;
  pdf: string;
  anamnesis: string;
}

describe('Paciente archivado: sus enlaces públicos ya no sirven (e2e, DX-461)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationId: string;
  let dentistId: string;
  let templateId: string;
  let catalogItemId: string;
  let reception: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      delete: (path: string) => set(server().delete(`/api/v1${path}`)),
    };
  };
  const pub = {
    get: (path: string) =>
      server().get(`/api/v1/public/${path}`).set('X-Tenant-Host', clinicA.host),
    post: (path: string, body: object = {}) =>
      server()
        .post(`/api/v1/public/${path}`)
        .set('X-Tenant-Host', clinicA.host)
        .send(body),
  };

  async function newPatient(name: string, email: string): Promise<string> {
    const res = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: name,
        lastName: 'Archivo',
        docNumber: `DX461-${randomUUID().slice(0, 8)}`,
        email,
        birthDate: '1990-01-15',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Envía la solicitud por la API (como recepción) y saca el token del email. */
  async function sendSignature(
    patientId: string,
    email: string,
    body: object,
  ): Promise<string> {
    mailer.clear();
    await as(clinicA)
      .post(`/patients/${patientId}/signature-requests`, {
        channel: 'EMAIL',
        ...body,
      })
      .expect(201);
    await dispatcher.whenIdle();
    return (await mailer.waitFor(email, TOKEN_IN_TEXT))[1];
  }

  async function presentedPlan(patientId: string): Promise<string> {
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'COP' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '36',
        catalogItemId,
        price: 300000,
      })
      .expect(201);
    await as(clinicA).post(`/treatment-plans/${planId}/present`).expect(200);
    return planId;
  }

  /** Un enlace vivo de cada tipo para el paciente. */
  async function linksFor(patientId: string, email: string): Promise<Links> {
    const offer = generateSlotOfferToken();
    const slotStart = new Date(Date.now() + 48 * HOUR);
    const { id: offerId } = await raw.waitlistOffer.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + HOUR),
        providerId: dentistId,
        patientId,
        channel: 'LINK_EMAIL',
        offerDay: new Date(slotStart.toISOString().slice(0, 10)),
        createdById: clinicA.adminUserId,
        tokenHash: hashSlotOfferToken(offer),
        expiresAt: slotStart,
      },
    });
    // La copia del PDF primero: su consentimiento usa la misma plantilla y
    // enviar anula la solicitud anterior aún sin firmar.
    const consentId = await remoteSigned({
      tenantId: clinicA.tenantId,
      locationId,
      patientId,
      templateId,
      userId: dentistId,
    });
    await raw.signedConsentPdf.create({
      data: { tenantId: clinicA.tenantId, patientId, consentId },
    });
    const pdf = generateSignedPdfCopyToken();
    await raw.signedConsentPdfLink.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        consentId,
        tokenHash: hashSignedPdfCopyToken(pdf),
        expiresAt: new Date(Date.now() + 72 * HOUR),
      },
    });

    const consent = await sendSignature(patientId, email, {
      type: 'CONSENT',
      templateId,
      professionalId: dentistId,
    });
    const budget = await sendSignature(patientId, email, {
      type: 'BUDGET',
      treatmentPlanId: await presentedPlan(patientId),
    });

    const anamnesis = generateAnamnesisToken();
    await raw.medicalHistorySubmission.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        locationId,
        tokenHash: hashAnamnesisToken(anamnesis),
        expiresAt: new Date(Date.now() + 72 * HOUR),
        questionnaireVersion: 'v1',
        createdById: clinicA.adminUserId,
      },
    });
    return { offer, offerId, consent, budget, pdf, anamnesis };
  }

  /** Todas sirven: así el «después» prueba algo. */
  async function expectAllAlive(l: Links): Promise<void> {
    const offer = await pub.get(`slot-offers/${l.offer}`).expect(200);
    expect((offer.body as { state: string }).state).toBe('OPEN');
    await pub.get(`sign/${l.consent}`).expect(200);
    await pub.get(`sign/${l.budget}`).expect(200);
    await pub.get(`signed-consent-copies/${l.pdf}`).expect(200);
    await pub.get(`medical-history/${l.anamnesis}`).expect(200);
  }

  /** Cada ruta pública responde como a un enlace caducado, y nada se crea. */
  async function expectAllGone(l: Links, patientId: string): Promise<void> {
    for (const res of [
      await pub.get(`slot-offers/${l.offer}`).expect(200),
      await pub.post(`slot-offers/${l.offer}/accept`).expect(200),
      await pub.post(`slot-offers/${l.offer}/decline`).expect(200),
    ]) {
      expect(res.body).toMatchObject(GONE_OFFER);
    }
    expect(
      await raw.appointment.count({ where: { patientId, deletedAt: null } }),
    ).toBe(0);

    for (const token of [l.consent, l.budget]) {
      for (const res of [
        await pub.get(`sign/${token}`).expect(404),
        await pub.post(`sign/${token}/code`).expect(404),
        await pub.get(`sign/${token}/document`).expect(404),
      ]) {
        expect((res.body as { message: string }).message).toBe(
          SIGNATURE_LINK_INVALID_MESSAGE,
        );
      }
    }

    for (const res of [
      await pub.get(`signed-consent-copies/${l.pdf}`).expect(404),
      await pub.post(`signed-consent-copies/${l.pdf}/download`).expect(404),
    ]) {
      expect((res.body as { message: string }).message).toBe(
        SIGNED_PDF_COPY_NOT_FOUND_MESSAGE,
      );
    }
    const pdfLink = await raw.signedConsentPdfLink.findUniqueOrThrow({
      where: { tokenHash: hashSignedPdfCopyToken(l.pdf) },
    });
    expect(pdfLink.usedAt).toBeNull();

    const form = await pub.get(`medical-history/${l.anamnesis}`).expect(410);
    expect((form.body as { message: string }).message).toBe(
      ANAMNESIS_LINK_GONE_MESSAGE,
    );
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          quotas: {
            recipientCooldownSeconds: 0,
            recipientDaily: 1000,
            tenantDaily: 1000,
          },
        });
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx461-archivo-a');
    clinicB = await registerClinic(app, 'dx461-archivo-b');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
      })
    ).id;
    dentistId = (await seedMember(raw, clinicA, ClinicRole.DENTIST)).userId;
    reception = await loginAs(
      app,
      clinicA.host,
      (await seedMember(raw, clinicA, ClinicRole.RECEPTION)).email,
    );
    const template = await as(clinicA)
      .post('/consent-templates', {
        title: 'Consentimiento — Exodoncia',
        body: 'Yo, {{paciente}}, autorizo a {{profesional}} de {{clinica}}.',
      })
      .expect(201);
    templateId = (template.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX461-COR',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('archivar anula cada enlace: las rutas públicas responden como caducado y no se crea la cita', async () => {
    const email = 'lucia.archivo@example.com';
    const patientId = await newPatient('Lucía', email);
    const l = await linksFor(patientId, email);
    await expectAllAlive(l);

    const count = await as(clinicA)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(200);
    expect(count.body).toEqual({
      slotOffers: 1,
      consentSignatures: 1,
      budgetSignatures: 1,
      signedPdfCopies: 1,
      anamnesis: 1,
      total: 5,
    });

    await as(clinicA).delete(`/patients/${patientId}`).expect(204);

    await expectAllGone(l, patientId);
    const offer = await raw.waitlistOffer.findUniqueOrThrow({
      where: { id: l.offerId },
    });
    expect(offer.outcome).toBe('EXPIRED');

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'PATIENT',
        resourceId: patientId,
        metadata: {
          path: ['reason'],
          equals: PATIENT_ARCHIVED_LINKS_REVOKED_REASON,
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: clinicA.adminUserId,
      patientId,
      metadata: {
        revokedLinks: {
          slotOffers: 1,
          consentSignatures: 1,
          budgetSignatures: 1,
          signedPdfCopies: 1,
          anamnesis: 1,
        },
      },
    });

    // Archivado, el conteo ya no existe para la ficha (404 como su GET).
    await as(clinicA)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(404);
  });

  it('defensa en profundidad: con el paciente archivado sin anular sus enlaces, las rutas públicas tampoco sirven', async () => {
    const email = 'marina.archivo@example.com';
    const patientId = await newPatient('Marina', email);
    const l = await linksFor(patientId, email);
    await expectAllAlive(l);
    // Como un archivado de antes de DX-461: la ficha retirada, los enlaces vivos.
    await raw.patient.update({
      where: { id: patientId },
      data: { deletedAt: new Date() },
    });

    await expectAllGone(l, patientId);
    // Sin escribir nada: la oferta sigue pendiente y la firma sin abrir.
    const offer = await raw.waitlistOffer.findUniqueOrThrow({
      where: { id: l.offerId },
    });
    expect(offer).toMatchObject({ outcome: 'PENDING', outcomeAt: null });
    const sig = await raw.signatureRequest.findFirstOrThrow({
      where: { patientId, type: 'CONSENT', revokedAt: null, signedAt: null },
    });
    expect(sig.openedAt).toBeNull();
  });

  it('contar los enlaces vivos: solo ADMIN y solo pacientes de su clínica', async () => {
    const patientId = await newPatient('Sara', 'sara.archivo@example.com');
    await as(clinicA, reception)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(403);
    await as(clinicB)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(404);
    const none = await as(clinicA)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(200);
    expect(none.body).toMatchObject({ total: 0 });
  });
});
