import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-562: citas en serie por HTTP real (Caracas, UTC−4, horario de alta).
//  - vista previa: las fechas con la misma hora, las que chocan con TODAS
//    sus razones (festivo, solape) y la alternativa del mismo día; no escribe;
//  - crear: las fechas finales, todas o ninguna (409 con todas las que
//    chocan), cada cita con su serie, UN audit_event, UN email y el
//    prospecto movido una vez;
//  - cancelar y mover «esta y las siguientes»: sin tocar las anteriores ni
//    las atendidas, sin «Pendientes por agendar», con su evento;
//  - otra clínica no ve la serie; la validación habla en español.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface SeriesPreviewBody {
  timeZone: string;
  durationMinutes: number;
  occurrences: {
    index: number;
    appointmentId?: string;
    start: string;
    end: string;
    status: 'OK' | 'CONFLICT';
    reasons: { code: string; message: string; holiday?: object }[];
    alternative: { start: string; end: string } | null;
  }[];
}

interface AppointmentBody {
  id: string;
  start: string;
  end: string;
  status: string;
  series?: { id: string; index: number; total: number | null };
}

interface CreatedBody {
  seriesId: string;
  intervalWeeks: number;
  appointments: AppointmentBody[];
  patientNotified: boolean;
  notifyReason: string | null;
}

interface ConflictBody {
  statusCode: number;
  code: string;
  message: string;
  conflicts: {
    index: number;
    appointmentId?: string;
    start: string;
    reasons: { code: string }[];
  }[];
}

const DAY_MS = 86_400_000;

describe('Citas en serie (e2e, DX-562)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let mainId: string;
  let patientId: string;
  let otherPatientId: string;
  let assistantToken: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    c: Clinic = clinic,
    token = c.adminToken,
  ): request.Test => {
    const r = req
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${token}`);
    return c === clinic ? r.set('X-Location-Id', mainId) : r;
  };

  // El lunes de dentro de al menos una semana (una fecha fija caduca).
  const firstMonday = (() => {
    const day = new Date(Date.now() + 7 * DAY_MS);
    day.setUTCDate(day.getUTCDate() + ((8 - day.getUTCDay()) % 7 || 7));
    return day.toISOString().slice(0, 10);
  })();
  const plusDays = (day: string, n: number) =>
    new Date(new Date(`${day}T12:00:00.000Z`).getTime() + n * DAY_MS)
      .toISOString()
      .slice(0, 10);
  // 10:00 de Caracas = 14:00Z; 30 minutos.
  const at = (day: string, hhmm = '14:00') => `${day}T${hhmm}:00.000Z`;

  const base = (over: object = {}) => ({
    patientId,
    providerId: clinic.adminUserId,
    start: at(firstMonday),
    end: at(firstMonday, '14:30'),
    intervalWeeks: 1,
    ...over,
  });

  const preview = (body: object) =>
    as(api().post('/api/v1/appointments/series/preview')).send(body);
  const create = (body: object) =>
    as(api().post('/api/v1/appointments/series')).send(body);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx562-e2e');
    other = await registerClinic(app, 'dx562-e2e-b');
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
      select: { id: true },
    });
    mainId = main.id;
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Ana',
        lastName: 'Serie',
        docType: 'NATIONAL_ID',
        docNumber: '5620001',
        sex: 'F',
        email: 'ana.serie@example.com',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const second = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Luis',
        lastName: 'Otro',
        docType: 'NATIONAL_ID',
        docNumber: '5620002',
        sex: 'M',
      })
      .expect(201);
    otherPatientId = (second.body as { id: string }).id;
    // Festivo el tercer lunes de la serie.
    await as(api().post(`/api/v1/locations/${mainId}/holidays`))
      .send({
        date: plusDays(firstMonday, 14),
        name: 'Fiesta de la sede',
        recurring: false,
      })
      .expect(201);
    // El quinto lunes, el profesional ya tiene otra cita a las 10:00.
    await as(api().post('/api/v1/appointments'))
      .send({
        patientId: otherPatientId,
        providerId: clinic.adminUserId,
        start: at(plusDays(firstMonday, 28)),
        end: at(plusDays(firstMonday, 28), '14:30'),
      })
      .expect(201);
    const assistant = await seedMember(raw, clinic, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinic.host, assistant.email);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  const seriesCount = () =>
    raw.appointmentSeries.count({ where: { tenantId: clinic.tenantId } });
  const appointmentCount = () =>
    raw.appointment.count({ where: { tenantId: clinic.tenantId } });

  let previewBody: SeriesPreviewBody;

  it('vista previa: 6 lunes a la misma hora; festivo y solape marcados con su razón y la alternativa; no escribe', async () => {
    const before = await appointmentCount();
    const res = await preview(base({ count: 6 })).expect(200);
    previewBody = res.body as SeriesPreviewBody;
    expect(previewBody.timeZone).toBe('America/Caracas');
    expect(previewBody.durationMinutes).toBe(30);
    expect(previewBody.occurrences.map((o) => o.start)).toEqual(
      [0, 7, 14, 21, 28, 35].map((n) => at(plusDays(firstMonday, n))),
    );
    expect(previewBody.occurrences.map((o) => o.status)).toEqual([
      'OK',
      'OK',
      'CONFLICT',
      'OK',
      'CONFLICT',
      'OK',
    ]);
    const holiday = previewBody.occurrences[2];
    expect(holiday.reasons).toEqual([
      {
        code: 'LOCATION_HOLIDAY',
        message:
          'Ese día la sede está cerrada por festivo («Fiesta de la sede»): elige otro día.',
        holiday: { date: plusDays(firstMonday, 14), name: 'Fiesta de la sede' },
      },
    ]);
    expect(holiday.alternative).toBeNull();
    const overlap = previewBody.occurrences[4];
    expect(overlap.reasons).toEqual([
      {
        code: 'PROVIDER_OVERLAP',
        message: 'El profesional ya tiene una cita en ese horario',
      },
    ]);
    // A la misma distancia (9:30 o 10:30), la posterior.
    expect(overlap.alternative).toEqual({
      start: at(plusDays(firstMonday, 28), '14:30'),
      end: at(plusDays(firstMonday, 28), '15:00'),
    });
    expect(await appointmentCount()).toBe(before);
    expect(await seriesCount()).toBe(0);
  });

  it('vista previa «hasta» una fecha y validación en español', async () => {
    const until = await preview(
      base({ intervalWeeks: 2, until: plusDays(firstMonday, 28) }),
    ).expect(200);
    expect((until.body as SeriesPreviewBody).occurrences).toHaveLength(3);
    const many = await preview(base({ count: 27 })).expect(400);
    expect(JSON.stringify(many.body)).toContain(
      'Una serie tiene de 2 a 26 citas.',
    );
    const both = await preview(
      base({ count: 3, until: plusDays(firstMonday, 28) }),
    ).expect(400);
    expect((both.body as { message: string }).message).toBe(
      'Indica cuántas veces se repite la cita o hasta qué fecha.',
    );
    const far = await preview(
      base({ intervalWeeks: 12, until: plusDays(firstMonday, 400) }),
    ).expect(400);
    expect((far.body as { message: string }).message).toBe(
      'La fecha final de la serie puede estar como mucho a un año de la primera cita.',
    );
  });

  it('crear con una fecha que choca: 409 con todas las que chocan y no se crea ninguna', async () => {
    const before = await appointmentCount();
    const res = await create(
      base({
        count: 6,
        occurrences: previewBody.occurrences.map((o) => ({ start: o.start })),
      }),
    ).expect(409);
    const body = res.body as ConflictBody;
    expect(body.code).toBe('APPOINTMENT_SERIES_CONFLICT');
    expect(body.message).toBe(
      'Algunas fechas de la serie ya no están libres. Revisa la vista previa y ajústalas u omítelas.',
    );
    expect(body.conflicts.map((c) => [c.index, c.reasons[0].code])).toEqual([
      [3, 'LOCATION_HOLIDAY'],
      [5, 'PROVIDER_OVERLAP'],
    ]);
    // Omitida la 3.ª (el festivo), el 409 sigue nombrando la 5.ª de la vista
    // previa (no la 4.ª de las enviadas) con el `start` enviado.
    const omitted = await create(
      base({
        count: 6,
        occurrences: previewBody.occurrences
          .filter((o) => o.index !== 3)
          .map((o) => ({ start: o.start })),
      }),
    ).expect(409);
    expect((omitted.body as ConflictBody).conflicts).toEqual([
      expect.objectContaining({
        index: 5,
        start: previewBody.occurrences[4].start,
      }),
    ]);
    // Una fecha fuera de los días de la serie: 400.
    const offDay = await create(
      base({
        count: 6,
        occurrences: [
          { start: at(firstMonday) },
          { start: at(plusDays(firstMonday, 1)) },
        ],
      }),
    ).expect(400);
    expect((offDay.body as { message: string }).message).toBe(
      'Cada fecha tiene que caer en uno de los días de la serie (cada semana desde la primera cita). Para otro día, agenda una cita aparte.',
    );
    expect(await appointmentCount()).toBe(before);
    expect(await seriesCount()).toBe(0);
  });

  let created: CreatedBody;

  it('crear: sin el festivo y con la alternativa elegida; 5 citas con su serie, un evento y un email', async () => {
    const occurrences = previewBody.occurrences
      .filter((o) => o.reasons[0]?.code !== 'LOCATION_HOLIDAY')
      .map((o) => ({ start: o.alternative?.start ?? o.start }));
    const res = await create(
      base({ intervalWeeks: 1, count: 6, occurrences }),
    ).expect(201);
    created = res.body as CreatedBody;
    expect(created.intervalWeeks).toBe(1);
    expect(created.patientNotified).toBe(true);
    expect(created.notifyReason).toBeNull();
    expect(created.appointments).toHaveLength(5);
    expect(created.appointments.map((a) => a.series)).toEqual(
      [1, 2, 3, 4, 5].map((index) => ({
        id: created.seriesId,
        index,
        total: 5,
      })),
    );
    expect(created.appointments[3].start).toBe(
      at(plusDays(firstMonday, 28), '14:30'),
    );
    const series = await raw.appointmentSeries.findUniqueOrThrow({
      where: { id: created.seriesId },
    });
    expect(series).toMatchObject({
      tenantId: clinic.tenantId,
      intervalWeeks: 1,
      occurrences: 5,
      createdById: clinic.adminUserId,
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'APPOINTMENT_SERIES_CREATED' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'APPOINTMENT',
      resourceId: created.appointments[0].id,
      patientId,
      actorUserId: clinic.adminUserId,
    });
    expect(events[0].metadata).toEqual({
      reason: 'APPOINTMENT_SERIES_CREATED',
      appointmentSeries: {
        seriesId: created.seriesId,
        appointmentIds: created.appointments.map((a) => a.id),
        dates: created.appointments.map((a) => a.start),
        intervalWeeks: 1,
      },
    });
    // Sin el evento genérico de alta por cita.
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceId: { in: created.appointments.map((a) => a.id) },
          action: 'CREATE',
        },
      }),
    ).toBe(1);
    const emails = await raw.emailOutbox.findMany({
      where: { tenantId: clinic.tenantId, template: 'APPOINTMENT_SERIES' },
    });
    expect(emails).toHaveLength(1);
    // Y su registro de envío (como el recordatorio), enlazado por referenceId.
    const sent = await raw.outboundMessage.findMany({
      where: { tenantId: clinic.tenantId, template: 'appointment-series' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      id: emails[0].referenceId,
      channel: 'EMAIL',
      status: 'QUEUED',
      recipientKind: 'PATIENT',
      appointmentId: created.appointments[0].id,
    });
    // La cita suelta la lleva al leerla.
    const one = await as(
      api().get(`/api/v1/appointments/${created.appointments[1].id}`),
    ).expect(200);
    expect((one.body as AppointmentBody).series).toEqual({
      id: created.seriesId,
      index: 2,
      total: 5,
    });
  });

  it('DX-556: el prospecto del paciente pasa a «Cita agendada» UNA vez, con la primera cita de la serie', async () => {
    const lead = await as(api().post('/api/v1/leads'))
      .send({
        fullName: 'Marta Prospecto',
        phone: '0414 5620011',
        channel: 'WHATSAPP',
        locationId: mainId,
      })
      .expect(201);
    const leadId = (lead.body as { id: string }).id;
    const converted = await as(api().post(`/api/v1/leads/${leadId}/convert`))
      .send({})
      .expect(200);
    const leadPatientId = (converted.body as { patientId: string }).patientId;
    const day = plusDays(firstMonday, 4); // viernes
    const res = await create(
      base({
        patientId: leadPatientId,
        start: at(day, '13:00'),
        end: at(day, '13:30'),
        count: 3,
        notifyPatient: false,
        occurrences: [0, 7, 14].map((n) => ({
          start: at(plusDays(day, n), '13:00'),
        })),
      }),
    ).expect(201);
    const series = res.body as CreatedBody;
    const row = await raw.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(row.stage).toBe('SCHEDULED');
    expect(row.firstAppointmentId).toBe(series.appointments[0].id);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'LEAD',
          resourceId: leadId,
          metadata: { path: ['reason'], equals: 'LEAD_STAGE_CHANGED' },
        },
      }),
    ).toBe(1);
  });

  it('`notifyPatient: false`: sin email', async () => {
    const res = await create(
      base({
        patientId: otherPatientId,
        start: at(plusDays(firstMonday, 1), '15:00'),
        end: at(plusDays(firstMonday, 1), '15:30'),
        count: 2,
        notifyPatient: false,
        occurrences: [
          { start: at(plusDays(firstMonday, 1), '15:00') },
          { start: at(plusDays(firstMonday, 8), '15:00') },
        ],
      }),
    ).expect(201);
    expect(res.body as CreatedBody).toMatchObject({
      patientNotified: false,
      notifyReason: 'DISABLED',
    });
    expect(
      await raw.emailOutbox.count({
        where: { tenantId: clinic.tenantId, template: 'APPOINTMENT_SERIES' },
      }),
    ).toBe(1);
  });

  it('dos series a la vez sobre la misma hora: una gana y la otra es 409, sin 500', async () => {
    const day = plusDays(firstMonday, 2);
    const body = (patient: string) =>
      base({
        patientId: patient,
        start: at(day, '16:00'),
        end: at(day, '16:30'),
        count: 2,
        notifyPatient: false,
        occurrences: [
          { start: at(day, '16:00') },
          { start: at(plusDays(day, 7), '16:00') },
        ],
      });
    const results = await Promise.all([
      create(body(patientId)),
      create(body(otherPatientId)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const lost = results.find((r) => r.status === 409)!.body as ConflictBody;
    expect(lost.code).toBe('APPOINTMENT_SERIES_CONFLICT');
    expect(lost.conflicts[0]?.reasons[0]?.code).toBe('PROVIDER_OVERLAP');
  });

  it('cancelar «esta y las siguientes» desde la 4.ª: no toca las anteriores; sin «Pendientes por agendar»', async () => {
    const fourth = created.appointments[3];
    const res = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/cancel`),
    )
      .send({
        fromAppointmentId: fourth.id,
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'WORK',
        cancelReasonText: 'Cambió de turno en el trabajo',
      })
      .expect(200);
    const body = res.body as {
      seriesId: string;
      appointments: AppointmentBody[];
    };
    expect(body.appointments.map((a) => a.id)).toEqual([
      created.appointments[3].id,
      created.appointments[4].id,
    ]);
    const rows = await raw.appointment.findMany({
      where: { seriesId: created.seriesId },
      orderBy: { seriesIndex: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual([
      'SCHEDULED',
      'SCHEDULED',
      'SCHEDULED',
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(rows[3]).toMatchObject({
      cancelledByKind: 'STAFF_FOR_PATIENT',
      cancelReasonCode: 'WORK',
      cancelReasonText: 'Cambió de turno en el trabajo',
      lateCancellation: false,
    });
    expect(rows[3].noticeMinutes).toBeGreaterThan(0);
    expect(
      await raw.appointmentWaitlistEntry.count({
        where: { tenantId: clinic.tenantId },
      }),
    ).toBe(0);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'APPOINTMENT_SERIES_CANCELLED' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      appointmentSeries: {
        seriesId: created.seriesId,
        appointmentIds: [
          created.appointments[3].id,
          created.appointments[4].id,
        ],
      },
      cancellation: { byKind: 'STAFF_FOR_PATIENT', reasonCode: 'WORK' },
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain('turno');
    // Repetirlo no cancela nada más.
    const again = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/cancel`),
    )
      .send({
        fromAppointmentId: fourth.id,
        cancelledByKind: 'CLINIC',
        cancelReasonCode: 'CLINIC_RESCHEDULE',
      })
      .expect(200);
    expect((again.body as { appointments: unknown[] }).appointments).toEqual(
      [],
    );
  });

  it('cancelar sin motivo: 400 en español; la asistente, con los permisos de cancelar la cita suelta', async () => {
    const res = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/cancel`),
    )
      .send({ fromAppointmentId: created.appointments[0].id })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('Indica quién cancela');
    const single = await as(
      api().patch(`/api/v1/appointments/${created.appointments[0].id}`),
      clinic,
      assistantToken,
    ).send({
      status: 'CANCELLED',
      cancelledByKind: 'CLINIC',
      cancelReasonCode: 'CLINIC_RESCHEDULE',
    });
    // Lo que diga cancelarla suelta, lo dice la serie (y no se cancela nada).
    if (single.status === 200) {
      // Se canceló la suelta: se reactiva para dejar la serie como estaba.
      await as(
        api().patch(`/api/v1/appointments/${created.appointments[0].id}`),
      )
        .send({ status: 'SCHEDULED' })
        .expect(200);
    }
    const series = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/cancel`),
      clinic,
      assistantToken,
    ).send({
      fromAppointmentId: created.appointments[1].id,
      cancelledByKind: 'CLINIC',
      cancelReasonCode: 'CLINIC_RESCHEDULE',
    });
    expect(series.status).toBe(single.status);
    if (series.status === 200) {
      expect(
        (series.body as { appointments: unknown[] }).appointments,
      ).toHaveLength(2);
    }
  });

  it('mover «esta y las siguientes»: vista previa y confirmar; la anterior no se mueve', async () => {
    const day = plusDays(firstMonday, 3); // jueves
    const made = await create(
      base({
        start: at(day, '13:00'),
        end: at(day, '13:45'),
        count: 4,
        notifyPatient: false,
        occurrences: [0, 7, 14, 21].map((n) => ({
          start: at(plusDays(day, n), '13:00'),
        })),
      }),
    ).expect(201);
    const series = made.body as CreatedBody;
    const second = series.appointments[1];
    // Al día siguiente (viernes) a las 11:15 de Caracas.
    const target = at(plusDays(day, 8), '15:15');
    const previewMove = await as(
      api().post(`/api/v1/appointments/series/${series.seriesId}/move/preview`),
    )
      .send({ fromAppointmentId: second.id, start: target })
      .expect(200);
    const moves = (previewMove.body as SeriesPreviewBody).occurrences;
    expect(moves.map((o) => [o.index, o.start, o.status])).toEqual([
      [2, target, 'OK'],
      [3, at(plusDays(day, 15), '15:15'), 'OK'],
      [4, at(plusDays(day, 22), '15:15'), 'OK'],
    ]);
    expect(
      await raw.appointment.count({
        where: { seriesId: series.seriesId, start: new Date(target) },
      }),
    ).toBe(0);

    const res = await as(
      api().post(`/api/v1/appointments/series/${series.seriesId}/move`),
    )
      .send({ fromAppointmentId: second.id, start: target })
      .expect(200);
    const moved = (res.body as { appointments: AppointmentBody[] })
      .appointments;
    expect(moved.map((a) => [a.series?.index, a.start, a.end])).toEqual([
      [2, target, at(plusDays(day, 8), '16:00')],
      [3, at(plusDays(day, 15), '15:15'), at(plusDays(day, 15), '16:00')],
      [4, at(plusDays(day, 22), '15:15'), at(plusDays(day, 22), '16:00')],
    ]);
    const first = await raw.appointment.findUniqueOrThrow({
      where: { id: series.appointments[0].id },
    });
    expect(first.start.toISOString()).toBe(at(day, '13:00'));
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'APPOINTMENT_SERIES_MOVED' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceId: second.id,
    });
    expect(events[0].metadata).toMatchObject({
      appointmentSeries: {
        seriesId: series.seriesId,
        appointmentIds: moved.map((a) => a.id),
        dates: moved.map((a) => a.start),
      },
      move: {
        from: { start: second.start },
        to: { start: target },
      },
    });
  });

  it('mover a una hora que choca: 409 con la fecha y no se mueve ninguna', async () => {
    const res = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/move`),
    )
      .send({
        fromAppointmentId: created.appointments[0].id,
        // El mismo lunes a las 13:30: entre los dos tramos del horario.
        start: at(firstMonday, '17:30'),
      })
      .expect(409);
    const body = res.body as ConflictBody;
    expect(body.code).toBe('APPOINTMENT_SERIES_CONFLICT');
    expect(body.conflicts[0]).toMatchObject({
      index: 1,
      appointmentId: created.appointments[0].id,
      reasons: [{ code: 'BUSINESS_HOURS' }],
    });
    const row = await raw.appointment.findUniqueOrThrow({
      where: { id: created.appointments[0].id },
    });
    expect(row.start.toISOString()).toBe(at(firstMonday));
  });

  it('otra clínica no ve la serie (404) y una cita de otra serie no vale (404)', async () => {
    await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/cancel`),
      other,
    )
      .send({
        fromAppointmentId: created.appointments[0].id,
        cancelledByKind: 'CLINIC',
        cancelReasonCode: 'CLINIC_RESCHEDULE',
      })
      .expect(404);
    const otherPatient = await as(api().post('/api/v1/patients'), other)
      .send({
        firstName: 'Eva',
        lastName: 'Ajena',
        docType: 'NATIONAL_ID',
        docNumber: '5620009',
        sex: 'F',
      })
      .expect(201);
    // Un paciente de otra clínica no entra en la vista previa.
    await preview(
      base({ patientId: (otherPatient.body as { id: string }).id, count: 2 }),
    ).expect(404);
    const res = await as(
      api().post(`/api/v1/appointments/series/${created.seriesId}/move`),
    )
      .send({
        fromAppointmentId: '00000000-0000-4000-8000-000000000000',
        start: at(firstMonday, '15:00'),
      })
      .expect(404);
    expect((res.body as { message: string }).message).toBe(
      'La cita no es de esta serie.',
    );
  });

  // --- Revisión independiente (DX-562) -------------------------------------

  it('equivalencia: hueco reservado, sillón ocupado, fuera del horario de la sede y del profesional (estricto) salen igual en la vista previa y en el 409', async () => {
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    const urgent = await as(api().post('/api/v1/appointment-types'))
      .send({
        name: 'Urgencia de la serie',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      })
      .expect(201);
    const chair = await as(api().post('/api/v1/chairs'))
      .send({ locationId: mainId, name: 'Sillón serie' })
      .expect(201);
    const chairId = (chair.body as { id: string }).id;
    const day = plusDays(firstMonday, 49);
    // 2.ª fecha: un hueco reservado para urgencias en la agenda del dentista.
    await as(api().post('/api/v1/schedule-blocks'))
      .send({
        providerId: dentist.userId,
        locationId: mainId,
        start: at(plusDays(day, 7), '13:45'),
        end: at(plusDays(day, 7), '15:00'),
        kind: 'RESERVED',
        reservedForTypeIds: [(urgent.body as { id: string }).id],
      })
      .expect(201);
    // 3.ª fecha: el sillón lo ocupa otra cita (de otro profesional y paciente).
    await as(api().post('/api/v1/appointments'))
      .send({
        patientId: otherPatientId,
        providerId: clinic.adminUserId,
        chairId,
        start: at(plusDays(day, 14), '14:00'),
        end: at(plusDays(day, 14), '14:30'),
      })
      .expect(201);
    const body = (over: object = {}) =>
      base({
        providerId: dentist.userId,
        chairId,
        start: at(day),
        end: at(day, '14:30'),
        count: 4,
        notifyPatient: false,
        ...over,
      });
    const codesOf = (b: SeriesPreviewBody) =>
      b.occurrences.map((o) => o.reasons.map((r) => r.code));
    const conflictCodes = (b: ConflictBody) =>
      b.conflicts.map((c) => [c.index, c.reasons.map((r) => r.code)]);

    const seen = (await preview(body()).expect(200)).body as SeriesPreviewBody;
    expect(codesOf(seen)).toEqual([
      [],
      ['RESERVED_SLOT'],
      ['CHAIR_OVERLAP'],
      [],
    ]);
    const all = seen.occurrences.map((o) => ({ start: o.start }));
    const refused = (await create(body({ occurrences: all })).expect(409))
      .body as ConflictBody;
    expect(conflictCodes(refused)).toEqual([
      [2, ['RESERVED_SLOT']],
      [3, ['CHAIR_OVERLAP']],
    ]);

    // Fuera del horario de la sede (13:30–14:00 de Caracas, entre tramos).
    const lunch = (over: object = {}) =>
      body({
        start: at(day, '17:30'),
        end: at(day, '18:00'),
        count: 2,
        ...over,
      });
    const hours = (await preview(lunch()).expect(200))
      .body as SeriesPreviewBody;
    expect(codesOf(hours)).toEqual([['BUSINESS_HOURS'], ['BUSINESS_HOURS']]);
    const hoursRefused = (
      await create(
        lunch({
          occurrences: hours.occurrences.map((o) => ({ start: o.start })),
        }),
      ).expect(409)
    ).body as ConflictBody;
    expect(conflictCodes(hoursRefused)).toEqual([
      [1, ['BUSINESS_HOURS']],
      [2, ['BUSINESS_HOURS']],
    ]);

    // El dentista solo atiende los martes y la clínica está en modo estricto.
    await as(api().put(`/api/v1/providers/${dentist.userId}/schedule`))
      .send({
        locations: [
          {
            locationId: mainId,
            ranges: [{ weekday: 2, startMinute: 540, endMinute: 780 }],
          },
        ],
      })
      .expect(200);
    await as(api().put('/api/v1/schedule/settings'))
      .send({ strictProviderSchedule: true })
      .expect(200);
    try {
      const plain = (over: object = {}) =>
        body({
          chairId: undefined,
          start: at(plusDays(day, 28)),
          end: at(plusDays(day, 28), '14:30'),
          count: 2,
          ...over,
        });
      const off = (await preview(plain()).expect(200))
        .body as SeriesPreviewBody;
      expect(codesOf(off)).toEqual([
        ['PROVIDER_OFF_SCHEDULE'],
        ['PROVIDER_OFF_SCHEDULE'],
      ]);
      const offRefused = (
        await create(
          plain({
            occurrences: off.occurrences.map((o) => ({ start: o.start })),
          }),
        ).expect(409)
      ).body as ConflictBody;
      expect(conflictCodes(offRefused)).toEqual([
        [1, ['PROVIDER_OFF_SCHEDULE']],
        [2, ['PROVIDER_OFF_SCHEDULE']],
      ]);
    } finally {
      await as(api().put('/api/v1/schedule/settings'))
        .send({ strictProviderSchedule: false })
        .expect(200);
    }
  });

  it('mover hacia delante con una cita movida suelta fuera de orden: se escribe por fecha y no choca consigo misma', async () => {
    const day = plusDays(firstMonday, 44); // miércoles
    const made = (
      await create(
        base({
          start: at(day, '13:00'),
          end: at(day, '13:30'),
          count: 3,
          notifyPatient: false,
          occurrences: [0, 7, 14].map((n) => ({
            start: at(plusDays(day, n), '13:00'),
          })),
        }),
      ).expect(201)
    ).body as CreatedBody;
    // La 2.ª, suelta, a una semana DESPUÉS de la 3.ª.
    await as(api().patch(`/api/v1/appointments/${made.appointments[1].id}`))
      .send({
        start: at(plusDays(day, 21), '13:00'),
        end: at(plusDays(day, 21), '13:30'),
      })
      .expect(200);
    // +7 días: la 3.ª llega a la hora que deja la 2.ª.
    const moved = (
      await as(api().post(`/api/v1/appointments/series/${made.seriesId}/move`))
        .send({
          fromAppointmentId: made.appointments[0].id,
          start: at(plusDays(day, 7), '13:00'),
        })
        .expect(200)
    ).body as { appointments: AppointmentBody[] };
    expect(moved.appointments.map((a) => [a.series?.index, a.start])).toEqual([
      [1, at(plusDays(day, 7), '13:00')],
      [2, at(plusDays(day, 28), '13:00')],
      [3, at(plusDays(day, 21), '13:00')],
    ]);
  });

  it('una serie y una cita suelta a la vez sobre la misma hora: una gana, la otra 409, sin 500', async () => {
    const day = plusDays(firstMonday, 45); // jueves
    const results = await Promise.all([
      create(
        base({
          start: at(day, '13:00'),
          end: at(day, '13:30'),
          count: 2,
          notifyPatient: false,
          occurrences: [0, 7].map((n) => ({
            start: at(plusDays(day, n), '13:00'),
          })),
        }),
      ),
      as(api().post('/api/v1/appointments')).send({
        patientId: otherPatientId,
        providerId: clinic.adminUserId,
        start: at(plusDays(day, 7), '13:00'),
        end: at(plusDays(day, 7), '13:30'),
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('cancelar la serie siendo de una sede no permitida al usuario: 403 y no se cancela nada', async () => {
    const otherLocation = await as(api().post('/api/v1/locations'))
      .send(locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Este' }))
      .expect(201);
    const otherLocationId = (otherLocation.body as { id: string }).id;
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    await as(api().put(`/api/v1/staff/${reception.userId}/locations`))
      .send({ locationIds: [otherLocationId] })
      .expect(200);
    const token = await loginAs(app, clinic.host, reception.email);
    const res = await api()
      .post(`/api/v1/appointments/series/${created.seriesId}/cancel`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Location-Id', otherLocationId)
      .send({
        fromAppointmentId: created.appointments[0].id,
        cancelledByKind: 'CLINIC',
        cancelReasonCode: 'CLINIC_RESCHEDULE',
      })
      .expect(403);
    expect(typeof (res.body as { message: string }).message).toBe('string');
    expect(
      (
        await raw.appointment.findUniqueOrThrow({
          where: { id: created.appointments[0].id },
        })
      ).status,
    ).not.toBe('CANCELLED');
  });
});
