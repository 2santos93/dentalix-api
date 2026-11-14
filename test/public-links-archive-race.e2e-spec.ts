import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { signedConsentFixtures } from './support/signed-consent-fixtures';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';
import { waitFor } from './support/wait-for';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { revokeLivePublicLinks } from '../src/modules/patients/infrastructure/patient-public-links';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';

// DX-476 en HTTP real: crear un enlace público (oferta de hueco por email,
// «Enviar a firmar» y «Reenviar copia» del PDF firmado) a la vez que otro
// usuario archiva al paciente. El archivado se sostiene SIN confirmar (con el
// paciente bloqueado, deletedAt puesto y sus enlaces anulados) mientras la
// petición llega; al confirmarlo, la petición responde 409 «El paciente está
// archivado», no queda ningún enlace vivo y no sale ningún email.
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

const HOUR = 3_600_000;
const ARCHIVED = 'El paciente está archivado';

describe('Crear un enlace a la vez que se archiva (e2e, DX-476)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinic: Clinic;
  let locationId: string;
  let dentistId: string;
  let templateId: string;

  const server = () => request(app.getHttpServer());
  const authed = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const post = (path: string, body: object = {}) =>
    authed(server().post(`/api/v1${path}`)).send(body);

  async function newPatient(name: string, email: string): Promise<string> {
    const res = await post('/patients', {
      docType: 'NATIONAL_ID',
      sex: 'F',
      firstName: name,
      lastName: 'Carrera',
      docNumber: `DX476-${randomUUID().slice(0, 8)}`,
      email,
      birthDate: '1990-01-15',
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  /** Archivado a medias: lo que archivar hace, menos el COMMIT. */
  async function archiveHeld(patientId: string) {
    const release = gate();
    const ready = gate<string>();
    const done = raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "patients" WHERE "id" = ${patientId}::uuid FOR UPDATE`;
        const now = new Date();
        await tx.patient.update({
          where: { id: patientId },
          data: { deletedAt: now },
        });
        await revokeLivePublicLinks(tx, {
          tenantId: clinic.tenantId,
          patientId,
          now,
          actorId: clinic.adminUserId,
        });
        ready.open(await transactionId(tx));
        await release.wait;
      },
      { timeout: 30_000 },
    );
    return { xid: await ready.wait, release: release.open, done };
  }

  /** Lanza la petición con el archivado sin confirmar y devuelve su respuesta. */
  async function duringArchive(patientId: string, send: () => request.Test) {
    const archiving = await archiveHeld(patientId);
    const response = settle(Promise.resolve(send()));
    let responded = false;
    void response.then(() => (responded = true));
    await waitFor(
      async () => {
        if (responded) return true;
        try {
          await waitForTransactionWaiters(raw, archiving.xid);
          return true;
        } catch {
          return false;
        }
      },
      'la petición espera al archivado o responde',
      { timeoutMs: 8_000 },
    );
    archiving.release();
    await archiving.done;
    const outcome = await response;
    if (outcome.status === 'rejected') throw outcome.reason;
    await dispatcher.whenIdle();
    return outcome.value;
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
    clinic = await registerClinic(app, 'dx476-carrera');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    dentistId = (await seedMember(raw, clinic, ClinicRole.DENTIST)).userId;
    const template = await post('/consent-templates', {
      title: 'Consentimiento — Exodoncia',
      body: 'Yo, {{paciente}}, autorizo a {{profesional}} de {{clinica}}.',
    }).expect(201);
    templateId = (template.body as { id: string }).id;
    // La anamnesis exige la política de datos publicada (o el consentimiento).
    await post('/privacy-policies', {
      policyText: 'Política de tratamiento de datos de la clínica.',
      generalText: 'Autorizo el tratamiento de mis datos personales.',
      sensitiveHealthText:
        'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
      marketingText: 'Autorizo recibir comunicaciones comerciales.',
    }).expect(201);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  beforeEach(() => mailer.clear());

  it('oferta de hueco por email: 409, ninguna oferta viva y ningún email', async () => {
    const email = 'oferta.carrera@example.com';
    const patientId = await newPatient('Oriana', email);
    const slotStart = new Date(Date.now() + 48 * HOUR);
    const res = await duringArchive(patientId, () =>
      post(`/appointments/openings/${locationId}/offers`, {
        slotStart: slotStart.toISOString(),
        slotEnd: new Date(slotStart.getTime() + HOUR).toISOString(),
        providerId: dentistId,
        patientId,
        channel: 'LINK_EMAIL',
      }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(ARCHIVED);
    expect(
      await raw.waitlistOffer.count({
        where: { patientId, outcome: 'PENDING' },
      }),
    ).toBe(0);
    expect(mailer.sent.filter((m) => m.to === email)).toEqual([]);
  });

  it('«Enviar a firmar»: 409, ninguna solicitud viva y ningún email', async () => {
    const email = 'firma.carrera@example.com';
    const patientId = await newPatient('Paola', email);
    const res = await duringArchive(patientId, () =>
      post(`/patients/${patientId}/signature-requests`, {
        channel: 'EMAIL',
        type: 'CONSENT',
        templateId,
        professionalId: dentistId,
      }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(ARCHIVED);
    expect(
      await raw.signatureRequest.count({
        where: { patientId, signedAt: null, revokedAt: null },
      }),
    ).toBe(0);
    expect(mailer.sent.filter((m) => m.to === email)).toEqual([]);
  });

  it('«Reenviar copia»: 409, ningún enlace vivo y ningún email', async () => {
    const patientId = await newPatient('Quirina', 'quirina@example.com');
    const consentId = await remoteSigned({
      tenantId: clinic.tenantId,
      locationId,
      patientId,
      templateId,
      userId: dentistId,
    });
    const document = await raw.patientDocument.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        locationId,
        category: 'SIGNED_CONSENT',
        originalName: 'Consentimiento firmado.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        storageKey: `int/${randomUUID()}.pdf`,
        uploadedById: dentistId,
      },
    });
    await raw.signedConsentPdf.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        consentId,
        status: 'READY',
        documentId: document.id,
      },
    });
    mailer.clear();
    const res = await duringArchive(patientId, () =>
      post(`/patients/${patientId}/consents/${consentId}/signed-pdf/copy`),
    );
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(ARCHIVED);
    expect(
      await raw.signedConsentPdfLink.count({
        where: { patientId, usedAt: null, revokedAt: null },
      }),
    ).toBe(0);
    // remoteSigned firma con ana@example.com como destino de la copia.
    expect(mailer.sent.filter((m) => m.to === 'ana@example.com')).toEqual([]);
  });

  it('formulario de anamnesis: 409 y ningún formulario vivo', async () => {
    const patientId = await newPatient('Rita', 'rita.carrera@example.com');
    const res = await duringArchive(patientId, () =>
      post(`/patients/${patientId}/medical-history/requests`, {}),
    );
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toBe(ARCHIVED);
    expect(
      await raw.medicalHistorySubmission.count({
        where: { patientId, status: 'PENDING_PATIENT' },
      }),
    ).toBe(0);
  });
});
