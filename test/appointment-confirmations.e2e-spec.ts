import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase, STAFF_CANCELLATION } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// DX-005: enlace firmado de confirmación de cita, contra Postgres real (RLS +
// FK compuestas). Cubre: generación con permisos por rol, solo hash en BD,
// GET sin efectos, un solo uso, caducidad/revocación, y aislamiento entre
// clínicas (token de A en el host de B → 404).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR_DAY = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
const at = (time: string): string => `${ANCHOR_DAY}T${time}:00.000Z`;

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

interface Clinic {
  tenantId: string;
  userId: string;
  accessToken: string;
  host: string;
}

interface LinkBody {
  url: string;
  expiresAt: string;
  whatsappPhone: string | null;
  appointment: Record<string, unknown>;
}

interface PublicBody {
  status: 'PENDING' | 'RESPONDED' | 'EXPIRED';
  clinic: { name: string; primaryColor: string; logoUrl: string | null } | null;
  appointment: Record<string, unknown> | null;
  response: string | null;
  respondedAt: string | null;
}

describe('Confirmación de cita por enlace (e2e)', () => {
  let app: INestApplication<App>;
  let server: App;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let patientA: string;
  let patientB: string;
  let slot = 0;

  async function registerClinic(subdomain: string): Promise<Clinic> {
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: `Clínica ${subdomain}`,
        subdomain,
        email: `owner@${subdomain}.com`,
        password: PASSWORD,
        fullName: 'Dra. Dueña',
      }),
    );
    const host = hostFor(subdomain);
    const accessToken = await loginAs(host, `owner@${subdomain}.com`);
    // Sede sin restricción de horario: los casos agendan a cualquier hora.
    await request(server)
      .put('/api/v1/locations/schedule')
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ranges: [] })
      .expect(200);
    const body = reg.body as { tenantId: string; userId: string };
    return { tenantId: body.tenantId, userId: body.userId, accessToken, host };
  }

  async function loginAs(host: string, email: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function seedMember(
    clinic: Clinic,
    role: ClinicRole,
    email: string,
  ): Promise<string> {
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: `Miembro ${role}`,
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId: clinic.tenantId, userId: user.id, role },
    });
    return loginAs(clinic.host, email);
  }

  async function createPatient(clinic: Clinic, docNumber: string) {
    const res = await request(server)
      .post('/api/v1/patients')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        firstName: 'Ana María',
        lastName: 'Secreta',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
        phone: '+57 310 555 0101',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Cita futura nueva (cada llamada en su propia media hora, sin solapes). */
  async function createAppointment(clinic: Clinic, patientId: string) {
    const startMinutes = 8 * 60 + slot * 30;
    slot++;
    const hhmm = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const res = await request(server)
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        patientId,
        providerId: clinic.userId,
        start: at(hhmm(startMinutes)),
        end: at(hhmm(startMinutes + 30)),
        reason: 'Endodoncia molar 36',
        notes: 'Alergia a la penicilina',
      })
      .expect(201);
    return res.body as { id: string; start: string };
  }

  function generateLink(clinic: Clinic, appointmentId: string, token?: string) {
    return request(server)
      .post(`/api/v1/appointments/${appointmentId}/confirmation-link`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token ?? clinic.accessToken}`);
  }

  async function newLink(clinic: Clinic, appointmentId: string) {
    const res = await generateLink(clinic, appointmentId).expect(201);
    const body = res.body as LinkBody;
    return { body, token: body.url.split('/confirmar/')[1] };
  }

  const view = (host: string, token: string) =>
    request(server)
      .get(`/api/v1/public/appointment-confirmations/${token}`)
      .set('X-Tenant-Host', host);

  const respond = (host: string, token: string, action: string) =>
    request(server)
      .post(`/api/v1/public/appointment-confirmations/${token}`)
      .set('X-Tenant-Host', host)
      .send({ action });

  const getAppointment = async (clinic: Clinic, id: string) =>
    (
      await request(server)
        .get(`/api/v1/appointments/${id}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(200)
    ).body as {
      status: string;
      confirmationSentAt: string | null;
      callbackRequestedAt: string | null;
    };

  async function cleanup() {
    await resetDatabase(raw);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    server = app.getHttpServer();
    await cleanup();

    clinicA = await registerClinic('confirma-a');
    clinicB = await registerClinic('confirma-b');
    patientA = await createPatient(clinicA, '9001');
    patientB = await createPatient(clinicB, '9002');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  describe('POST /appointments/:id/confirmation-link', () => {
    it('devuelve la URL pública del host de la clínica, el número de WhatsApp y los datos mínimos del mensaje', async () => {
      const appt = await createAppointment(clinicA, patientA);

      const { body, token } = await newLink(clinicA, appt.id);

      expect(body.url).toBe(`http://${clinicA.host}/confirmar/${token}`);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.expiresAt).toBe(appt.start);
      expect(body.whatsappPhone).toBe('573105550101');
      expect(body.appointment).toEqual({
        patientFirstName: 'Ana',
        start: appt.start,
        end: expect.any(String) as string,
        providerName: 'Dra. Dueña',
        locationName: expect.any(String) as string,
        locationAddress: null,
      });
      expect(
        (await getAppointment(clinicA, appt.id)).confirmationSentAt,
      ).not.toBeNull();
    });

    it('en BD solo queda el hash del token', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);

      const rows = await raw.appointmentConfirmation.findMany({
        where: { appointmentId: appt.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(sha256(token));
      expect(rows[0].tenantId).toBe(clinicA.tenantId);
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('permisos: recepción, odontólogo y asistente pueden; sin sesión 401; JWT de A en host de B 401', async () => {
      const appt = await createAppointment(clinicA, patientA);
      for (const role of [
        ClinicRole.RECEPTION,
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
      ]) {
        const token = await seedMember(
          clinicA,
          role,
          `${role.toLowerCase()}@confirma-a.com`,
        );
        await generateLink(clinicA, appt.id, token).expect(201);
      }
      await request(server)
        .post(`/api/v1/appointments/${appt.id}/confirmation-link`)
        .set('X-Tenant-Host', clinicA.host)
        .expect(401);
      await request(server)
        .post(`/api/v1/appointments/${appt.id}/confirmation-link`)
        .set('X-Tenant-Host', clinicB.host)
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(401);
    });

    it('host manipulado (resuelve a la clínica pero lleva otro dominio tras el ":"): 400 y no revoca el enlace vigente', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);

      for (const evil of [
        `${clinicA.host}:3001@evil.com`,
        `${clinicA.host}:@evil.com`,
      ]) {
        const res = await request(server)
          .post(`/api/v1/appointments/${appt.id}/confirmation-link`)
          .set('X-Tenant-Host', evil)
          .set('Authorization', `Bearer ${clinicA.accessToken}`)
          .expect(400);
        expect(JSON.stringify(res.body)).not.toContain('evil.com/');
      }
      expect((await view(clinicA.host, token).expect(200)).body).toMatchObject({
        status: 'PENDING',
      });
    });

    it('la cita de otra clínica no existe (404); id no UUID 400; cita cancelada 409', async () => {
      const apptB = await createAppointment(clinicB, patientB);
      await generateLink(clinicA, apptB.id).expect(404);
      await generateLink(clinicA, 'no-es-uuid').expect(400);

      const appt = await createAppointment(clinicA, patientA);
      await request(server)
        .patch(`/api/v1/appointments/${appt.id}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ status: 'CANCELLED', ...STAFF_CANCELLATION })
        .expect(200);
      await generateLink(clinicA, appt.id).expect(409);
    });
  });

  describe('GET /public/appointment-confirmations/:token', () => {
    it('muestra clínica, fecha, profesional y sede, sin datos clínicos', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);

      const res = await view(clinicA.host, token).expect(200);
      const body = res.body as PublicBody;

      expect(body.status).toBe('PENDING');
      expect(body.clinic?.name).toBe('Clínica confirma-a');
      expect(body.appointment).toMatchObject({
        patientFirstName: 'Ana',
        start: appt.start,
        providerName: 'Dra. Dueña',
      });
      expect(body.response).toBeNull();
      const text = JSON.stringify(body);
      for (const secret of [
        'Endodoncia',
        'penicilina',
        'Secreta',
        '310',
        patientA,
        appt.id,
        clinicA.tenantId,
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('abrir el enlace (GET) no cambia nada (a prueba de previsualizadores)', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const before = await Promise.all([
        raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }),
        raw.appointmentConfirmation.findMany({
          where: { appointmentId: appt.id },
        }),
      ]);

      for (let i = 0; i < 3; i++) await view(clinicA.host, token).expect(200);

      const after = await Promise.all([
        raw.appointment.findUniqueOrThrow({ where: { id: appt.id } }),
        raw.appointmentConfirmation.findMany({
          where: { appointmentId: appt.id },
        }),
      ]);
      expect(after).toEqual(before);
      expect(after[0].status).toBe('SCHEDULED');
    });

    it('aislamiento: el token de A en el host de B es 404 (GET y POST) y la cita no se toca', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);

      await view(clinicB.host, token).expect(404);
      await respond(clinicB.host, token, 'confirm').expect(404);
      // Host apex / desconocido: tampoco.
      await view('localhost', token).expect(404);
      await view('nadie.localhost', token).expect(404);

      expect((await getAppointment(clinicA, appt.id)).status).toBe('SCHEDULED');
      expect((await view(clinicA.host, token).expect(200)).body).toMatchObject({
        status: 'PENDING',
      });
    });

    it('token inventado o mal formado: 404', async () => {
      await view(clinicA.host, 'A'.repeat(43)).expect(404);
      await view(clinicA.host, 'adivinanza').expect(404);
    });
  });

  describe('POST /public/appointment-confirmations/:token', () => {
    it('confirm: la cita pasa a CONFIRMED, se registra la respuesta y el enlace es de un solo uso', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);

      const res = await respond(clinicA.host, token, 'confirm').expect(200);
      expect(res.body).toMatchObject({
        status: 'RESPONDED',
        response: 'confirm',
      });
      expect((await getAppointment(clinicA, appt.id)).status).toBe('CONFIRMED');
      const row = await raw.appointmentConfirmation.findFirstOrThrow({
        where: { appointmentId: appt.id },
      });
      expect(row.response).toBe('CONFIRM');
      expect(row.respondedAt).not.toBeNull();

      // Segundo uso: 409 y la primera respuesta se mantiene.
      await respond(clinicA.host, token, 'cancel').expect(409);
      expect((await getAppointment(clinicA, appt.id)).status).toBe('CONFIRMED');
      const again = (await view(clinicA.host, token).expect(200))
        .body as PublicBody;
      expect(again).toMatchObject({ status: 'RESPONDED', response: 'confirm' });
      expect(again.respondedAt).not.toBeNull();
    });

    it('clics simultáneos: solo uno responde y los demás ven "ya respondido" (409, no 410)', async () => {
      // Varias rondas: la carrera (lectura del enlace y de la cita en fotos
      // distintas → 410) solo aparecía en alguna corrida suelta.
      for (let round = 0; round < 4; round++) {
        const appt = await createAppointment(clinicA, patientA);
        const { token } = await newLink(clinicA, appt.id);

        const results = await Promise.all([
          respond(clinicA.host, token, 'confirm'),
          respond(clinicA.host, token, 'cancel'),
          respond(clinicA.host, token, 'call_me'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
        const rows = await raw.appointmentConfirmation.findMany({
          where: { appointmentId: appt.id },
        });
        expect(rows.filter((r) => r.respondedAt !== null)).toHaveLength(1);
      }
    });

    it('cancel: CANCELLED', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await respond(clinicA.host, token, 'cancel').expect(200);
      expect((await getAppointment(clinicA, appt.id)).status).toBe('CANCELLED');
    });

    it('call_me: sigue SCHEDULED con la marca "pide llamada"; cambiar el estado a mano la limpia', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await respond(clinicA.host, token, 'call_me').expect(200);

      const after = await getAppointment(clinicA, appt.id);
      expect(after.status).toBe('SCHEDULED');
      expect(after.callbackRequestedAt).not.toBeNull();

      await request(server)
        .patch(`/api/v1/appointments/${appt.id}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ status: 'CONFIRMED' })
        .expect(200);
      const handled = await getAppointment(clinicA, appt.id);
      expect(handled.callbackRequestedAt).toBeNull();
      expect(handled.confirmationSentAt).toBeNull();
    });

    it('un enlace nuevo revoca el anterior (EXPIRED / 410)', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token: first } = await newLink(clinicA, appt.id);
      const { token: second } = await newLink(clinicA, appt.id);

      expect((await view(clinicA.host, first).expect(200)).body).toEqual(
        expect.objectContaining({ status: 'EXPIRED', appointment: null }),
      );
      await respond(clinicA.host, first, 'confirm').expect(410);
      await respond(clinicA.host, second, 'confirm').expect(200);
    });

    it('reagendar la cita deja el enlace sin efecto (410)', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await request(server)
        .patch(`/api/v1/appointments/${appt.id}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ start: at('20:00'), end: at('20:30') })
        .expect(200);

      expect((await view(clinicA.host, token).expect(200)).body).toMatchObject({
        status: 'EXPIRED',
      });
      await respond(clinicA.host, token, 'confirm').expect(410);
      expect((await getAppointment(clinicA, appt.id)).status).toBe('SCHEDULED');
    });

    it('caduca al inicio de la cita (410) sin tocarla', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await raw.appointmentConfirmation.updateMany({
        where: { tokenHash: sha256(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await view(clinicA.host, token).expect(200)).body).toMatchObject({
        status: 'EXPIRED',
        appointment: null,
      });
      await respond(clinicA.host, token, 'confirm').expect(410);
      expect((await getAppointment(clinicA, appt.id)).status).toBe('SCHEDULED');
    });

    it('acción inválida: 400', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await respond(clinicA.host, token, 'borrar').expect(400);
    });
  });

  it('FK compuesta: no se puede atar un enlace del tenant A a una cita del tenant B', async () => {
    const apptB = await createAppointment(clinicB, patientB);
    await expect(
      raw.appointmentConfirmation.create({
        data: {
          tenantId: clinicA.tenantId,
          appointmentId: apptB.id,
          tokenHash: sha256('cruzado'),
          expiresAt: new Date(apptB.start),
          appointmentStart: new Date(apptB.start),
          appointmentStatus: 'SCHEDULED',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
