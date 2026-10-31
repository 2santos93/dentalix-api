import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { CapturingMailer } from './support/capture-mailer';
import { signaturePng } from './support/png-fixtures';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_CLOCK } from '../src/modules/signature-requests/application/signature-clock';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';
import {
  SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE,
  SIGNATURE_PROFESSIONAL_INVALID_MESSAGE,
} from '../src/modules/signature-requests/application/use-cases/signature-requests.use-cases';

// DX-243 en HTTP real: recepción envía un consentimiento a firmar a distancia
// → el paciente abre el enlace sin sesión (la clínica sale del host), pide el
// código (llega por email), lo verifica, lee el documento y firma con el dedo
// → el profesional firma en la app y el consentimiento queda «Completo».
// Además: 5 fallos bloquean el enlace, caducado/usado/anulado/bloqueado dicen
// lo mismo («Enlace no válido»), un menor firma por medio de su responsable,
// BUDGET sin plan es 400 (el flujo del presupuesto está en
// remote-budget.e2e-spec.ts, DX-415) y la clínica B no toca nada de A (ni por ruta, ni por ids en
// el cuerpo, ni con el token de A en su host). El reloj del módulo se adelanta
// para caducar. DIRECT_URL (superusuario, sin RLS) solo lee para comprobar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ADULT_EMAIL = 'laura.castro@example.com';
const GUARDIAN_EMAIL = 'claudia.navarro@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const CODE_IN_TEXT = /Tu código de verificación es: (\d{6})/;
const HOUR_MS = 60 * 60 * 1000;
const SIGNATURE = `data:image/png;base64,${signaturePng(300, 100).toString('base64')}`;
const UA = 'Mozilla/5.0 (iPhone) e2e';

interface SignatureRequestView {
  id: string;
  status: string;
  title: string;
  destinationMasked: string;
  signerType: string;
  signerName: string;
  professionalUserId: string;
  openedAt: string | null;
  verifiedAt: string | null;
  lockedAt: string | null;
  failedAttempts: number;
  signedAt: string | null;
  consentId: string | null;
  signedIpAddress: string | null;
  countersignedAt: string | null;
  signedPdfStatus: 'PENDING' | 'READY' | 'FAILED' | null;
  signedPdfDocumentId: string | null;
  emailQueued?: boolean;
}

describe('Firma a distancia de consentimientos (e2e, DX-243)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let offsetMs = 0;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let reception: string;
  let dentist: string;
  let dentistId: string;
  let receptionId: string;
  let templateId: string;
  let planId: string;
  let patientId: string;
  let minorId: string;
  let clinicBTemplateId: string;
  let clinicBPatientId: string;

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
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };
  const pub = (host: string) => ({
    get: (path: string, session?: string) => {
      const req = server()
        .get(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', host);
      return session ? req.set('X-Signature-Session', session) : req;
    },
    post: (path: string, body: object = {}, session?: string) => {
      const req = server()
        .post(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', host)
        .set('User-Agent', UA);
      return (session ? req.set('X-Signature-Session', session) : req).send(
        body,
      );
    },
  });

  async function newPatient(clinic: Clinic, body: object): Promise<string> {
    const res = await as(clinic)
      .post('/patients', { docType: 'NATIONAL_ID', sex: 'F', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Recepción envía el consentimiento; devuelve la fila y el token del email. */
  async function send(
    forPatient = patientId,
    to = ADULT_EMAIL,
    extra: object = {},
  ): Promise<{ created: SignatureRequestView; token: string }> {
    mailer.clear();
    const res = await as(clinicA, reception)
      .post(`/patients/${forPatient}/signature-requests`, {
        type: 'CONSENT',
        channel: 'EMAIL',
        templateId,
        treatmentPlanId: forPatient === patientId ? planId : undefined,
        professionalId: dentistId,
        ...extra,
      })
      .expect(201);
    await dispatcher.whenIdle();
    const match = await mailer.waitFor(to, TOKEN_IN_TEXT);
    return { created: res.body as SignatureRequestView, token: match[1] };
  }

  async function requestCode(token: string, to = ADULT_EMAIL): Promise<string> {
    mailer.clear();
    await pub(clinicA.host).post(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    return (await mailer.waitFor(to, CODE_IN_TEXT))[1];
  }

  async function verify(token: string, code: string): Promise<string> {
    const res = await pub(clinicA.host)
      .post(`${token}/verify`, { code })
      .expect(200);
    return (res.body as { sessionToken: string }).sessionToken;
  }

  const listA = async (forPatient = patientId) =>
    (
      await as(clinicA, reception)
        .get(`/patients/${forPatient}/signature-requests`)
        .expect(200)
    ).body as SignatureRequestView[];

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        // Los topes del outbox por destinatario (DX-088) se prueban en su
        // spec; aquí se envía varias veces seguidas al mismo paciente.
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          quotas: {
            recipientCooldownSeconds: 0,
            recipientDaily: 1000,
            tenantDaily: 1000,
          },
        });
        builder
          .overrideProvider(SIGNATURE_CLOCK)
          .useValue(() => new Date(Date.now() + offsetMs));
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx243-firma-a');
    clinicB = await registerClinic(app, 'dx243-firma-b');
    const receptionist = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinicA.host, receptionist.email);
    receptionId = receptionist.userId;
    const doctor = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentist = await loginAs(app, clinicA.host, doctor.email);
    dentistId = doctor.userId;

    const template = await as(clinicA)
      .post('/consent-templates', {
        title: 'Consentimiento informado — Exodoncia',
        body: 'Yo, {{paciente}} ({{documento}}), autorizo a {{profesional}} de {{clinica}} a realizar: {{tratamiento}}. Fecha: {{fecha}}.',
      })
      .expect(201);
    templateId = (template.body as { id: string }).id;
    patientId = await newPatient(clinicA, {
      firstName: 'Laura',
      lastName: 'Castro',
      docNumber: 'DX243-1',
      email: ADULT_EMAIL,
      birthDate: '1992-03-14',
    });
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    planId = (plan.body as { id: string }).id;
    minorId = await newPatient(clinicA, {
      firstName: 'Sofía',
      lastName: 'Ortiz',
      docNumber: 'DX243-2',
      email: 'familia.ortiz@example.com',
      birthDate: '2015-02-11',
    });
    await as(clinicA, reception)
      .post(`/patients/${minorId}/responsible-parties`, {
        fullName: 'Claudia Navarro',
        email: GUARDIAN_EMAIL,
        relationship: 'MOTHER',
        isPayer: false,
        documentType: 'NATIONAL_ID',
        docNumber: 'C01',
      })
      .expect(201);

    const templateB = await as(clinicB)
      .post('/consent-templates', { title: 'Plantilla B', body: 'Texto B' })
      .expect(201);
    clinicBTemplateId = (templateB.body as { id: string }).id;
    clinicBPatientId = await newPatient(clinicB, {
      firstName: 'Beatriz',
      lastName: 'Otra',
      docNumber: 'DX243-B',
      email: 'beatriz@example.com',
    });
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  afterEach(() => {
    offsetMs = 0;
  });

  it('enviar → código → verificar → firmar → firma del profesional: Completo, con evidencias e íntegro', async () => {
    // Recepción ve en el modal a quién iría y quién puede firmar.
    const options = await as(clinicA, reception)
      .get(`/patients/${patientId}/signature-requests/options`)
      .expect(200);
    expect(options.body).toMatchObject({
      templates: [
        {
          id: templateId,
          version: 1,
          usesTreatment: true,
          lastCompletedAt: null,
        },
      ],
      defaultProfessionalId: null,
      // Recepción también elige el plan que rellena {{tratamiento}}.
      plans: [{ id: planId, status: 'DRAFT', optionLabel: null }],
      recipient: {
        allowed: true,
        destinationMasked: 'la***@example.com',
        signerType: 'PATIENT',
        minor: false,
      },
    });

    // Solo quien firma un consentimiento como profesional (roles clínicos).
    const professionals = (
      options.body as { professionals: { id: string; role: string }[] }
    ).professionals;
    expect(professionals).toContainEqual(
      expect.objectContaining({ id: dentistId, role: 'DENTIST' }),
    );
    expect(professionals.map((p) => p.id)).not.toContain(receptionId);
    expect(professionals.every((p) => p.role !== 'RECEPTION')).toBe(true);
    // Y la API rechaza a quien no puede firmar.
    const notEligible = await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'CONSENT',
        channel: 'EMAIL',
        templateId,
        professionalId: receptionId,
      })
      .expect(400);
    expect(notEligible.body).toMatchObject({
      message: SIGNATURE_PROFESSIONAL_INVALID_MESSAGE,
    });

    const { created, token } = await send();
    expect(created).toMatchObject({
      status: 'SENT',
      emailQueued: true,
      destinationMasked: 'la***@example.com',
      signerType: 'PATIENT',
      signerName: 'Laura Castro',
      professionalUserId: dentistId,
    });
    // El email: enlace, sin nada clínico; la base guarda solo el hash.
    const linkMail = mailer.sent.find((m) => m.to === ADULT_EMAIL)!;
    expect(linkMail.text).not.toMatch(/exodoncia|consentimiento/i);
    const row = await raw.signatureRequest.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.body).toContain('Yo, Laura Castro');
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      72 * HOUR_MS,
    );
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinicA.tenantId,
          resourceType: 'SIGNATURE_REQUEST',
          resourceId: created.id,
          action: 'SEND',
          patientId,
        },
      }),
    ).toBe(1);

    // Público: estado mínimo, sin documento ni nombres; no-store y no-referrer.
    const view = await pub(clinicA.host).get(token).expect(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    expect(view.body).toMatchObject({
      destinationMasked: 'la***@example.com',
      codeSent: false,
      location: { timeZone: 'America/Bogota' },
    });
    expect(JSON.stringify(view.body)).not.toMatch(/Laura|Exodoncia/);
    // Sin código verificado no hay documento.
    const noSession = await pub(clinicA.host)
      .get(`${token}/document`)
      .expect(403);
    expect(noSession.body).toMatchObject({
      code: 'SIGNATURE_SESSION_REQUIRED',
    });

    const code = await requestCode(token);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await pub(clinicA.host)
      .post(`${token}/verify`, { code: wrong })
      .expect(400);
    expect(bad.body).toMatchObject({
      code: 'SIGNATURE_CODE_INVALID',
      attemptsLeft: 4,
      message: 'Código incorrecto. Te quedan 4 intentos.',
    });
    const session = await verify(token, code);
    // El código no sirve dos veces.
    await pub(clinicA.host).post(`${token}/verify`, { code }).expect(400);

    const doc = await pub(clinicA.host)
      .get(`${token}/document`, session)
      .expect(200);
    expect(doc.body).toMatchObject({
      title: 'Consentimiento informado — Exodoncia',
      signerName: 'Laura Castro',
      signerDocumentRequired: false,
    });
    expect((doc.body as { body: string }).body).toBe(row.body);

    const signed = await pub(clinicA.host)
      .post(`${token}/sign`, { signature: SIGNATURE, accepted: true }, session)
      .expect(200);
    expect(signed.body).toMatchObject({
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });

    // Usado: lo mismo que un enlace inventado, en todas las rutas.
    for (const call of [
      pub(clinicA.host).get(token),
      pub(clinicA.host).post(`${token}/code`),
      pub(clinicA.host).post(
        `${token}/sign`,
        { signature: SIGNATURE, accepted: true },
        session,
      ),
    ]) {
      const res = await call.expect(404);
      expect(res.body).toMatchObject({
        message: SIGNATURE_LINK_INVALID_MESSAGE,
      });
    }

    const [signedRow] = await listA();
    expect(signedRow).toMatchObject({
      id: created.id,
      status: 'SIGNED_BY_PATIENT',
      failedAttempts: 1,
      signedIpAddress: expect.any(String) as string,
      countersignedAt: null,
    });
    const consentId = signedRow.consentId!;
    const consent = await raw.patientConsent.findUniqueOrThrow({
      where: { id: consentId },
    });
    expect(consent).toMatchObject({
      signatureRequestId: created.id,
      professionalSignature: null,
      remoteChannel: 'EMAIL',
      remoteDestinationMasked: 'la***@example.com',
      userAgent: UA,
      signerType: 'PATIENT',
      treatmentPlanId: planId,
    });
    expect(
      (
        await raw.auditEvent.findMany({
          where: {
            tenantId: clinicA.tenantId,
            resourceId: created.id,
            actorUserId: null,
          },
          orderBy: { occurredAt: 'asc' },
          select: { metadata: true },
        })
      ).map((e) => (e.metadata as { reason: string }).reason),
    ).toEqual([
      'SIGNATURE_LINK_OPENED',
      'SIGNATURE_CODE_SENT',
      'SIGNATURE_CODE_VERIFIED',
      'SIGNATURE_PATIENT_SIGNED',
    ]);

    // En la ficha clínica: firmado por el paciente, falta el profesional.
    const consents = await as(clinicA, dentist)
      .get(`/patients/${patientId}/consents`)
      .expect(200);
    expect((consents.body as object[])[0]).toMatchObject({
      id: consentId,
      complete: false,
      professionalSignedAt: null,
      remote: { signatureRequestId: created.id, professionalUserId: dentistId },
    });

    // Recepción no firma como profesional; otro clínico tampoco.
    await as(clinicA, reception)
      .post(`/patients/${patientId}/consents/${consentId}/countersign`, {
        professionalSignature: SIGNATURE,
      })
      .expect(403);
    await as(clinicA)
      .post(`/patients/${patientId}/consents/${consentId}/countersign`, {
        professionalSignature: SIGNATURE,
      })
      .expect(403);
    const done = await as(clinicA, dentist)
      .post(`/patients/${patientId}/consents/${consentId}/countersign`, {
        professionalSignature: SIGNATURE,
      })
      .expect(201);
    expect(done.body).toMatchObject({ complete: true });
    await as(clinicA, dentist)
      .post(`/patients/${patientId}/consents/${consentId}/countersign`, {
        professionalSignature: SIGNATURE,
      })
      .expect(409);

    expect((await listA())[0]).toMatchObject({
      status: 'COMPLETE',
      countersignedAt: expect.any(String) as string,
      // DX-422: el PDF firmado se genera en segundo plano.
      signedPdfStatus: 'PENDING',
      signedPdfDocumentId: null,
    });
    // Aún no está en error: «Reintentar» no aplica (409).
    await as(clinicA, reception)
      .post(`/patients/${patientId}/consents/${consentId}/signed-pdf/retry`)
      .expect(409);

    // DX-422: la cola lo genera y lo archiva en los documentos del paciente.
    await app.get(JobWorker).drain();
    const [withPdf] = await listA();
    expect(withPdf).toMatchObject({
      signedPdfStatus: 'READY',
      signedPdfDocumentId: expect.any(String) as string,
    });
    const pdfId = withPdf.signedPdfDocumentId!;
    const docs = await as(clinicA, reception)
      .get(`/patients/${patientId}/documents`)
      .expect(200);
    expect(docs.body).toContainEqual(
      expect.objectContaining({
        id: pdfId,
        category: 'SIGNED_CONSENT',
        mimeType: 'application/pdf',
        uploadedById: dentistId,
        voidedAt: null,
      }),
    );
    // «Descargar PDF»: URL firmada de descarga, como cualquier documento.
    const download = await as(clinicA, reception)
      .get(`/patients/${patientId}/documents/${pdfId}/url/download`)
      .expect(200);
    expect(download.body).toMatchObject({ disposition: 'attachment' });
    const signedUrl = new URL((download.body as { url: string }).url);
    const file = await request(app.getHttpServer())
      .get(`${signedUrl.pathname}${signedUrl.search}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    // H2: el PDF firmado no se anula desde Documentos (ni el ADMIN): 409.
    const voidAttempt = await as(clinicA)
      .post(`/patients/${patientId}/documents/${pdfId}/void`, {
        reason: 'Prueba de anulación',
      })
      .expect(409);
    expect((voidAttempt.body as { message: string }).message).toBe(
      'Este es el PDF firmado de un consentimiento: es la prueba de la firma y no se puede anular.',
    );
    expect((await listA())[0]).toMatchObject({ signedPdfStatus: 'READY' });
    // Ya archivado: reintentar es 409; desde otra clínica, 404 (sin pistas).
    await as(clinicA, reception)
      .post(`/patients/${patientId}/consents/${consentId}/signed-pdf/retry`)
      .expect(409);
    await as(clinicB)
      .post(`/patients/${patientId}/consents/${consentId}/signed-pdf/retry`)
      .expect(404);
    await as(clinicB)
      .get(`/patients/${patientId}/documents/${pdfId}/url/download`)
      .expect(404);
    // El modal ya avisa de que este paciente lo firmó (sin bloquear).
    const after = await as(clinicA, reception)
      .get(`/patients/${patientId}/signature-requests/options`)
      .expect(200);
    expect(
      (after.body as { templates: { lastCompletedAt: string | null }[] })
        .templates[0].lastCompletedAt,
    ).toBe(consent.signedAt.toISOString());
    const document = await as(clinicA, dentist)
      .get(`/patients/${patientId}/consents/${consentId}`)
      .expect(200);
    expect(document.body).toMatchObject({
      integrityOk: true,
      complete: true,
      remoteIpAddress: expect.any(String) as string,
      professionalSignature: expect.stringMatching(
        /^data:image\/png;base64,/,
      ) as string,
    });
  });

  it('5 códigos incorrectos bloquean el enlace y la ficha lo muestra', async () => {
    const { created, token } = await send();
    const code = await requestCode(token);
    const wrong = code === '000000' ? '111111' : '000000';
    for (const left of [4, 3, 2, 1]) {
      const res = await pub(clinicA.host)
        .post(`${token}/verify`, { code: wrong })
        .expect(400);
      expect(res.body).toMatchObject({ attemptsLeft: left });
    }
    const locked = await pub(clinicA.host)
      .post(`${token}/verify`, { code: wrong })
      .expect(400);
    expect(locked.body).toMatchObject({ code: 'SIGNATURE_LINK_LOCKED' });
    // Ni el código bueno: «Enlace no válido».
    const after = await pub(clinicA.host)
      .post(`${token}/verify`, { code })
      .expect(404);
    expect(after.body).toMatchObject({
      message: SIGNATURE_LINK_INVALID_MESSAGE,
    });
    const row = (await listA()).find((r) => r.id === created.id)!;
    expect(row).toMatchObject({ status: 'LOCKED', failedAttempts: 5 });
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinicA.tenantId,
          resourceId: created.id,
          metadata: { path: ['reason'], equals: 'SIGNATURE_LINK_LOCKED' },
        },
      }),
    ).toBe(1);
    // Recepción lo anula para enviar otro.
    await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests/${created.id}/revoke`)
      .expect(200);
  });

  it('caducado (72 h) o anulado: «Enlace no válido» sin revelar datos', async () => {
    const { created, token } = await send();
    offsetMs = 72 * HOUR_MS;
    // La MISMA respuesta que un token bien formado que nunca existió.
    const unknown = await pub(clinicA.host).get('A'.repeat(43)).expect(404);
    const expired = await pub(clinicA.host).get(token).expect(404);
    expect(expired.body).toEqual(unknown.body);
    expect(expired.body).toEqual(
      expect.objectContaining({ message: SIGNATURE_LINK_INVALID_MESSAGE }),
    );
    expect(JSON.stringify(expired.body)).not.toMatch(/Laura|la\*\*\*/);
    expect((await listA()).find((r) => r.id === created.id)?.status).toBe(
      'EXPIRED',
    );
    offsetMs = 0;

    const second = await send();
    // Enviar otro del mismo documento anuló el anterior.
    expect((await listA()).find((r) => r.id === created.id)?.status).toBe(
      'REVOKED',
    );
    const revoked = await as(clinicA, reception)
      .post(
        `/patients/${patientId}/signature-requests/${second.created.id}/revoke`,
      )
      .expect(200);
    expect(revoked.body).toMatchObject({ status: 'REVOKED' });
    const revokedLink = await pub(clinicA.host).get(second.token).expect(404);
    expect(revokedLink.body).toEqual(unknown.body);
    await as(clinicA, reception)
      .post(
        `/patients/${patientId}/signature-requests/${second.created.id}/revoke`,
      )
      .expect(409);
  });

  it('un menor: el enlace y el código van a su responsable, que firma como GUARDIAN con su nombre', async () => {
    const { created, token } = await send(minorId, GUARDIAN_EMAIL);
    expect(created).toMatchObject({
      signerType: 'GUARDIAN',
      signerName: 'Claudia Navarro',
      destinationMasked: 'cl***@example.com',
    });
    const code = await requestCode(token, GUARDIAN_EMAIL);
    const session = await verify(token, code);
    await pub(clinicA.host)
      .post(`${token}/sign`, { signature: SIGNATURE, accepted: true }, session)
      .expect(200);
    const consent = await raw.patientConsent.findFirstOrThrow({
      where: { signatureRequestId: created.id },
    });
    expect(consent).toMatchObject({
      patientId: minorId,
      signerType: 'GUARDIAN',
      signerName: 'Claudia Navarro',
      signerDocument: expect.stringContaining('C01') as string,
    });
  });

  it('BUDGET sin plan: 400 en español; sin profesional: 400; nada se crea', async () => {
    const before = await raw.signatureRequest.count();
    // Recepción no envía presupuestos (403, remote-budget.e2e-spec): ADMIN.
    const budget = await as(clinicA)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        templateId,
        professionalId: dentistId,
      })
      .expect(400);
    expect(budget.body).toMatchObject({
      message: SIGNATURE_BUDGET_PLAN_REQUIRED_MESSAGE,
    });
    const missing = await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'CONSENT',
        channel: 'EMAIL',
        templateId,
      })
      .expect(400);
    expect((missing.body as { message: string }).message).toMatch(
      /profesional/,
    );
    expect(await raw.signatureRequest.count()).toBe(before);
  });

  describe('aislamiento entre clínicas (DX-207)', () => {
    it('B no ve, no envía, no anula ni firma como profesional sobre lo de A', async () => {
      const { created } = await send();
      const before = await raw.signatureRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      const consent = await raw.patientConsent.findFirstOrThrow({
        where: {
          tenantId: clinicA.tenantId,
          signatureRequestId: { not: null },
        },
      });
      await as(clinicB)
        .get(`/patients/${patientId}/signature-requests/options`)
        .expect(404);
      await as(clinicB)
        .get(`/patients/${patientId}/signature-requests`)
        .expect(404);
      await as(clinicB)
        .post(`/patients/${patientId}/signature-requests`, {
          type: 'CONSENT',
          channel: 'EMAIL',
          templateId: clinicBTemplateId,
        })
        .expect(404);
      await as(clinicB)
        .post(`/patients/${patientId}/signature-requests/${created.id}/revoke`)
        .expect(404);
      await as(clinicB)
        .post(
          `/patients/${clinicBPatientId}/signature-requests/${created.id}/revoke`,
        )
        .expect(404);
      await as(clinicB)
        .post(`/patients/${patientId}/consents/${consent.id}/countersign`, {
          professionalSignature: SIGNATURE,
        })
        .expect(404);
      expect(
        await raw.signatureRequest.findUniqueOrThrow({
          where: { id: created.id },
        }),
      ).toEqual(before);
    });

    it('B manda la plantilla, el plan o el profesional de A en el cuerpo: 404/400 y no se crea nada', async () => {
      const countB = () =>
        raw.signatureRequest.count({ where: { tenantId: clinicB.tenantId } });
      const base = {
        type: 'CONSENT',
        channel: 'EMAIL',
        templateId: clinicBTemplateId,
      };
      const template = await as(clinicB)
        .post(`/patients/${clinicBPatientId}/signature-requests`, {
          ...base,
          templateId,
        })
        .expect(404);
      expect(template.body).toMatchObject({
        message: 'Plantilla no encontrada',
      });
      const plan = await as(clinicB)
        .post(`/patients/${clinicBPatientId}/signature-requests`, {
          ...base,
          treatmentPlanId: planId,
        })
        .expect(404);
      expect(plan.body).toMatchObject({
        message: 'Plan de tratamiento no encontrado',
      });
      const professional = await as(clinicB)
        .post(`/patients/${clinicBPatientId}/signature-requests`, {
          ...base,
          professionalId: dentistId,
        })
        .expect(400);
      expect(professional.body).toMatchObject({
        message: SIGNATURE_PROFESSIONAL_INVALID_MESSAGE,
      });
      expect(await countB()).toBe(0);
    });

    it('el token de A en el host de B → «Enlace no válido» en las cinco rutas, sin tocar nada de A', async () => {
      const { created, token } = await send();
      const code = await requestCode(token);
      const session = await verify(token, code);
      const before = await raw.signatureRequest.findUniqueOrThrow({
        where: { id: created.id },
      });
      const B = pub(clinicB.host);
      for (const call of [
        B.get(token),
        B.post(`${token}/code`),
        B.post(`${token}/verify`, { code }),
        B.get(`${token}/document`, session),
        B.post(
          `${token}/sign`,
          { signature: SIGNATURE, accepted: true },
          session,
        ),
      ]) {
        const res = await call.expect(404);
        expect(res.body).toMatchObject({
          message: SIGNATURE_LINK_INVALID_MESSAGE,
        });
      }
      expect(
        await raw.signatureRequest.findUniqueOrThrow({
          where: { id: created.id },
        }),
      ).toEqual(before);
      expect(
        await raw.patientConsent.count({
          where: { signatureRequestId: created.id },
        }),
      ).toBe(0);
    });
  });
});
