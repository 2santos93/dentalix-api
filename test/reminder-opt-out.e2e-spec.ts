import {
  Body,
  Controller,
  HttpCode,
  INestApplication,
  Post,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClinicRole, PrismaClient } from '@prisma/client';
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
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import {
  PLAN_REMINDERS_SCHEDULE,
  SEND_REMINDER_JOB,
} from '../src/modules/reminders/application/plan-reminders';
import {
  OptOutByMessageUseCase,
  type InboundReplyResult,
} from '../src/modules/reminders/application/use-cases/reminder-opt-out.use-cases';

// DX-128 de punta a punta: el email de recordatorio lleva un enlace de baja;
// abrirlo no cambia nada, confirmarlo registra la baja (idempotente,
// auditada sin actor y con origen LINK) y el siguiente recordatorio no sale.
// La respuesta «BAJA» por WhatsApp entra por un adaptador FAKE del webhook de
// DX-126 (que aún no existe), que llama al mismo caso de uso que usará.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;
const MIN = 60_000;

/**
 * Adaptador FAKE del webhook de WhatsApp Business (DX-126): traduce su carga
 * (clínica de la conversación, número del remitente y texto) al caso de uso.
 */
@Controller('test/fake-whatsapp-webhook')
class FakeWhatsAppWebhookController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Post()
  @HttpCode(200)
  receive(
    @Body() body: { tenantId: string; from: string; text: string },
  ): Promise<InboundReplyResult> {
    return this.moduleRef
      .get(OptOutByMessageUseCase, { strict: false })
      .execute({
        tenantId: body.tenantId,
        fromPhone: body.from,
        text: body.text,
      });
  }
}

interface OptOutBody {
  status: string;
  patientFirstName: string | null;
  optedOutAt: string | null;
  clinic: { name: string } | null;
}

describe('Baja de recordatorios (e2e, DX-128)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: string;
  const mailer = new CapturingMailer();

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const pub = (req: request.Test, host = clinic.host) =>
    req.set('X-Tenant-Host', host);

  async function createPatient(doc: string, extra: object = {}) {
    const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName: 'Carolina Andrea',
        lastName: 'Duque',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
        ...extra,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function book(patientId: string, start: Date): Promise<string> {
    const res = await as(api().post('/api/v1/appointments'), reception)
      .send({
        patientId,
        providerId: clinic.adminUserId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 2 * MIN).toISOString(),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Un tick del barrido y, adelantados a su hora, los envíos que encoló. */
  async function runReminders(): Promise<void> {
    await sweep();
    await raw.job.updateMany({
      where: { name: SEND_REMINDER_JOB, state: 'PENDING' },
      data: { runAt: new Date(Date.now() - MIN) },
    });
    await app.get(JobWorker).drain();
  }

  /** Un tick del barrido programado (encola los envíos para su hora). */
  async function sweep(): Promise<void> {
    const worker = app.get(JobWorker);
    await worker.runOnce();
    await raw.jobSchedule.update({
      where: { name: PLAN_REMINDERS_SCHEDULE },
      data: { nextRunAt: new Date(Date.now() - MIN) },
    });
    await worker.drain();
  }

  const reminderEmailsTo = (to: string) =>
    mailer.sent.filter(
      (e) => e.to === to && e.subject.startsWith('Recordatorio'),
    );

  beforeAll(async () => {
    app = await createE2eApp({
      controllers: [FakeWhatsAppWebhookController],
      override: (builder) => builder.overrideProvider(MAILER).useValue(mailer),
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx128-baja');
    other = await registerClinic(app, 'dx128-baja-otra');
    const member = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinic.host, member.email);
    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({ timezone: 'America/Bogota', ranges: [] })
      .expect(200);
    const settings = await as(
      api().get('/api/v1/reminder-settings'),
      clinic.adminToken,
    ).expect(200);
    const [{ locationId }] = settings.body as { locationId: string }[];
    await as(
      api().put(`/api/v1/reminder-settings/${locationId}`),
      clinic.adminToken,
    )
      .send({ enabled: true, leadHours: [2] })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('por el enlace del email', () => {
    const email = 'carolina.baja@example.com';
    let patientId: string;
    let token: string;

    it('el recordatorio llega con su enlace de baja', async () => {
      patientId = await createPatient('128101', { email });
      await book(patientId, new Date(Date.now() + 2 * HOUR + 2 * MIN));
      await runReminders();
      const match = await mailer.waitFor(email, /\/baja\/([A-Za-z0-9_-]{43})/);
      token = match[1];
      expect(reminderEmailsTo(email)[0].text).toContain(
        '¿No quieres recibir más recordatorios?',
      );
    });

    it('abrir el enlace solo muestra el nombre de pila y la clínica; no da de baja', async () => {
      const res = await pub(
        api().get(`/api/v1/public/reminder-opt-outs/${token}`),
      ).expect(200);
      expect(res.body).toEqual({
        status: 'ACTIVE',
        patientFirstName: 'Carolina',
        optedOutAt: null,
        clinic: expect.objectContaining({ name: 'Clinica dx128-baja' }),
      } satisfies Record<keyof OptOutBody, unknown>);
      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutAt).toBeNull();
    });

    it('en el host de otra clínica, o con un token inventado, 404', async () => {
      await pub(
        api().get(`/api/v1/public/reminder-opt-outs/${token}`),
        other.host,
      ).expect(404);
      await pub(
        api().post(`/api/v1/public/reminder-opt-outs/${token}`),
        other.host,
      ).expect(404);
      await pub(
        api().post(`/api/v1/public/reminder-opt-outs/${'Z'.repeat(43)}`),
      ).expect(404);
      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutAt).toBeNull();
    });

    it('confirmar registra la baja (origen LINK), es idempotente y queda auditada una vez, sin actor', async () => {
      const first = await pub(
        api().post(`/api/v1/public/reminder-opt-outs/${token}`),
      )
        .set('User-Agent', 'Mail client')
        .expect(200);
      const body = first.body as OptOutBody;
      expect(body.status).toBe('OPTED_OUT');
      expect(body.optedOutAt).not.toBeNull();

      const again = await pub(
        api().post(`/api/v1/public/reminder-opt-outs/${token}`),
      ).expect(200);
      expect(again.body).toEqual(first.body);

      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutSource).toBe('LINK');
      expect(row.reminderOptOutAt?.toISOString()).toBe(body.optedOutAt);
      const link = await raw.reminderOptOutLink.findFirstOrThrow({
        where: { patientId },
      });
      expect(link.usedAt).not.toBeNull();

      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, patientId, action: 'UPDATE' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: null,
        actorRole: null,
        resourceType: 'PATIENT',
        userAgent: 'Mail client',
        metadata: {
          reason: 'REMINDER_OPT_OUT',
          origin: 'LINK',
          changedFields: ['reminderOptOutAt'],
        },
      });
    });

    it('la ficha muestra la baja y el siguiente recordatorio ya no sale', async () => {
      const comms = await as(
        api().get(`/api/v1/patients/${patientId}/communication`),
        reception,
      ).expect(200);
      expect(
        (comms.body as { reminderOptOut: { source: string } }).reminderOptOut,
      ).toMatchObject({ source: 'LINK' });

      mailer.clear();
      const next = await book(
        patientId,
        new Date(Date.now() + 2 * HOUR + 5 * MIN),
      );
      await runReminders();
      expect(reminderEmailsTo(email)).toEqual([]);
      expect(
        await raw.job.count({
          where: {
            name: SEND_REMINDER_JOB,
            payload: { path: ['appointmentId'], equals: next },
          },
        }),
      ).toBe(0);
      const panel = await as(
        api().get(`/api/v1/appointments/${next}/reminders`),
        reception,
      ).expect(200);
      expect(panel.body).toMatchObject({
        patientBlocker: 'OPTED_OUT',
        items: [],
      });
    });
  });

  describe('respondiendo «BAJA» por WhatsApp (adaptador fake de DX-126)', () => {
    it('registra la baja al momento, auditada con origen MESSAGE, y el recordatorio ya encolado no sale', async () => {
      const email = 'luisa@example.com';
      const patientId = await createPatient('128102', {
        email,
        phone: '315 222 3344',
      });
      const appointmentId = await book(
        patientId,
        new Date(Date.now() + 2 * HOUR + 8 * MIN),
      );
      // Encolado: el barrido lo deja para su hora.
      await sweep();
      expect(
        await raw.job.count({
          where: {
            name: SEND_REMINDER_JOB,
            state: 'PENDING',
            payload: { path: ['appointmentId'], equals: appointmentId },
          },
        }),
      ).toBe(1);

      const started = Date.now();
      const res = await api()
        .post('/api/v1/test/fake-whatsapp-webhook')
        .send({
          tenantId: clinic.tenantId,
          from: '573152223344',
          text: 'No más',
        })
        .expect(200);
      expect(res.body).toEqual({ isOptOut: true, optedOut: [patientId] });
      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutSource).toBe('MESSAGE');
      expect(row.reminderOptOutAt!.getTime() - started).toBeLessThan(60_000);
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: clinic.tenantId,
            patientId,
            actorUserId: null,
            metadata: { path: ['origin'], equals: 'MESSAGE' },
          },
        }),
      ).toBe(1);

      await raw.job.updateMany({
        where: { name: SEND_REMINDER_JOB, state: 'PENDING' },
        data: { runAt: new Date(Date.now() - MIN) },
      });
      await app.get(JobWorker).drain();
      expect(reminderEmailsTo(email)).toEqual([]);
      const reminder = await raw.appointmentReminder.findFirstOrThrow({
        where: { appointmentId },
      });
      expect(reminder.skipReason).toBe('OPTED_OUT');
    });

    it('otro texto, u otra clínica, no da de baja a nadie', async () => {
      const patientId = await createPatient('128103', {
        phone: '316 000 1122',
      });
      await api()
        .post('/api/v1/test/fake-whatsapp-webhook')
        .send({
          tenantId: clinic.tenantId,
          from: '573160001122',
          text: 'Sí voy',
        })
        .expect(200, { isOptOut: false, optedOut: [] });
      await api()
        .post('/api/v1/test/fake-whatsapp-webhook')
        .send({ tenantId: other.tenantId, from: '573160001122', text: 'BAJA' })
        .expect(200, { isOptOut: true, optedOut: [] });
      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.reminderOptOutAt).toBeNull();
    });
  });
});
