import { createHash } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase, STAFF_CANCELLATION } from './support/e2e-fixtures';
import { minutesIntoDay, SEDE_FIXTURE_ZONE } from './support/sede-clock';
import {
  REGIONAL_CARACAS_FIXTURE,
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
      registerBody(REGIONAL_CARACAS_FIXTURE, {
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
        docType: 'NATIONAL_ID',
        docNumber,
        sex: Sex.F,
        phone: '+58 414 555 0101',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /**
   * Cita futura nueva (cada llamada en su propia media hora, sin solapes):
   * de 08:00 a 19:30 del día ancla (las 20:00 quedan para el reagendado) y,
   * agotado, desde las 08:00 de los días siguientes.
   */
  async function createAppointment(clinic: Clinic, patientId: string) {
    const SLOTS_PER_DAY = 24;
    const day = Math.floor(slot / SLOTS_PER_DAY);
    const startMinutes = 8 * 60 + (slot % SLOTS_PER_DAY) * 30;
    slot++;
    const start = new Date(
      Date.parse(at('00:00')) + day * DAY_MS + startMinutes * 60_000,
    );
    const res = await request(server)
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        patientId,
        providerId: clinic.userId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * 60_000).toISOString(),
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
    await app.listen(0, '127.0.0.1');
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
      expect(body.whatsappPhone).toBe('584145550101');
      expect(body.appointment).toEqual({
        patientFirstName: 'Ana',
        start: appt.start,
        end: expect.any(String) as string,
        providerName: 'Dra. Dueña',
        locationName: expect.any(String) as string,
        locationAddress: null,
        // DX-354: la sede de la cita, en crudo (sede de registro de la clínica).
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h23',
        // DX-437: «Avisarme si se libera un hueco antes».
        wantsEarlier: false,
        earlierWindow: null,
        earlierAllowed: true,
      });
      expect(
        (await getAppointment(clinicA, appt.id)).confirmationSentAt,
      ).not.toBeNull();
    });

    it("a patient without country and a number without + gets a WhatsApp link from the appointment's location", async () => {
      const patient = await createPatient(clinicA, '329001');
      await raw.patient.update({
        where: { id: patient },
        data: { phone: '414 555 0101', countryCode: null },
      });
      const appt = await createAppointment(clinicA, patient);
      const { body } = await newLink(clinicA, appt.id);
      expect(body.whatsappPhone).toBe('584145550101');
    });

    it("a patient whose country differs from the location's is read with the location's region", async () => {
      const patient = await createPatient(clinicA, '329002');
      await raw.patient.update({
        where: { id: patient },
        data: { phone: '612 34 56 78', countryCode: 'ES' },
      });
      const appt = await createAppointment(clinicA, patient);
      // Con la región de la sede (VE), ese número no es válido: sin enlace.
      expect((await newLink(clinicA, appt.id)).body.whatsappPhone).toBeNull();
      const location = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
        select: {
          location: { select: { id: true, defaultPhoneRegion: true } },
        },
      });
      await raw.location.update({
        where: { id: location.location.id },
        data: { defaultPhoneRegion: 'ES' },
      });
      try {
        expect((await newLink(clinicA, appt.id)).body.whatsappPhone).toBe(
          '34612345678',
        );
      } finally {
        await raw.location.update({
          where: { id: location.location.id },
          data: { defaultPhoneRegion: location.location.defaultPhoneRegion },
        });
      }
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
        // El móvil del paciente, con o sin espacios: '310' a secas aparecía
        // al azar en UUID y horas (DX-496, TST-059).
        '414 555 0101',
        '4145550101',
        patientA,
        appt.id,
        clinicA.tenantId,
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('DX-354: trae zona, locale y reloj de la sede de la cita, y null con 200 si la sede no tiene reloj', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const { id: locationId } = await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const before = await raw.location.findUniqueOrThrow({
        where: { id: locationId },
        select: { timeZone: true, locale: true, hourCycle: true },
      });
      const appointmentOf = async () =>
        ((await view(clinicA.host, token).expect(200)).body as PublicBody)
          .appointment;
      try {
        await raw.location.update({
          where: { id: locationId },
          data: { timeZone: 'Asia/Tokyo', locale: 'ja-JP', hourCycle: 'h23' },
        });
        expect(await appointmentOf()).toMatchObject({
          timeZone: 'Asia/Tokyo',
          locale: 'ja-JP',
          hourCycle: 'h23',
        });
        await raw.location.update({
          where: { id: locationId },
          data: { hourCycle: null },
        });
        expect(await appointmentOf()).toMatchObject({
          timeZone: 'Asia/Tokyo',
          locale: 'ja-JP',
          hourCycle: null,
        });
      } finally {
        await raw.location.update({ where: { id: locationId }, data: before });
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

  // DX-361: generar/reenviar (recepción) y responder (el paciente) quedan en
  // la auditoría de la clínica de la cita, sin token, hash ni URL.
  describe('auditoría (DX-361)', () => {
    const eventsOf = (appointmentId: string) =>
      raw.auditEvent.findMany({
        where: {
          resourceId: appointmentId,
          resourceType: 'APPOINTMENT',
          metadata: {
            path: ['reason'],
            string_starts_with: 'CONFIRMATION_LINK_',
          },
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });

    function expectNoLinkData(events: unknown, links: LinkBody[]) {
      const text = JSON.stringify(events);
      for (const link of links) {
        const token = link.url.split('/confirmar/')[1];
        expect(text).not.toContain(token);
        expect(text).not.toContain(sha256(token));
        expect(text).not.toContain(link.url);
      }
      expect(text).not.toContain('/confirmar/');
    }

    it('generar y reenviar: evento de la cita con quién lo hizo y origen STAFF; el ADMIN lo ve en el registro', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const reception = await seedMember(
        clinicA,
        ClinicRole.RECEPTION,
        'recepcion-dx361@confirma-a.com',
      );
      const receptionId = (
        await raw.user.findUniqueOrThrow({
          where: { email: 'recepcion-dx361@confirma-a.com' },
        })
      ).id;

      const first = (
        await generateLink(clinicA, appt.id, reception).expect(201)
      ).body as LinkBody;
      const second = (await newLink(clinicA, appt.id)).body;

      const events = await eventsOf(appt.id);
      expect(events).toEqual([
        expect.objectContaining({
          tenantId: clinicA.tenantId,
          actorUserId: receptionId,
          actorRole: 'RECEPTION',
          action: 'UPDATE',
          patientId: patientA,
          metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_CREATED' },
        }),
        expect.objectContaining({
          actorUserId: clinicA.userId,
          actorRole: 'ADMIN',
          metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_RESENT' },
        }),
      ]);
      expectNoLinkData(events, [first, second]);

      const page = (
        await request(server)
          .get(
            `/api/v1/audit-events?patientId=${patientA}&resourceType=APPOINTMENT&limit=100`,
          )
          .set('X-Tenant-Host', clinicA.host)
          .set('Authorization', `Bearer ${clinicA.accessToken}`)
          .expect(200)
      ).body as {
        items: { resourceId: string; metadata: { reason?: string } }[];
      };
      expect(
        page.items
          .filter((e) => e.resourceId === appt.id)
          .map((e) => e.metadata.reason)
          .sort(),
      ).toEqual(['CONFIRMATION_LINK_CREATED', 'CONFIRMATION_LINK_RESENT']);
    });

    it('un intento rechazado (cita de otra clínica, cita cancelada) no deja evento', async () => {
      const apptB = await createAppointment(clinicB, patientB);
      await generateLink(clinicA, apptB.id).expect(404);
      expect(await eventsOf(apptB.id)).toEqual([]);

      const cancelled = await createAppointment(clinicA, patientA);
      await request(server)
        .patch(`/api/v1/appointments/${cancelled.id}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ status: 'CANCELLED', ...STAFF_CANCELLATION })
        .expect(200);
      await generateLink(clinicA, cancelled.id).expect(409);
      expect(await eventsOf(cancelled.id)).toEqual([]);
    });

    it.each([
      ['confirm', 'CONFIRMATION_LINK_CONFIRMED'],
      ['cancel', 'CONFIRMATION_LINK_CANCELLED'],
      ['call_me', 'CONFIRMATION_LINK_CALL_REQUESTED'],
    ])(
      'el paciente responde %s: evento sin usuario, origen LINK, en la clínica de la cita, sin datos del enlace',
      async (action, reason) => {
        const appt = await createAppointment(clinicA, patientA);
        const { body } = await newLink(clinicA, appt.id);
        const token = body.url.split('/confirmar/')[1];

        await respond(clinicA.host, token, action)
          .set('User-Agent', 'Paciente/1.0')
          .expect(200);

        const events = await eventsOf(appt.id);
        expect(events).toHaveLength(2);
        expect(events[1]).toEqual(
          expect.objectContaining({
            tenantId: clinicA.tenantId,
            actorUserId: null,
            actorRole: null,
            action: 'UPDATE',
            resourceType: 'APPOINTMENT',
            resourceId: appt.id,
            patientId: patientA,
            userAgent: 'Paciente/1.0',
            metadata: expect.objectContaining({
              origin: 'LINK',
              reason,
            }) as unknown,
          }),
        );
        expectNoLinkData(events, [body]);
        // Ni un evento en la otra clínica.
        expect(
          await raw.auditEvent.count({
            where: { tenantId: clinicB.tenantId, resourceId: appt.id },
          }),
        ).toBe(0);
      },
    );

    it('token inválido, de otra clínica, caducado, revocado o ya usado: ningún evento del paciente', async () => {
      const patientEvents = () =>
        raw.auditEvent.count({
          where: {
            tenantId: clinicA.tenantId,
            resourceType: 'APPOINTMENT',
            actorUserId: null,
          },
        });
      const before = await patientEvents();

      await respond(clinicA.host, 'A'.repeat(43), 'confirm').expect(404);

      const appt = await createAppointment(clinicA, patientA);
      const { token: first } = await newLink(clinicA, appt.id);
      await respond(clinicB.host, first, 'confirm').expect(404);
      const { token: second } = await newLink(clinicA, appt.id);
      await respond(clinicA.host, first, 'confirm').expect(410);

      await raw.appointmentConfirmation.updateMany({
        where: { tokenHash: sha256(second) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await respond(clinicA.host, second, 'confirm').expect(410);
      expect(await patientEvents()).toBe(before);

      const used = await createAppointment(clinicA, patientA);
      const { token: once } = await newLink(clinicA, used.id);
      await respond(clinicA.host, once, 'confirm').expect(200);
      await respond(clinicA.host, once, 'cancel').expect(409);
      expect(await patientEvents()).toBe(before + 1);
    });
  });

  describe('DX-469: «Añadir a mi calendario» (.ics por el enlace)', () => {
    const ics = (host: string, token: string) =>
      request(server)
        .get(`/api/v1/public/appointment-confirmations/${token}/calendar.ics`)
        .set('X-Tenant-Host', host);
    const unfold = (text: string) => text.replace(/\r\n /g, '').split('\r\n');

    it('sirve text/calendar con la cita (UTC), la clínica, el profesional y la sede, sin nada clínico; la vista trae Google Calendar', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const res = await ics(clinicA.host, token).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/calendar/);
      expect(res.headers['content-disposition']).toContain('cita.ics');
      expect(res.headers['cache-control']).toContain('no-store');
      const lines = unfold(res.text);
      expect(lines[0]).toBe('BEGIN:VCALENDAR');
      const start = new Date(appt.start)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      expect(lines).toContain(`DTSTART:${start}`);
      expect(lines.find((l) => l.startsWith('SUMMARY:'))).toBe(
        'SUMMARY:Cita en Clínica confirma-a con Dra. Dueña',
      );
      expect(lines).toContain('STATUS:CONFIRMED');
      expect(lines).toContain('TRIGGER:-PT24H');
      // Nada clínico ni el id de la cita ni el token.
      expect(res.text).not.toMatch(/Endodoncia|penicilina/);
      expect(res.text).not.toContain(appt.id);
      expect(res.text).not.toContain(token);

      const v = (await view(clinicA.host, token).expect(200)).body as {
        calendarAvailable: boolean;
        googleCalendarUrl: string | null;
      };
      expect(v.calendarAvailable).toBe(true);
      expect(v.googleCalendarUrl).toMatch(
        /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/,
      );
      expect(v.googleCalendarUrl).not.toMatch(/Endodoncia|penicilina/);
    });

    it('UID estable: el mismo evento al volver a pedirlo; cancelada por el enlace: STATUS:CANCELLED y la página ya no lo ofrece', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const uid = (text: string) =>
        unfold(text).find((l) => l.startsWith('UID:'));
      const first = uid((await ics(clinicA.host, token).expect(200)).text);
      expect(uid((await ics(clinicA.host, token).expect(200)).text)).toBe(
        first,
      );
      await respond(clinicA.host, token, 'cancel').expect(200);
      const cancelled = await ics(clinicA.host, token).expect(200);
      expect(uid(cancelled.text)).toBe(first);
      expect(unfold(cancelled.text)).toContain('STATUS:CANCELLED');
      expect(cancelled.text).not.toContain('VALARM');
      const v = (await view(clinicA.host, token).expect(200)).body as {
        calendarAvailable: boolean;
        googleCalendarUrl: string | null;
      };
      expect(v).toMatchObject({
        calendarAvailable: false,
        googleCalendarUrl: null,
      });
    });

    it('la alarma sale de los ajustes de la sede (0 la quita)', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const location = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
        select: { locationId: true, tenantId: true },
      });
      await raw.locationReminderSettings.upsert({
        where: {
          tenantId_locationId: {
            tenantId: location.tenantId,
            locationId: location.locationId,
          },
        },
        create: {
          tenantId: location.tenantId,
          locationId: location.locationId,
          calendarAlarmHours: 0,
        },
        update: { calendarAlarmHours: 0 },
      });
      try {
        expect((await ics(clinicA.host, token).expect(200)).text).not.toContain(
          'VALARM',
        );
      } finally {
        await raw.locationReminderSettings.update({
          where: {
            tenantId_locationId: {
              tenantId: location.tenantId,
              locationId: location.locationId,
            },
          },
          data: { calendarAlarmHours: 24 },
        });
      }
    });

    it('enlace revocado 410, token de otra clínica 404, inventado 404', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await ics(clinicB.host, token).expect(404);
      await ics(clinicA.host, 'x'.repeat(43)).expect(404);
      await newLink(clinicA, appt.id);
      await ics(clinicA.host, token).expect(410);
    });
  });

  describe('DX-437: «Avisarme si se libera un hueco antes» desde el enlace', () => {
    interface EarlierView {
      status: string;
      appointment: {
        wantsEarlier: boolean;
        earlierWindow: string | null;
        earlierAllowed: boolean;
      } | null;
      message?: string;
    }
    const asView = (res: request.Response): EarlierView =>
      res.body as EarlierView;
    const wantsEarlier = (
      host: string,
      token: string,
      body: Record<string, unknown>,
    ) =>
      request(server)
        .post(`/api/v1/public/appointment-confirmations/${token}/wants-earlier`)
        .set('X-Tenant-Host', host)
        .send(body);
    const readAppointment = async (id: string) =>
      (
        await request(server)
          .get(`/api/v1/appointments/${id}`)
          .set('X-Tenant-Host', clinicA.host)
          .set('Authorization', `Bearer ${clinicA.accessToken}`)
          .expect(200)
      ).body as {
        wantsEarlier: boolean;
        earlierWindow: string | null;
        earlierRequestedAt: string | null;
        status: string;
      };

    it('marca con franja, la vista lo refleja, la cita queda marcada por el paciente y se audita (origen PUBLIC_LINK); quitar la limpia', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      const before = await view(clinicA.host, token).expect(200);
      expect(asView(before).appointment).toMatchObject({
        wantsEarlier: false,
        earlierWindow: null,
        earlierAllowed: true,
      });

      const marked = await wantsEarlier(clinicA.host, token, {
        wantsEarlier: true,
        preferredWindow: 'MORNING',
      }).expect(200);
      expect(asView(marked).status).toBe('PENDING');
      expect(asView(marked).appointment).toMatchObject({
        wantsEarlier: true,
        earlierWindow: 'MORNING',
      });
      const stored = await readAppointment(appt.id);
      expect(stored).toMatchObject({
        wantsEarlier: true,
        earlierWindow: 'MORNING',
      });
      expect(stored.earlierRequestedAt).not.toBeNull();

      // Sin franja: ANY. Y el enlace sigue pendiente de confirmar.
      const any = await wantsEarlier(clinicA.host, token, {
        wantsEarlier: true,
      }).expect(200);
      expect(asView(any).appointment?.earlierWindow).toBe('ANY');

      const cleared = await wantsEarlier(clinicA.host, token, {
        wantsEarlier: false,
      }).expect(200);
      expect(asView(cleared).appointment).toMatchObject({
        wantsEarlier: false,
        earlierWindow: null,
      });
      expect(await readAppointment(appt.id)).toMatchObject({
        wantsEarlier: false,
        earlierWindow: null,
        earlierRequestedAt: null,
      });

      const events = await raw.auditEvent.findMany({
        where: { resourceId: appt.id, resourceType: 'APPOINTMENT' },
        orderBy: { occurredAt: 'asc' },
        select: { action: true, actorUserId: true, metadata: true },
      });
      const earlier = events.filter((e) =>
        String((e.metadata as { reason?: string }).reason).startsWith(
          'CONFIRMATION_LINK_EARLIER',
        ),
      );
      expect(
        earlier.map((e) => (e.metadata as { reason: string }).reason),
      ).toEqual([
        'CONFIRMATION_LINK_EARLIER_REQUESTED',
        'CONFIRMATION_LINK_EARLIER_REQUESTED',
        'CONFIRMATION_LINK_EARLIER_CLEARED',
      ]);
      expect(
        earlier.every(
          (e) =>
            e.action === 'UPDATE' &&
            e.actorUserId === null &&
            (e.metadata as { origin?: string }).origin === 'PUBLIC_LINK',
        ),
      ).toBe(true);
      // Sin el token ni la URL en el registro.
      const leaked = await raw.$queryRaw<{ found: boolean }[]>`
        SELECT bool_or(metadata::text LIKE ${'%' + token.slice(0, 16) + '%'}) AS found
          FROM audit_events WHERE "resourceId" = ${appt.id}::uuid`;
      expect(leaked[0].found).toBe(false);
    });

    it('vale con el enlace ya respondido (confirmar no lo gasta para esto)', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await respond(clinicA.host, token, 'confirm').expect(200);
      const res = await wantsEarlier(clinicA.host, token, {
        wantsEarlier: true,
        preferredWindow: 'AFTERNOON',
      }).expect(200);
      expect(asView(res).status).toBe('RESPONDED');
      expect(asView(res).appointment).toMatchObject({
        wantsEarlier: true,
        earlierWindow: 'AFTERNOON',
      });
      expect((await readAppointment(appt.id)).status).toBe('CONFIRMED');
    });

    it('una cita cancelada, pasada o de hoy no admite la marca (400 en español) y no se toca', async () => {
      const cancelled = await createAppointment(clinicA, patientA);
      const cancelledLink = await newLink(clinicA, cancelled.id);
      await respond(clinicA.host, cancelledLink.token, 'cancel').expect(200);
      const c = await wantsEarlier(clinicA.host, cancelledLink.token, {
        wantsEarlier: true,
      }).expect(400);
      expect(asView(c).message).toBe('Esta cita ya no se puede adelantar.');

      // De hoy: la fecha se mueve en BD a dentro de una hora (el enlace sigue
      // valiendo porque su foto de la cita se actualiza a la par).
      const today = await createAppointment(clinicA, patientA);
      const todayLink = await newLink(clinicA, today.id);
      // «De hoy» en la sede (Caracas): dentro de una hora, salvo que el día
      // esté a punto de acabar (DX-449: nunca cruzar la medianoche de la sede).
      const now = new Date();
      const minutesLeft = 24 * 60 - minutesIntoDay(now, SEDE_FIXTURE_ZONE);
      const soon = new Date(
        now.getTime() + (minutesLeft > 90 ? 60 : 2) * 60_000,
      );
      await raw.appointment.update({
        where: { id: today.id },
        data: { start: soon, end: new Date(soon.getTime() + 30 * 60_000) },
      });
      await raw.appointmentConfirmation.updateMany({
        where: { appointmentId: today.id },
        data: { appointmentStart: soon },
      });
      const t = await wantsEarlier(clinicA.host, todayLink.token, {
        wantsEarlier: true,
      }).expect(400);
      expect(asView(t).message).toBe(
        'La cita es hoy: ya no hay huecos anteriores.',
      );
      expect(
        asView(await view(clinicA.host, todayLink.token).expect(200))
          .appointment?.earlierAllowed,
      ).toBe(false);
      expect((await readAppointment(today.id)).wantsEarlier).toBe(false);
    });

    it('token de A en el host de B es 404; caducado 410; franja inválida 400', async () => {
      const appt = await createAppointment(clinicA, patientA);
      const { token } = await newLink(clinicA, appt.id);
      await wantsEarlier(clinicB.host, token, { wantsEarlier: true }).expect(
        404,
      );
      await wantsEarlier(clinicA.host, token, {
        wantsEarlier: true,
        preferredWindow: 'NOCHE',
      }).expect(400);
      expect((await readAppointment(appt.id)).wantsEarlier).toBe(false);
      // Otro enlace revoca este: 410 y nada cambia.
      await newLink(clinicA, appt.id);
      await wantsEarlier(clinicA.host, token, { wantsEarlier: true }).expect(
        410,
      );
      expect((await readAppointment(appt.id)).wantsEarlier).toBe(false);
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
