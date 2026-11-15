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
import { hashPublicLinkToken } from '../src/shared/public-links/public-link-token';
import { CERTIFICATE_COPY_EXPIRED_CODE } from '../src/modules/patient-certificates/domain/certificate-copy-link';

// DX-306 (segunda parte) en HTTP real: «Enviar por WhatsApp» la copia de un
// certificado y la página pública que la abre y descarga. Enlace de 30 días
// (solo su hash en la BD), reenviar invalida el anterior, anulado después del
// envío (la página dice «anulado», sin contenido ni descarga), caducado
// (410), archivar al paciente (DX-461) lo invalida, otra clínica 404 y cada
// apertura/descarga auditada sin usuario. DIRECT_URL (superusuario) siembra
// las citas atendidas, el enlace caducado y lee lo guardado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Sent {
  sentAt: string;
  expiresAt: string;
  destinationMasked: string;
  recipientKind: 'PATIENT' | 'RESPONSIBLE';
  whatsapp: { phone: string; text: string; url: string };
}

interface PublicCopy {
  status: 'AVAILABLE' | 'VOIDED';
  clinic: { name: string } | null;
  voidedAt: string | null;
  format: { timeZone: string; locale: string };
  certificate: {
    kind: string;
    numberLabel: string;
    diagnosis: string | null;
    snapshot: { patient: { name: string } };
  } | null;
}

const tokenOf = (url: string) => url.split('/').pop()!;

describe('Copia del certificado por WhatsApp (e2e, DX-306)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;
  let patientId: string;
  let providerId: string;
  let receptionToken: string;
  let slot = 0;

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
    };
  };
  const open = (host: string, token: string, suffix = '') =>
    server()
      .get(
        `/api/v1/public/certificate-copies/${encodeURIComponent(token)}${suffix}`,
      )
      .set('X-Tenant-Host', host);

  const newPatient = async (firstName: string): Promise<string> => {
    const res = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: `V-${Math.floor(10_000_000 + Math.random() * 9_000_000)}`,
        sex: 'F',
        firstName,
        lastName: 'Rondón',
        birthDate: '1985-06-20',
        phone: '+58 412 1234567',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  /** Cita atendida y su justificante (lo emite recepción). */
  const certificate = async (patient = patientId): Promise<string> => {
    slot += 1;
    const start = new Date(Date.UTC(2026, 9, 1, 12, 0) + slot * 3_600_000);
    const appt = await raw.appointment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: locationA,
        patientId: patient,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    await raw.appointment.update({
      where: { id: appt.id },
      data: { status: 'COMPLETED' },
    });
    const res = await as(clinicA, receptionToken)
      .post(`/patients/${patient}/certificates`, {
        kind: 'ATTENDANCE',
        appointmentId: appt.id,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const send = (certId: string, clinic = clinicA, patient = patientId) =>
    as(clinic, clinic === clinicA ? receptionToken : clinic.adminToken).post(
      `/patients/${patient}/certificates/${certId}/patient-copy`,
    );

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx306-copia-a');
    clinicB = await registerClinic(app, 'dx306-copia-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    providerId = clinicA.adminUserId;
    patientId = await newPatient('Mariela');
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('por WhatsApp: enlace de 30 días (solo su hash), texto con la clínica y el enlace; la página lo muestra y descarga el PDF, auditado sin usuario', async () => {
    const certId = await certificate();
    const res = await send(certId).expect(200);
    const body = res.body as Sent;
    expect(body).toMatchObject({
      destinationMasked: '••• 4567',
      recipientKind: 'PATIENT',
    });
    expect(
      (Date.parse(body.expiresAt) - Date.parse(body.sentAt)) / 86_400_000,
    ).toBe(30);
    expect(body.whatsapp.phone).toBe('584121234567');
    expect(body.whatsapp.url).toMatch(
      /^https?:\/\/dx306-copia-a\.[^/]+\/certificado\/copia\/[A-Za-z0-9_-]{43}$/,
    );
    expect(body.whatsapp.text).toContain('el justificante de asistencia');
    expect(body.whatsapp.text).toContain(body.whatsapp.url);
    const token = tokenOf(body.whatsapp.url);
    const links = await raw.patientCertificateCopyLink.findMany({
      where: { certificateId: certId },
    });
    expect(links).toHaveLength(1);
    expect(links[0].tokenHash).toBe(hashPublicLinkToken(token));
    expect(JSON.stringify(links[0])).not.toContain(token);

    const page = await open(clinicA.host, token).expect(200);
    expect(page.headers['cache-control']).toContain('no-store');
    const view = page.body as PublicCopy;
    expect(view).toMatchObject({
      status: 'AVAILABLE',
      voidedAt: null,
      format: { timeZone: 'America/Caracas' },
    });
    expect(view.certificate).toMatchObject({
      kind: 'ATTENDANCE',
      diagnosis: null,
      snapshot: { patient: { name: 'Mariela Rondón' } },
    });
    const pdf = await open(clinicA.host, token, '/pdf')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const events = await raw.auditEvent.findMany({
      where: { resourceId: certId, resourceType: 'PATIENT_CERTIFICATE' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      events.map((e) => [e.action, (e.metadata as { reason?: string }).reason]),
    ).toEqual(
      expect.arrayContaining([
        ['SEND', 'CERTIFICATE_COPY_SENT'],
        ['VIEW', 'CERTIFICATE_COPY_OPENED'],
        ['EXPORT', 'CERTIFICATE_COPY_DOWNLOADED'],
      ]),
    );
    const publicEvents = events.filter((e) => e.actorUserId === null);
    expect(publicEvents).toHaveLength(2);
    expect(publicEvents.every((e) => e.patientId === patientId)).toBe(true);
  });

  it('reenviar invalida el anterior; anulado después del envío: «VOIDED» sin contenido ni descarga', async () => {
    const certId = await certificate();
    const first = tokenOf(
      ((await send(certId).expect(200)).body as Sent).whatsapp.url,
    );
    const second = tokenOf(
      ((await send(certId).expect(200)).body as Sent).whatsapp.url,
    );
    await open(clinicA.host, first).expect(404);
    await open(clinicA.host, second).expect(200);

    await as(clinicA, receptionToken)
      .post(`/patients/${patientId}/certificates/${certId}/void`, {
        reason: 'Fecha equivocada',
      })
      .expect(200);
    const voided = (await open(clinicA.host, second).expect(200))
      .body as PublicCopy;
    expect(voided.status).toBe('VOIDED');
    expect(voided.certificate).toBeNull();
    expect(voided.voidedAt).not.toBeNull();
    await open(clinicA.host, second, '/pdf').expect(409);
    // Y ya no se envía.
    const res = await send(certId).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'El certificado está anulado: no se envía al paciente.',
    );
  });

  it('caducado: 410 con su código; inventado o mal formado: 404', async () => {
    const certId = await certificate();
    const token = tokenOf(
      ((await send(certId).expect(200)).body as Sent).whatsapp.url,
    );
    // El trigger no deja mover la caducidad: se siembra otro enlace caducado.
    await raw.patientCertificateCopyLink.updateMany({
      where: { certificateId: certId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const expiredToken = `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`;
    await raw.patientCertificateCopyLink.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        certificateId: certId,
        destinationMasked: '••• 4567',
        tokenHash: hashPublicLinkToken(expiredToken),
        createdAt: new Date(Date.now() - 40 * 86_400_000),
        expiresAt: new Date(Date.now() - 10 * 86_400_000),
        createdById: clinicA.adminUserId,
      },
    });
    const gone = await open(clinicA.host, expiredToken).expect(410);
    expect((gone.body as { code: string }).code).toBe(
      CERTIFICATE_COPY_EXPIRED_CODE,
    );
    await open(clinicA.host, 'x'.repeat(43)).expect(404);
    await open(clinicA.host, 'corto').expect(404);
  });

  it('sin teléfono: 422 en español que habla del certificado', async () => {
    const other = await newPatient('Luisa');
    await raw.patient.update({ where: { id: other }, data: { phone: null } });
    const certId = await certificate(other);
    const res = await send(certId, clinicA, other).expect(422);
    expect((res.body as { message: string }).message).toContain(
      'entrégale el certificado impreso',
    );
  });

  it('archivar al paciente (DX-461) invalida el enlace y lo cuenta', async () => {
    const other = await newPatient('Carmen');
    const certId = await certificate(other);
    const token = tokenOf(
      ((await send(certId, clinicA, other).expect(200)).body as Sent).whatsapp
        .url,
    );
    const links = await raw.patientCertificateCopyLink.count({
      where: { patientId: other, revokedAt: null },
    });
    expect(links).toBe(1);
    // El efecto de archivar sobre los enlaces: lo prueba
    // archived-patient-public-links.e2e-spec.ts con todos los tipos; aquí,
    // que el enlace de un archivado ya no abre.
    await raw.patient.update({
      where: { id: other },
      data: { deletedAt: new Date() },
    });
    await open(clinicA.host, token).expect(404);
  });

  describe('aislamiento entre clínicas', () => {
    let certId: string;
    let token: string;

    beforeAll(async () => {
      certId = await certificate();
      token = tokenOf(
        ((await send(certId).expect(200)).body as Sent).whatsapp.url,
      );
    });

    // ISOLATION_COVERS: POST /patients/:patientId/certificates/:id/patient-copy
    it('B no envía la copia de un certificado de A y no se crea enlace', async () => {
      const before = await raw.patientCertificateCopyLink.count();
      await send(certId, clinicB).expect(404);
      expect(await raw.patientCertificateCopyLink.count()).toBe(before);
    });

    // ISOLATION_COVERS: GET /public/certificate-copies/:token
    // ISOLATION_COVERS: GET /public/certificate-copies/:token/pdf
    it('el enlace de A en el host de B: 404, igual que uno inventado', async () => {
      await open(clinicB.host, token).expect(404);
      await open(clinicB.host, token, '/pdf').expect(404);
      await open(clinicA.host, token).expect(200);
    });
  });
});
