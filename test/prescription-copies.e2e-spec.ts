import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../src/shared/public-links/public-link-token';
import {
  DEFAULT_PRESCRIPTION_COPY_FOOTER,
  PRESCRIPTION_COPY_EXPIRED_CODE,
} from '../src/modules/prescriptions/domain/prescription-copy-link';

// DX-468 en HTTP real: «Enviar al paciente» la copia informativa de una
// receta emitida (email o WhatsApp) y la página pública que la abre. Acceso
// como imprimirla (otra clínica 404, sede no permitida 403), enlace caducado
// (410), anulada después del envío (la página dice «anulada» y no trae la
// receta), reenviar o archivar al paciente (DX-461) invalida el enlace, un
// menor la recibe por su responsable y cada apertura queda auditada sin
// usuario. DIRECT_URL (superusuario, sin RLS) solo lee y siembra el enlace
// caducado (el trigger no deja mover la caducidad de uno existente).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MEDICINE = 'Amoxicilina';
const LICENSE = 'MPPS 45678';
const amoxicilina = {
  activeIngredient: MEDICINE,
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
};

interface Sent {
  channel: 'EMAIL' | 'WHATSAPP';
  sentAt: string;
  expiresAt: string;
  destinationMasked: string;
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  whatsapp: { phone: string; text: string; url: string } | null;
}

interface PublicCopy {
  status: 'AVAILABLE' | 'VOIDED' | 'UNVERIFIABLE';
  clinic: { name: string } | null;
  expiresAt: string;
  footer: string | null;
  prescription: {
    id: string;
    verificationCode: string;
    items: { activeIngredient: string }[];
    safetyOverrideReason: string | null;
  } | null;
  voidedOn: string | null;
  locale: string | null;
  hourCycle: string | null;
}

const tokenOf = (url: string) => url.split('/').pop()!;

describe('Copia de la receta para el paciente (e2e, DX-468)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let adultId: string;

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
      put: (path: string, body: object = {}) =>
        set(server().put(`/api/v1${path}`)).send(body),
      delete: (path: string) => set(server().delete(`/api/v1${path}`)),
    };
  };
  // Lo que hace el navegador del paciente: sin sesión, solo el host.
  const open = (host: string, token: string) =>
    server()
      .get(`/api/v1/public/prescription-copies/${encodeURIComponent(token)}`)
      .set('X-Tenant-Host', host);

  const newPatient = async (
    firstName: string,
    extra: Record<string, unknown>,
  ): Promise<string> => {
    const res = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: `V-${Math.floor(10_000_000 + Math.random() * 9_000_000)}`,
        sex: 'F',
        firstName,
        lastName: 'Rondón',
        ...extra,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const issue = async (patientId = adultId): Promise<string> => {
    const res = await as(clinicA)
      .post(`/patients/${patientId}/prescriptions`, {
        items: [amoxicilina],
        professionalLicense: LICENSE,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const send = (
    rxId: string,
    channel: 'EMAIL' | 'WHATSAPP',
    clinic = clinicA,
  ) => as(clinic).post(`/prescriptions/${rxId}/patient-copy`, { channel });

  const sendWhatsApp = async (rxId: string): Promise<string> => {
    const res = await send(rxId, 'WHATSAPP').expect(200);
    return tokenOf((res.body as Sent).whatsapp!.url);
  };

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx468-copia-a');
    clinicB = await registerClinic(app, 'dx468-copia-b');
    adultId = await newPatient('Mariela', {
      birthDate: '1985-06-20',
      email: 'mariela.rondon@example.com',
      phone: '+58 412 1234567',
    });
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('por WhatsApp: enlace de 30 días (solo su hash en la BD) y un texto con la clínica y el enlace, sin nada clínico', async () => {
    const rxId = await issue();
    const res = await send(rxId, 'WHATSAPP').expect(200);
    const body = res.body as Sent;
    expect(body).toMatchObject({
      channel: 'WHATSAPP',
      destinationMasked: '••• 4567',
      recipientKind: 'PATIENT',
    });
    const days =
      (Date.parse(body.expiresAt) - Date.parse(body.sentAt)) / 86_400_000;
    expect(days).toBe(30);
    const { phone, text, url } = body.whatsapp!;
    expect(phone).toBe('584121234567');
    expect(url).toMatch(
      /^https?:\/\/dx468-copia-a\.[^/]+\/receta\/copia\/[A-Za-z0-9_-]{43}$/,
    );
    expect(text).toContain('Clinica dx468-copia-a');
    expect(text).toContain(url);
    expect(text).not.toContain(MEDICINE);
    expect(text).not.toContain(LICENSE);

    const links = await raw.prescriptionCopyLink.findMany({
      where: { prescriptionId: rxId },
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      tenantId: clinicA.tenantId,
      patientId: adultId,
      channel: 'WHATSAPP',
      tokenHash: hashPublicLinkToken(tokenOf(url)),
      createdById: clinicA.adminUserId,
      revokedAt: null,
    });
    expect(JSON.stringify(links[0])).not.toContain(tokenOf(url));

    const sendEvents = await raw.auditEvent.findMany({
      where: { resourceId: rxId, action: 'SEND' },
    });
    expect(sendEvents).toHaveLength(1);
    expect(sendEvents[0]).toMatchObject({
      resourceType: 'PRESCRIPTION',
      actorUserId: clinicA.adminUserId,
      patientId: adultId,
      metadata: { reason: 'PRESCRIPTION_COPY_SENT' },
    });
  });

  it('por email: sale por el outbox (plantilla prescription-copy) al email del paciente, sin token en la respuesta', async () => {
    const rxId = await issue();
    const res = await send(rxId, 'EMAIL').expect(200);
    expect(res.body).toMatchObject({
      channel: 'EMAIL',
      destinationMasked: 'ma***@example.com',
      recipientKind: 'PATIENT',
      whatsapp: null,
    });
    const link = await raw.prescriptionCopyLink.findFirstOrThrow({
      where: { prescriptionId: rxId },
    });
    const mail = await raw.emailOutbox.findFirstOrThrow({
      where: { referenceId: link.id },
    });
    expect(mail).toMatchObject({
      tenantId: clinicA.tenantId,
      template: 'PRESCRIPTION_COPY',
      toMasked: 'ma***@example.com',
    });
  });

  it('abrir la copia: la receta con su código de verificación y el pie por defecto; no-store; auditada sin usuario', async () => {
    const rxId = await issue();
    const token = await sendWhatsApp(rxId);
    const res = await open(clinicA.host, token).expect(200);
    const body = res.body as PublicCopy;
    expect(body.status).toBe('AVAILABLE');
    expect(body.footer).toBe(DEFAULT_PRESCRIPTION_COPY_FOOTER);
    expect(body.clinic?.name).toBe('Clinica dx468-copia-a');
    expect(body.prescription).toMatchObject({
      id: rxId,
      verificationCode: expect.stringMatching(
        /^[2-9A-HJKMNP-Z]{12}$/,
      ) as string,
      items: [expect.objectContaining({ activeIngredient: MEDICINE })],
    });
    expect(res.headers['cache-control']).toBe('no-store');

    const events = await raw.auditEvent.findMany({
      where: { resourceId: rxId, action: 'VIEW', actorUserId: null },
      select: {
        tenantId: true,
        actorRole: true,
        resourceType: true,
        patientId: true,
        metadata: true,
      },
    });
    expect(events).toEqual([
      {
        tenantId: clinicA.tenantId,
        actorRole: null,
        resourceType: 'PRESCRIPTION',
        patientId: adultId,
        metadata: { origin: 'PUBLIC_LINK', reason: 'PRESCRIPTION_COPY_OPENED' },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('el pie configurable de la clínica (Ajustes › Recetas) sale en la copia', async () => {
    const settings = await as(clinicA)
      .get('/prescriptions/settings')
      .expect(200);
    const footer =
      'Copia informativa. Para retirar el medicamento traiga la receta firmada.';
    await as(clinicA)
      .put('/prescriptions/settings', {
        ...(settings.body as object),
        patientCopyFooter: `  ${footer}  `,
      })
      .expect(200);
    const token = await sendWhatsApp(await issue());
    const body = (await open(clinicA.host, token).expect(200))
      .body as PublicCopy;
    expect(body.footer).toBe(footer);
    await as(clinicA)
      .put('/prescriptions/settings', {
        ...(settings.body as object),
        patientCopyFooter: null,
      })
      .expect(200);
  });

  // ISOLATION_COVERS: POST /prescriptions/:id/patient-copy
  // ISOLATION_COVERS: GET /public/prescription-copies/:token
  it('otra clínica: 404 al enviar la receta de A (sin enlace) y al abrir su enlace desde el host de B', async () => {
    const rxId = await issue();
    await send(rxId, 'WHATSAPP', clinicB).expect(404);
    expect(
      await raw.prescriptionCopyLink.count({ where: { prescriptionId: rxId } }),
    ).toBe(0);
    const token = await sendWhatsApp(rxId);
    await open(clinicB.host, token).expect(404);
    await open(clinicA.host, generatePublicLinkToken()).expect(404);
    await open(clinicA.host, 'corto').expect(404);
  });

  it('sede no permitida: 403 LOCATION_NOT_ALLOWED sin enlace; recepción no tiene acceso clínico', async () => {
    const rxId = await issue();
    const otherLocation = (
      (
        await as(clinicA)
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Valencia' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const restricted = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    await as(clinicA)
      .put(`/staff/${restricted.userId}/locations`, {
        locationIds: [otherLocation],
      })
      .expect(200);
    const restrictedToken = await loginAs(app, clinicA.host, restricted.email);
    const denied = await as(clinicA, restrictedToken)
      .post(`/prescriptions/${rxId}/patient-copy`, { channel: 'WHATSAPP' })
      .expect(403);
    expect((denied.body as { code?: string }).code).toBe(
      LOCATION_NOT_ALLOWED_CODE,
    );
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    const receptionToken = await loginAs(app, clinicA.host, reception.email);
    await as(clinicA, receptionToken)
      .post(`/prescriptions/${rxId}/patient-copy`, { channel: 'WHATSAPP' })
      .expect(403);
    expect(
      await raw.prescriptionCopyLink.count({ where: { prescriptionId: rxId } }),
    ).toBe(0);
  });

  it('enlace caducado: 410 PRESCRIPTION_COPY_LINK_EXPIRED y sin auditar la apertura', async () => {
    const rxId = await issue();
    const token = generatePublicLinkToken();
    await raw.prescriptionCopyLink.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: adultId,
        prescriptionId: rxId,
        channel: 'EMAIL',
        destinationMasked: 'ma***@example.com',
        tokenHash: hashPublicLinkToken(token),
        createdAt: new Date(Date.now() - 31 * 86_400_000),
        expiresAt: new Date(Date.now() - 86_400_000),
        createdById: clinicA.adminUserId,
      },
    });
    const res = await open(clinicA.host, token).expect(410);
    expect(res.body).toMatchObject({ code: PRESCRIPTION_COPY_EXPIRED_CODE });
    expect(
      await raw.auditEvent.count({
        where: { resourceId: rxId, action: 'VIEW', actorUserId: null },
      }),
    ).toBe(0);
  });

  it('anulada después del envío: la página dice anulada, sin receta ni nada que descargar; no se puede volver a enviar', async () => {
    const rxId = await issue();
    const token = await sendWhatsApp(rxId);
    await as(clinicA)
      .post(`/prescriptions/${rxId}/void`, { reason: 'Dosis equivocada' })
      .expect(200);
    const res = await open(clinicA.host, token).expect(200);
    expect(res.body).toMatchObject({
      status: 'VOIDED',
      prescription: null,
      footer: null,
      voidedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
    });
    expect(res.text).not.toContain(MEDICINE);
    expect(res.text).not.toContain('Dosis equivocada');
    await send(rxId, 'WHATSAPP').expect(409);
  });

  it('reenviar invalida el enlace anterior', async () => {
    const rxId = await issue();
    const first = await sendWhatsApp(rxId);
    const second = await sendWhatsApp(rxId);
    await open(clinicA.host, first).expect(404);
    await open(clinicA.host, second).expect(200);
    const links = await raw.prescriptionCopyLink.findMany({
      where: { prescriptionId: rxId },
      orderBy: { createdAt: 'asc' },
    });
    expect(links.map((l) => l.revokedAt === null)).toEqual([false, true]);
  });

  it('archivar al paciente anula su enlace vivo y el diálogo lo cuenta (DX-461)', async () => {
    const patientId = await newPatient('Yusmary', {
      birthDate: '1979-01-15',
      email: 'yusmary.archivo@example.com',
      phone: '+58 414 7654321',
    });
    const token = await sendWhatsApp(await issue(patientId));
    await open(clinicA.host, token).expect(200);

    const count = await as(clinicA)
      .get(`/patients/${patientId}/live-public-links`)
      .expect(200);
    expect(count.body).toMatchObject({ prescriptionCopies: 1, total: 1 });

    await as(clinicA).delete(`/patients/${patientId}`).expect(204);

    await open(clinicA.host, token).expect(404);
    const link = await raw.prescriptionCopyLink.findFirstOrThrow({
      where: { patientId },
    });
    expect(link.revokedAt).not.toBeNull();
    const archived = await raw.auditEvent.findFirstOrThrow({
      where: {
        resourceType: 'PATIENT',
        resourceId: patientId,
        metadata: {
          path: ['reason'],
          equals: 'PATIENT_ARCHIVED_LINKS_REVOKED',
        },
      },
    });
    expect(archived.metadata).toMatchObject({
      revokedLinks: { prescriptionCopies: 1 },
    });
  });

  it('un menor: la copia va al responsable registrado (email y WhatsApp), nunca al contacto de la ficha del menor', async () => {
    const minorId = await newPatient('Valentina', {
      birthDate: '2016-04-10',
      email: 'valentina.menor@example.com',
      phone: '+58 412 9998877',
    });
    const rxId = await issue(minorId);
    // Sin responsable: 422, sin enlace.
    await send(rxId, 'EMAIL').expect(422);
    await as(clinicA)
      .post(`/patients/${minorId}/responsible-parties`, {
        fullName: 'Carmen Rondón',
        email: 'carmen.rondon@example.com',
        phone: '+58 424 5556677',
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);

    const byEmail = (await send(rxId, 'EMAIL').expect(200)).body as Sent;
    expect(byEmail).toMatchObject({
      recipientKind: 'RESPONSIBLE',
      destinationMasked: 'ca***@example.com',
    });
    const link = await raw.prescriptionCopyLink.findFirstOrThrow({
      where: { prescriptionId: rxId, revokedAt: null },
    });
    const mail = await raw.emailOutbox.findFirstOrThrow({
      where: { referenceId: link.id },
    });
    expect(mail.toMasked).toBe('ca***@example.com');

    const byWhatsApp = (await send(rxId, 'WHATSAPP').expect(200)).body as Sent;
    expect(byWhatsApp.recipientKind).toBe('RESPONSIBLE');
    expect(byWhatsApp.whatsapp?.phone).toBe('584245556677');
    expect(byWhatsApp.whatsapp?.text).toMatch(
      /^Hola Carmen, .*receta de Valentina/,
    );
  });

  it('tres envíos a la vez: todos responden y queda un solo enlace vivo (candado de la receta)', async () => {
    const rxId = await issue();
    const results = await Promise.all(
      [0, 1, 2].map(() => send(rxId, 'WHATSAPP')),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const links = await raw.prescriptionCopyLink.findMany({
      where: { prescriptionId: rxId },
    });
    expect(links).toHaveLength(3);
    expect(links.filter((l) => l.revokedAt === null)).toHaveLength(1);
  });

  it('el enlace es inmutable salvo invalidarlo una vez, y no se borra (trigger)', async () => {
    const rxId = await issue();
    await sendWhatsApp(rxId);
    const link = await raw.prescriptionCopyLink.findFirstOrThrow({
      where: { prescriptionId: rxId },
    });
    await expect(
      raw.prescriptionCopyLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() + 365 * 86_400_000) },
      }),
    ).rejects.toThrow(/solo se marca invalidado/);
    await raw.prescriptionCopyLink.update({
      where: { id: link.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      raw.prescriptionCopyLink.update({
        where: { id: link.id },
        data: { revokedAt: null },
      }),
    ).rejects.toThrow(/invalidado no cambia/);
  });

  it('canal inválido: 400', async () => {
    const rxId = await issue();
    await send(rxId, 'SMS' as 'EMAIL').expect(400);
  });
});
