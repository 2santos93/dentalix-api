import { ReminderClock } from '../src/modules/reminders/application/reminder-clock';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { CapturingMailer } from './support/capture-mailer';
import { waitFor } from './support/wait-for';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import {
  PLAN_REMINDERS_SCHEDULE,
  SEND_REMINDER_JOB,
} from '../src/modules/reminders/application/plan-reminders';

// DX-026 en HTTP real: Ajustes → Recordatorios por rol (solo ADMIN, 403 en
// español), validación en español, sedes de otra clínica, y el estado de los
// recordatorios de una cita antes y después de que el barrido programado y el
// envío corran en el worker (email con el enlace de DX-005).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;
const MIN = 60_000;
const FORBIDDEN =
  'Solo un administrador puede ver y cambiar los recordatorios.';

interface SettingsBody {
  locationId: string;
  locationName: string;
  enabled: boolean;
  leadHours: number[];
  updatedAt: string | null;
}

interface RemindersBody {
  enabled: boolean;
  leadHours: number[];
  items: {
    leadHours: number;
    appointmentStart: string;
    dueAt: string;
    state: string;
    sentAt: string | null;
    skipReason: string | null;
    failureReason: string | null;
    emailDelivery: string | null;
    sentToResponsible: boolean;
    current: boolean;
  }[];
}

describe('Recordatorios de cita por email (e2e, DX-026)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const mailer = new CapturingMailer();
  const tokens = {} as Record<ClinicRole, string>;
  let mainLocationId: string;
  let dentistId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPatient(email: string | null, doc: string) {
    const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName: 'Carolina',
        lastName: 'Duque',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
        ...(email ? { email } : {}),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function book(
    patientId: string,
    start: Date,
    providerId = clinic.adminUserId,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/appointments'),
      tokens[ClinicRole.RECEPTION],
    )
      .send({
        patientId,
        providerId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * MIN).toISOString(),
        reason: 'Dolor en la muela 36',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function reminders(id: string, token = tokens[ClinicRole.RECEPTION]) {
    const res = await as(
      api().get(`/api/v1/appointments/${id}/reminders`),
      token,
    ).expect(200);
    return res.body as RemindersBody;
  }

  /** Un tick del barrido y, adelantados a su hora, los envíos que encoló. */
  async function runReminders(): Promise<void> {
    const worker = app.get(JobWorker);
    await worker.runOnce();
    await raw.jobSchedule.update({
      where: { name: PLAN_REMINDERS_SCHEDULE },
      data: { nextRunAt: new Date(Date.now() - MIN) },
    });
    await worker.drain();
    await raw.job.updateMany({
      where: { name: SEND_REMINDER_JOB, state: 'PENDING' },
      data: { runAt: new Date(Date.now() - MIN) },
    });
    await worker.drain();
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) => builder.overrideProvider(MAILER).useValue(mailer),
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx026-e2e');
    other = await registerClinic(app, 'dx026-e2e-otra');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
    }
    // Sede sin restricción de horario: las citas de abajo no dependen de la
    // hora de la corrida.
    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({ timezone: 'America/Bogota', ranges: [] })
      .expect(200);
    await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send({ name: 'Sede Norte' })
      .expect(201);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('Ajustes → Recordatorios', () => {
    it('ADMIN ve todas sus sedes, desactivadas por defecto', async () => {
      const res = await as(
        api().get('/api/v1/reminder-settings'),
        clinic.adminToken,
      ).expect(200);
      const body = res.body as SettingsBody[];
      expect(body.map((s) => [s.enabled, s.leadHours, s.updatedAt])).toEqual([
        [false, [], null],
        [false, [], null],
      ]);
      expect(body.map((s) => s.locationName)).toContain('Sede Norte');
      mainLocationId = body[0].locationId;
    });

    it('ADMIN activa una sede con [2, 48]: se guarda de mayor a menor', async () => {
      const res = await as(
        api().put(`/api/v1/reminder-settings/${mainLocationId}`),
        clinic.adminToken,
      )
        .send({ enabled: true, leadHours: [2, 48] })
        .expect(200);
      expect(res.body).toMatchObject({
        locationId: mainLocationId,
        enabled: true,
        leadHours: [48, 2],
      });
      const list = await as(
        api().get('/api/v1/reminder-settings'),
        clinic.adminToken,
      ).expect(200);
      expect(
        (list.body as SettingsBody[]).filter((s) => s.enabled),
      ).toHaveLength(1);
    });

    it.each([
      [
        { enabled: true, leadHours: [] },
        'Para activar los recordatorios elige al menos una antelación.',
      ],
      [
        { enabled: true, leadHours: [200] },
        'Cada recordatorio debe ser de 1 a 168 horas antes (7 días).',
      ],
      [
        { enabled: true, leadHours: [0] },
        'Cada recordatorio debe ser de 1 a 168 horas antes (7 días).',
      ],
      [
        { enabled: true, leadHours: [1, 2, 3, 4] },
        'Como máximo 3 recordatorios por sede.',
      ],
      [
        { enabled: true, leadHours: [24, 24] },
        'No repitas la misma antelación: cada recordatorio sale a una hora distinta.',
      ],
      [
        { leadHours: [24] },
        'Indica si los recordatorios están activos (sí o no).',
      ],
    ])('valida %j en español (400)', async (body, message) => {
      const res = await as(
        api().put(`/api/v1/reminder-settings/${mainLocationId}`),
        clinic.adminToken,
      )
        .send(body)
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(message);
    });

    it('una sede de otra clínica o inexistente da 404 en español y no se toca', async () => {
      const otherList = await as(
        api().get('/api/v1/reminder-settings'),
        other.adminToken,
        other.host,
      ).expect(200);
      const otherLocation = (otherList.body as SettingsBody[])[0].locationId;
      const res = await as(
        api().put(`/api/v1/reminder-settings/${otherLocation}`),
        clinic.adminToken,
      )
        .send({ enabled: true, leadHours: [24] })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Sede no encontrada',
      );
      expect(
        await raw.locationReminderSettings.count({
          where: { locationId: otherLocation },
        }),
      ).toBe(0);
      // Y la otra clínica no ve los ajustes de esta.
      expect(
        (otherList.body as SettingsBody[]).some(
          (s) => s.locationId === mainLocationId,
        ),
      ).toBe(false);
    });

    it('un id de sede mal formado da 400 en español', async () => {
      const res = await as(
        api().put('/api/v1/reminder-settings/no-es-un-uuid'),
        clinic.adminToken,
      )
        .send({ enabled: false, leadHours: [] })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El identificador de la sede no es válido.',
      );
    });

    it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
      '%s recibe 403 en español al leer y al cambiar',
      async (role) => {
        const get = await as(
          api().get('/api/v1/reminder-settings'),
          tokens[role],
        ).expect(403);
        expect((get.body as { message: string }).message).toBe(FORBIDDEN);
        const put = await as(
          api().put(`/api/v1/reminder-settings/${mainLocationId}`),
          tokens[role],
        )
          .send({ enabled: false, leadHours: [] })
          .expect(403);
        expect((put.body as { message: string }).message).toBe(FORBIDDEN);
        const row = await raw.locationReminderSettings.findFirstOrThrow({
          where: { locationId: mainLocationId },
        });
        expect(row.enabled).toBe(true);
      },
    );
  });

  describe('estado de los recordatorios de una cita', () => {
    it('pendiente → enviado al outbox con el enlace de DX-005; sin email → omitido', async () => {
      const start = new Date(Date.now() + 2 * HOUR + 3 * MIN);
      const withEmail = await book(
        await createPatient('carolina.duque@example.com', '26001'),
        start,
      );
      const noEmail = await book(
        await createPatient(null, '26002'),
        start,
        dentistId,
      );

      // Antes del barrido: el de 48 h ya no llegó a tiempo (la cita se agendó
      // después) y el de 2 h está pendiente.
      const before = await reminders(withEmail);
      expect(before.enabled).toBe(true);
      expect(before.leadHours).toEqual([48, 2]);
      expect(before.items.map((i) => [i.leadHours, i.state])).toEqual([
        [48, 'MISSED'],
        [2, 'PENDING'],
      ]);
      expect(before.items[1].dueAt).toBe(
        new Date(start.getTime() - 2 * HOUR).toISOString(),
      );

      const manualLink = await as(
        api().post(`/api/v1/appointments/${withEmail}/confirmation-link`),
        tokens[ClinicRole.RECEPTION],
      ).expect(201);
      const manualToken = (
        manualLink.body as { token?: string; url: string }
      ).url
        .split('/')
        .pop();

      await runReminders();
      // Repetirlo no manda otro.
      await runReminders();

      // El registro de las clínicas también pasó por este mailer (verificación).
      const sentReminders = () =>
        mailer.sent.filter((e) => e.subject.startsWith('Recordatorio'));
      await waitFor(
        () => sentReminders().length === 1,
        'el despachador entrega el recordatorio',
      );
      const [email] = sentReminders();
      expect(
        await raw.emailOutbox.count({
          where: {
            tenantId: clinic.tenantId,
            template: 'APPOINTMENT_REMINDER',
          },
        }),
      ).toBe(1);
      expect(email.to).toBe('carolina.duque@example.com');
      expect(email.subject).toBe(
        'Recordatorio de tu cita en Clinica dx026-e2e',
      );
      expect(email.text).toContain('Sede: Sede principal');
      expect(email.text).toContain('Profesional: Dr. Owner');
      expect(email.text).toContain('(hora de la sede)');
      expect(email.text).not.toContain('muela');
      const token = /\/confirmar\/([A-Za-z0-9_-]{43})/.exec(email.text)?.[1];
      expect(token).toBeDefined();

      // El enlace del email es el de DX-005: abre la confirmación pendiente.
      const pub = await api()
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host)
        .expect(200);
      expect((pub.body as { status: string }).status).toBe('PENDING');

      await waitFor(async () => {
        const r = await reminders(withEmail);
        return r.items[1]?.emailDelivery === 'SENT';
      }, 'la entrega del email se refleja en el estado');
      const after = await reminders(withEmail);
      expect(after.items.map((i) => [i.leadHours, i.state])).toEqual([
        [48, 'MISSED'],
        [2, 'SENT'],
      ]);
      expect(after.items[1].sentAt).not.toBeNull();

      const skipped = await reminders(noEmail, tokens[ClinicRole.DENTIST]);
      expect(skipped.items[1]).toMatchObject({
        leadHours: 2,
        state: 'SKIPPED',
        skipReason: 'NO_EMAIL',
      });

      // El registro guarda el id del mensaje, no el cuerpo.
      const row = await raw.appointmentReminder.findFirstOrThrow({
        where: { appointmentId: withEmail },
      });
      expect(row.outboundMessageId).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain('carolina');
      // DX-160: WhatsApp anterior al recordatorio sigue confirmando por HTTP.
      await api()
        .post(`/api/v1/public/appointment-confirmations/${manualToken}`)
        .set('X-Tenant-Host', clinic.host)
        .send({ action: 'confirm' })
        .expect(200);
      const closed = await raw.appointmentConfirmation.findMany({
        where: { appointmentId: withEmail },
      });
      expect(closed).toHaveLength(2);
      expect(
        closed.every(
          (link) => link.respondedAt !== null && link.response === 'CONFIRM',
        ),
      ).toBe(true);
      await api()
        .post(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host)
        .send({ action: 'cancel' })
        .expect(409);
    });

    it('DX-160: API y Swagger distinguen FAILED con motivo seguro', async () => {
      const id = await book(
        await createPatient('failed@example.com', '26160'),
        new Date(Date.now() + 8 * HOUR),
      );
      const appt = await raw.appointment.findUniqueOrThrow({ where: { id } });
      const enqueue = jest
        .spyOn(app.get(EmailOutbox), 'enqueue')
        .mockRejectedValue(
          Object.assign(new Error('failed@example.com private'), {
            code: 'ECONNRESET',
          }),
        );
      try {
        await app.get(JobQueue).enqueue(
          SEND_REMINDER_JOB,
          {
            appointmentId: id,
            leadHours: 2,
            start: appt.start.toISOString(),
          },
          { tenantId: clinic.tenantId, maxAttempts: 1 },
        );
        // El reloj del handler necesita la ventana de envío para este job.
        const reminderClock = app.get(ReminderClock);
        const now = jest
          .spyOn(reminderClock, 'now')
          .mockReturnValue(new Date(appt.start.getTime() - 2 * HOUR));
        try {
          await app.get(JobWorker).drain();
        } finally {
          now.mockRestore();
        }
      } finally {
        enqueue.mockRestore();
      }
      expect(
        (await reminders(id)).items.find((item) => item.leadHours === 2),
      ).toMatchObject({
        state: 'FAILED',
        failureReason: 'Error ECONNRESET',
        sentAt: null,
      });
      expect(
        await raw.outboundMessage.findFirstOrThrow({
          where: { appointmentId: id },
        }),
      ).toMatchObject({ status: 'FAILED', lastError: 'Error ECONNRESET' });
      const swagger = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(
        swagger.components?.schemas?.AppointmentReminderState,
      ).toMatchObject({
        enum: expect.arrayContaining([
          'PENDING',
          'SENT',
          'SKIPPED',
          'FAILED',
        ]) as string[],
      });
      expect(
        swagger.components?.schemas?.AppointmentReminderItemDto,
      ).toMatchObject({ properties: { failureReason: { nullable: true } } });
    });

    it('DX-203: un menor sin email con responsable que recibe avisos recibe el recordatorio en el email del responsable, y la cita lo dice', async () => {
      const minor = await as(api().post('/api/v1/patients'), clinic.adminToken)
        .send({
          firstName: 'Tomás',
          lastName: 'Ortiz',
          docType: 'TI',
          docNumber: '26010',
          sex: 'M',
          birthDate: '2016-04-10',
        })
        .expect(201);
      const minorId = (minor.body as { id: string }).id;
      await as(
        api().post(`/api/v1/patients/${minorId}/responsible-parties`),
        tokens[ClinicRole.RECEPTION],
      )
        .send({
          fullName: 'Claudia Navarro',
          email: 'claudia.navarro@example.com',
          relationship: 'MOTHER',
          isPayer: true,
        })
        .expect(201);
      // Sin pisar las citas de 30 min del test anterior: su recordatorio de
      // 2 h se recupera dentro del margen de 1 h (DX-026).
      const id = await book(minorId, new Date(Date.now() + 90 * MIN));

      await runReminders();
      const toResponsible = () =>
        mailer.sent.filter(
          (e) =>
            e.subject.startsWith('Recordatorio') &&
            e.to === 'claudia.navarro@example.com',
        );
      await waitFor(
        () => toResponsible().length === 1,
        'el despachador entrega el recordatorio al responsable',
      );
      const [email] = toResponsible();
      // Saluda a la responsable y nombra al paciente.
      expect(email.text).toContain('Hola, Claudia');
      expect(email.text).toContain('la cita de Tomás');

      const r = await reminders(id);
      expect(r.items[1]).toMatchObject({
        leadHours: 2,
        state: 'SENT',
        sentToResponsible: true,
      });
      // El registro de envíos lo dice (y guarda el destino enmascarado).
      const outbound = await raw.outboundMessage.findFirstOrThrow({
        where: { appointmentId: id },
        select: { recipientKind: true, recipientMasked: true },
      });
      expect(outbound.recipientKind).toBe('RESPONSIBLE');
      expect(outbound.recipientMasked).not.toContain('claudia.navarro');
    });

    it('cualquier rol de la agenda lo ve; otra clínica recibe 404', async () => {
      const id = await book(
        await createPatient('ana@example.com', '26003'),
        new Date(Date.now() + 5 * 24 * HOUR),
      );
      for (const role of [
        ClinicRole.ADMIN,
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        expect((await reminders(id, tokens[role])).items).toHaveLength(2);
      }
      await as(
        api().get(`/api/v1/appointments/${id}/reminders`),
        other.adminToken,
        other.host,
      ).expect(404);
    });

    it('en una sede sin recordatorios no hay nada pendiente', async () => {
      await as(
        api().put(`/api/v1/reminder-settings/${mainLocationId}`),
        clinic.adminToken,
      )
        .send({ enabled: false, leadHours: [48, 2] })
        .expect(200);
      const id = await book(
        await createPatient('luis@example.com', '26004'),
        new Date(Date.now() + 6 * 24 * HOUR),
      );
      expect(await reminders(id)).toEqual({
        enabled: false,
        leadHours: [48, 2],
        patientBlocker: null,
        items: [],
      });
    });
  });
});
