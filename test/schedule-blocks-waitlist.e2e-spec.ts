import { INestApplication } from '@nestjs/common';
import {
  ClinicRole,
  Prisma,
  PrismaClient,
  ScheduleBlockKind,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';
import { DAY_MONTH, dayMonthNumbers } from './support/sede-day-month';
import { blockConflictMessage } from '../src/modules/schedule-blocks/domain/schedule-block-rules';
import { regionalFormat } from '../src/shared/format/regional-format';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
} from './support/location-fixtures';

// DX-122 en HTTP real: bloqueos de agenda (roles, vacaciones que impiden crear
// y mover, almuerzo que deja agendar con aviso, confirmación sobre citas
// existentes), «Pendientes por agendar» (cancelar / no-show / enlace público
// → una sola entrada, agendar desde ella, descartar, alta manual), «Buscar
// hueco», auditoría y aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BOGOTA_MS = 5 * 60 * 60 * 1000;

/** YYYY-MM-DD (Bogotá) del primer martes a 7 días o más: siempre futuro. */
function nextTuesday(): string {
  let t = Date.now() - BOGOTA_MS + 7 * DAY_MS;
  while (new Date(t).getUTCDay() !== 2) t += DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
/** Hora de pared de Bogotá (UTC−5 fijo) como instante ISO. */
function local(day: string, hhmm: string): string {
  return new Date(`${day}T${hhmm}:00-05:00`).toISOString();
}

/** `[díaIni, mesIni, díaFin, mesFin]` del 409 de unas vacaciones de días completos. */
function vacationRange(message: string): number[] {
  const range = new RegExp(
    `^La agenda del profesional está bloqueada \\(Vacaciones\\) del ${DAY_MONTH} al ${DAY_MONTH}\\. Elige otro horario\\.$`,
  ).exec(message);
  expect(range).not.toBeNull();
  return range!.slice(1).map(Number);
}

const TUE = nextTuesday();
const MON = addDays(TUE, -1);
const WED = addDays(TUE, 1);
const THU = addDays(TUE, 2);
const SAT = addDays(TUE, 4);

interface Member {
  userId: string;
  token: string;
}
interface Body {
  id: string;
  [key: string]: unknown;
}
interface WaitlistItem {
  id: string;
  patientId: string;
  patientFirstName: string;
  sourceAppointmentId: string | null;
  sourceAppointment: { status: string } | null;
  status: string;
  priority: string;
  resolvedAppointmentId: string | null;
}
interface WaitlistPage {
  items: WaitlistItem[];
  total: number;
}

describe('Bloqueos de agenda y pendientes por agendar (e2e, DX-122)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: Member;
  let dentist2: Member;
  let reception: Member;
  let assistant: Member;
  let locationId: string;
  let otherLocationId: string;
  const patients: string[] = [];
  let otherPatientId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole, c = clinic): Promise<Member> {
    const m = await seedMember(raw, c, role);
    return { userId: m.userId, token: await loginAs(app, c.host, m.email) };
  }

  async function createPatient(c: Clinic, doc: string, firstName: string) {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName,
        lastName: 'Pendiente',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as Body).id;
  }

  async function firstLocation(c: Clinic): Promise<string> {
    const res = await as(
      api().get('/api/v1/locations'),
      c.adminToken,
      c.host,
    ).expect(200);
    return (res.body as Body[])[0].id;
  }

  function book(
    providerId: string,
    day: string,
    hhmm: string,
    patient = 0,
    minutes = 30,
  ) {
    const start = local(day, hhmm);
    return as(api().post('/api/v1/appointments'), reception.token).send({
      patientId: patients[patient],
      providerId,
      start,
      end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    });
  }

  function block(token: string, body: Record<string, unknown>) {
    return as(api().post('/api/v1/schedule-blocks'), token).send(body);
  }

  async function waitlist(
    query = '',
    token = reception.token,
    host = clinic.host,
  ) {
    const res = await as(
      api().get(`/api/v1/waitlist${query}`),
      token,
      host,
    ).expect(200);
    return res.body as WaitlistPage;
  }

  const auditCount = (
    resourceType: string,
    action: string,
    resourceId?: string,
  ) =>
    raw.auditEvent.count({
      where: {
        tenantId: clinic.tenantId,
        resourceType: resourceType as 'SCHEDULE_BLOCK',
        action: action as 'CREATE',
        ...(resourceId ? { resourceId } : {}),
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx122-e2e');
    other = await registerClinic(app, 'dx122-e2e-otra');
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    const d2 = await raw.user.create({
      data: {
        email: 'dentista2@dx122-e2e.test',
        passwordHash: (
          await raw.user.findFirstOrThrow({ where: { id: dentist.userId } })
        ).passwordHash,
        fullName: 'Dra. Segunda',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: d2.id,
        role: ClinicRole.DENTIST,
      },
    });
    dentist2 = {
      userId: d2.id,
      token: await loginAs(app, clinic.host, d2.email),
    };

    // Horario conocido de la sede: lun–vie 9–13 y 15–19, Bogotá.
    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({
        ranges: [1, 2, 3, 4, 5].flatMap((weekday) => [
          { weekday, startMinute: 540, endMinute: 780 },
          { weekday, startMinute: 900, endMinute: 1140 },
        ]),
      })
      .expect(200);
    locationId = await firstLocation(clinic);
    otherLocationId = await firstLocation(other);
    patients.push(await createPatient(clinic, '122001', 'Ana'));
    patients.push(await createPatient(clinic, '122002', 'Berta'));
    patients.push(await createPatient(clinic, '122003', 'Carla'));
    otherPatientId = await createPatient(other, '122901', 'Otra');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('roles y validación: la asistente no bloquea; la doctora, solo su agenda', async () => {
    const own = {
      providerId: dentist.userId,
      start: local(MON, '08:00'),
      end: local(MON, '08:30'),
      kind: 'MEETING',
    };
    await block(assistant.token, own).expect(403);
    await block(dentist.token, { ...own, providerId: dentist2.userId }).expect(
      403,
    );
    await block(dentist.token, {
      locationId,
      start: own.start,
      end: own.end,
      kind: 'MEETING',
    }).expect(403);
    const created = await block(dentist.token, own).expect(201);
    await as(
      api().delete(`/api/v1/schedule-blocks/${(created.body as Body).id}`),
      dentist.token,
    ).expect(204);

    await as(
      api().patch('/api/v1/schedule-blocks/no-es-un-uuid'),
      reception.token,
    )
      .send({ allowsBooking: true })
      .expect(400);
    const backwards = await block(reception.token, {
      ...own,
      end: own.start,
    }).expect(400);
    expect((backwards.body as { message: string }).message).toMatch(
      /posterior/,
    );
    await block(reception.token, { ...own, note: 'x'.repeat(201) }).expect(400);
    await block(reception.token, {
      start: own.start,
      end: own.end,
      kind: 'OTHER',
    }).expect(400);
    await block(reception.token, {
      ...own,
      providerId: 'f3a1c2d4-0000-4000-8000-000000000000',
    }).expect(404);
  });

  it('vacaciones de martes a viernes impiden crear y mover sus citas (409) y se ven en la agenda', async () => {
    const vacation = await block(reception.token, {
      providerId: dentist.userId,
      start: local(TUE, '00:00'),
      end: local(SAT, '00:00'),
      kind: 'VACATION',
      note: 'Vacaciones',
    }).expect(201);
    expect(vacation.body).toMatchObject({
      providerId: dentist.userId,
      locationId: null,
      allowsBooking: false,
    });

    const listed = await as(
      api().get(
        `/api/v1/schedule-blocks?from=${local(MON, '00:00')}&to=${local(SAT, '00:00')}`,
      ),
      assistant.token,
    ).expect(200);
    expect((listed.body as Body[]).map((b) => b.id)).toContain(
      (vacation.body as Body).id,
    );

    const rejected = await book(dentist.userId, WED, '10:00').expect(409);
    // Del martes al viernes (último día elegido), en día/mes de la sede. El
    // ICU de es-CO quita el cero del día y del mes («5/1», «3/11»): se comparan
    // números, no el relleno, para que no dependa de la fecha (DAY_MONTH).
    expect(
      vacationRange((rejected.body as { message: string }).message),
    ).toEqual([...dayMonthNumbers(TUE), ...dayMonthNumbers(addDays(TUE, 3))]);

    const monday = await book(dentist.userId, MON, '10:00').expect(201);
    await as(
      api().patch(`/api/v1/appointments/${(monday.body as Body).id}`),
      reception.token,
    )
      .send({ start: local(WED, '10:00'), end: local(WED, '10:30') })
      .expect(409);
    // Otra doctora, el mismo día: libre.
    await book(dentist2.userId, WED, '10:00', 1).expect(201);
    await expect(
      auditCount('SCHEDULE_BLOCK', 'CREATE', (vacation.body as Body).id),
    ).resolves.toBe(1);
  });

  it('un almuerzo de la sede que deja agendar: la cita se crea con aviso', async () => {
    await block(reception.token, {
      locationId,
      start: local(MON, '12:00'),
      end: local(MON, '13:00'),
      kind: 'LUNCH',
      allowsBooking: true,
    }).expect(201);
    const created = await book(dentist2.userId, MON, '12:00', 2).expect(201);
    expect((created.body as { warnings: string[] }).warnings).toEqual([
      'La cita cae en un bloqueo que permite agendar: Almuerzo (12:00–13:00).',
    ]);
  });

  it('bloquear encima de citas no las borra: las lista y pide confirmación', async () => {
    const scope = {
      providerId: dentist2.userId,
      start: local(MON, '11:00'),
      end: local(MON, '13:00'),
    };
    const conflict = await block(reception.token, {
      ...scope,
      kind: 'MEETING',
    }).expect(409);
    expect((conflict.body as { message: string }).message).toBe(
      'Hay 1 cita en ese horario. Las citas no se borran: revísalas y confirma el bloqueo.',
    );
    const affected = await as(
      api().get(
        `/api/v1/schedule-blocks/affected-appointments?providerId=${scope.providerId}&start=${scope.start}&end=${scope.end}`,
      ),
      reception.token,
    ).expect(200);
    expect(affected.body).toEqual({
      items: [
        expect.objectContaining({
          patientFirstName: 'Carla',
          status: 'SCHEDULED',
        }),
      ],
      total: 1,
    });
    const confirmed = await block(reception.token, {
      ...scope,
      kind: 'MEETING',
      confirmAffected: true,
    }).expect(201);
    const appointmentId = (affected.body as { items: Body[] }).items[0].id;
    const still = await as(
      api().get(`/api/v1/appointments/${appointmentId}`),
      reception.token,
    ).expect(200);
    expect(still.body).toMatchObject({ status: 'SCHEDULED' });

    const id = (confirmed.body as Body).id;
    await as(
      api().delete(`/api/v1/schedule-blocks/${id}`),
      reception.token,
    ).expect(204);
    await as(
      api().delete(`/api/v1/schedule-blocks/${id}`),
      reception.token,
    ).expect(404);
    await expect(auditCount('SCHEDULE_BLOCK', 'DELETE', id)).resolves.toBe(1);
  });

  let cancelledEntryId: string;
  let linkEntryId: string;

  it('cancelar y luego marcar no-show deja UNA entrada en pendientes, sin pasos extra', async () => {
    const appt = await book(dentist2.userId, THU, '10:00', 1, 45).expect(201);
    const id = (appt.body as Body).id;
    for (const status of ['CANCELLED', 'NO_SHOW']) {
      await as(api().patch(`/api/v1/appointments/${id}`), reception.token)
        .send({ status, ...STAFF_CANCELLATION })
        .expect(200);
    }
    const page = await waitlist();
    const entries = page.items.filter((e) => e.sourceAppointmentId === id);
    expect(entries).toEqual([
      expect.objectContaining({
        status: 'OPEN',
        patientId: patients[1],
        patientFirstName: 'Berta',
      }),
    ]);
    expect(entries[0].sourceAppointment?.status).toBe('NO_SHOW');
    cancelledEntryId = entries[0].id;
    await expect(
      auditCount('WAITLIST_ENTRY', 'CREATE', cancelledEntryId),
    ).resolves.toBe(1);
  });

  it('cancelar desde el enlace público de confirmación también lo deja en pendientes', async () => {
    const appt = await book(dentist2.userId, THU, '15:00', 2).expect(201);
    const id = (appt.body as Body).id;
    const link = await as(
      api().post(`/api/v1/appointments/${id}/confirmation-link`),
      reception.token,
    ).expect(201);
    const token = (link.body as { url: string }).url.split('/confirmar/')[1];
    await api()
      .post(`/api/v1/public/appointment-confirmations/${token}`)
      .set('X-Tenant-Host', clinic.host)
      .send({ action: 'cancel' })
      .expect((res) => expect(res.status).toBeLessThan(300));
    const entry = (await waitlist()).items.find(
      (e) => e.sourceAppointmentId === id,
    );
    expect(entry).toMatchObject({ status: 'OPEN', patientId: patients[2] });
    linkEntryId = entry!.id;
  });

  let mondayOpenings: { start: string; end: string }[];

  it('«Buscar hueco»: solo dentro del horario de la sede, fuera de bloqueos y sin solapes', async () => {
    const q = (providerId: string, from: string, to: string, extra = '') =>
      as(
        api().get(
          `/api/v1/appointments/openings?providerId=${providerId}&locationId=${locationId}&from=${from}&to=${to}&durationMinutes=30${extra}`,
        ),
        reception.token,
      );
    const monday = await q(dentist2.userId, MON, MON).expect(200);
    mondayOpenings = (
      monday.body as { openings: { start: string; end: string }[] }
    ).openings;
    expect(monday.body).toMatchObject({
      timeZone: 'America/Bogota',
      durationMinutes: 30,
      truncated: false,
    });
    // 9–13 menos el almuerzo (12–13, con su cita dentro) y 15–19.
    expect(mondayOpenings).toEqual([
      { start: local(MON, '09:00'), end: local(MON, '12:00') },
      { start: local(MON, '15:00'), end: local(MON, '19:00') },
    ]);
    // La doctora de vacaciones no tiene huecos de martes a viernes.
    const vacation = await q(dentist.userId, TUE, addDays(TUE, 3)).expect(200);
    expect((vacation.body as { openings: unknown[] }).openings).toEqual([]);

    await q(dentist2.userId, MON, addDays(MON, 40)).expect(400);
    await q(dentist2.userId, MON, MON, `&patientId=${otherPatientId}`).expect(
      404,
    );
    await as(
      api().get(
        `/api/v1/appointments/openings?providerId=${dentist2.userId}&locationId=${otherLocationId}&from=${MON}&to=${MON}&durationMinutes=30`,
      ),
      reception.token,
    ).expect(404);
  });

  it('«Agendar aquí» crea la cita y saca la entrada de la lista; descartar pide motivo', async () => {
    const scheduled = await as(
      api().post(`/api/v1/waitlist/${cancelledEntryId}/schedule`),
      reception.token,
    )
      .send({ providerId: dentist2.userId, start: mondayOpenings[1].start })
      .expect(201);
    expect(scheduled.body).toMatchObject({
      patientId: patients[1],
      providerId: dentist2.userId,
      locationId,
      start: local(MON, '15:00'),
      end: local(MON, '15:45'),
      warnings: [],
    });
    expect((await waitlist()).items.map((e) => e.id)).not.toContain(
      cancelledEntryId,
    );
    const done = await waitlist('?status=SCHEDULED');
    expect(done.items).toEqual([
      expect.objectContaining({
        id: cancelledEntryId,
        resolvedAppointmentId: (scheduled.body as Body).id,
      }),
    ]);
    await as(
      api().post(`/api/v1/waitlist/${cancelledEntryId}/schedule`),
      reception.token,
    )
      .send({ providerId: dentist2.userId, start: local(MON, '17:00') })
      .expect(409);
    await expect(
      auditCount('WAITLIST_ENTRY', 'UPDATE', cancelledEntryId),
    ).resolves.toBe(1);

    const dismiss = (reason: string) =>
      as(
        api().post(`/api/v1/waitlist/${linkEntryId}/dismiss`),
        reception.token,
      ).send({ reason });
    await dismiss('   ').expect(400);
    await as(
      api().post(`/api/v1/waitlist/${linkEntryId}/dismiss`),
      reception.token,
    )
      .send({})
      .expect(400);
    await dismiss('x'.repeat(201)).expect(400);
    const dismissed = await dismiss('No contesta en tres intentos').expect(200);
    expect(dismissed.body).toMatchObject({
      status: 'DISMISSED',
      dismissReason: 'No contesta en tres intentos',
    });
    await dismiss('Otra vez').expect(409);
    await expect(
      auditCount('WAITLIST_ENTRY', 'DELETE', linkEntryId),
    ).resolves.toBe(1);
    await as(
      api().post('/api/v1/waitlist/no-es-un-uuid/dismiss'),
      reception.token,
    )
      .send({ reason: 'x' })
      .expect(400);
  });

  it('alta manual: urgentes primero; paciente o sede de otra clínica, 404', async () => {
    const manual = await as(api().post('/api/v1/waitlist'), assistant.token)
      .send({
        patientId: patients[0],
        priority: 'URGENT',
        preferredWindow: 'Tardes',
        note: 'Dolor',
      })
      .expect(201);
    expect(manual.body).toMatchObject({
      status: 'OPEN',
      priority: 'URGENT',
      durationMinutes: 30,
      locationId,
    });
    const page = await waitlist('?pageSize=1');
    expect(page.items[0].id).toBe((manual.body as Body).id);
    await as(api().post('/api/v1/waitlist'), reception.token)
      .send({ patientId: otherPatientId })
      .expect(404);
    await as(api().post('/api/v1/waitlist'), reception.token)
      .send({ patientId: patients[1], locationId: otherLocationId })
      .expect(404);
    await as(api().post('/api/v1/waitlist'), reception.token)
      .send({ patientId: patients[0], preferredWindow: 'x'.repeat(81) })
      .expect(400);
    await expect(
      auditCount('WAITLIST_ENTRY', 'CREATE', (manual.body as Body).id),
    ).resolves.toBe(1);
  });

  it('aislamiento: otra clínica no ve ni toca bloqueos ni pendientes de esta', async () => {
    const blocks = await as(
      api().get(
        `/api/v1/schedule-blocks?from=${local(MON, '00:00')}&to=${local(SAT, '00:00')}`,
      ),
      other.adminToken,
      other.host,
    ).expect(200);
    expect(blocks.body).toEqual([]);
    expect(await waitlist('', other.adminToken, other.host)).toMatchObject({
      items: [],
      total: 0,
    });

    const ours = await as(
      api().get(
        `/api/v1/schedule-blocks?from=${local(MON, '00:00')}&to=${local(SAT, '00:00')}`,
      ),
      reception.token,
    ).expect(200);
    const blockId = (ours.body as Body[])[0].id;
    await as(
      api().patch(`/api/v1/schedule-blocks/${blockId}`),
      other.adminToken,
      other.host,
    )
      .send({ allowsBooking: true })
      .expect(404);
    await as(
      api().delete(`/api/v1/schedule-blocks/${blockId}`),
      other.adminToken,
      other.host,
    ).expect(404);
    const open = await waitlist();
    await as(
      api().post(`/api/v1/waitlist/${open.items[0].id}/dismiss`),
      other.adminToken,
      other.host,
    )
      .send({ reason: 'Ajena' })
      .expect(404);
    await as(api().post('/api/v1/waitlist'), other.adminToken, other.host)
      .send({ patientId: patients[0] })
      .expect(404);
    await as(
      api().get(
        `/api/v1/schedule-blocks?from=${local(MON, '00:00')}&to=${local(SAT, '00:00')}&locationId=${locationId}`,
      ),
      other.adminToken,
      other.host,
    ).expect(404);
    await block(other.adminToken, {
      providerId: dentist.userId,
      start: local(MON, '08:00'),
      end: local(MON, '09:00'),
      kind: 'OTHER',
    })
      .set('X-Tenant-Host', other.host)
      .expect(404);
  });

  describe('cambios tras revisión y QA', () => {
    it('reactivar una cita cancelada la saca de pendientes (queda SCHEDULED con la propia cita)', async () => {
      const appt = await book(dentist2.userId, THU, '17:00', 0).expect(201);
      const id = (appt.body as Body).id;
      const patch = (status: string) =>
        as(api().patch(`/api/v1/appointments/${id}`), reception.token)
          .send({ status, ...STAFF_CANCELLATION })
          .expect(200);
      await patch('CANCELLED');
      expect(
        (await waitlist()).items.map((e) => e.sourceAppointmentId),
      ).toContain(id);
      await patch('SCHEDULED');
      expect(
        (await waitlist()).items.map((e) => e.sourceAppointmentId),
      ).not.toContain(id);
      const done = await waitlist('?status=SCHEDULED');
      expect(
        done.items.find((e) => e.sourceAppointmentId === id),
      ).toMatchObject({
        resolvedAppointmentId: id,
      });
      await expect(
        auditCount('WAITLIST_ENTRY', 'UPDATE'),
      ).resolves.toBeGreaterThanOrEqual(2);

      // Y si vuelve a cancelarse, el paciente vuelve a la lista (misma entrada).
      await patch('CANCELLED');
      const again = (await waitlist()).items.filter(
        (e) => e.sourceAppointmentId === id,
      );
      expect(again).toHaveLength(1);
      expect(again[0]).toMatchObject({ status: 'OPEN' });
    });

    it('el alta manual no duplica a un paciente que ya está en pendientes (409)', async () => {
      await as(api().post('/api/v1/waitlist'), reception.token)
        .send({ patientId: patients[2] })
        .expect(201);
      const dup = await as(api().post('/api/v1/waitlist'), reception.token)
        .send({ patientId: patients[2] })
        .expect(409);
      expect((dup.body as { message: string }).message).toBe(
        'Este paciente ya está en pendientes por agendar.',
      );
    });

    it('no se bloquea ni se buscan huecos de quien no atiende (recepción): 400', async () => {
      await block(reception.token, {
        providerId: reception.userId,
        start: local(MON, '08:00'),
        end: local(MON, '09:00'),
        kind: 'MEETING',
      }).expect(400);
      await as(
        api().get(
          `/api/v1/appointments/openings?providerId=${reception.userId}&locationId=${locationId}&from=${MON}&to=${MON}&durationMinutes=30`,
        ),
        reception.token,
      ).expect(400);
    });

    it('endurecer un bloqueo con citas dentro pide confirmación', async () => {
      await book(dentist2.userId, THU, '18:00', 0).expect(201);
      const lunch = await block(reception.token, {
        providerId: dentist2.userId,
        start: local(THU, '18:00'),
        end: local(THU, '19:00'),
        kind: 'LUNCH',
        allowsBooking: true,
        confirmAffected: true,
      }).expect(201);
      const id = (lunch.body as Body).id;
      await as(api().patch(`/api/v1/schedule-blocks/${id}`), reception.token)
        .send({ allowsBooking: false })
        .expect(409);
      await as(api().patch(`/api/v1/schedule-blocks/${id}`), reception.token)
        .send({ allowsBooking: false, confirmAffected: true })
        .expect(200);
    });
  });

  describe('formato y reloj de la sede (G1-B, DX-350)', () => {
    const NEXT_TUE = addDays(TUE, 7);
    const NEXT_WED = addDays(TUE, 8);
    const NEXT_THU = addDays(TUE, 9);
    /** Ajustes de la sede durante `run`; después, los de siempre. */
    async function withLocationSettings(
      data: { locale: string; hourCycle: string | null },
      run: () => Promise<void>,
    ) {
      const before = await raw.location.findUniqueOrThrow({
        where: { id: locationId },
        select: { locale: true, hourCycle: true },
      });
      await raw.location.update({ where: { id: locationId }, data });
      try {
        await run();
      } finally {
        await raw.location.update({ where: { id: locationId }, data: before });
      }
    }

    it('block conflict message follows the location format', async () => {
      const created = await block(reception.token, {
        providerId: dentist2.userId,
        start: local(NEXT_TUE, '15:00'),
        end: local(NEXT_TUE, '17:00'),
        kind: 'MEETING',
      }).expect(201);
      try {
        await withLocationSettings(
          { locale: REGIONAL_NEW_YORK_FIXTURE.locale, hourCycle: 'h12' },
          async () => {
            const fmt = regionalFormat(REGIONAL_NEW_YORK_FIXTURE);
            const day = fmt.dayMonth(
              new Date(local(NEXT_TUE, '15:00')),
              'America/Bogota',
            );
            const rejected = await book(
              dentist2.userId,
              NEXT_TUE,
              '16:00',
              2,
            ).expect(409);
            expect((rejected.body as { message: string }).message).toBe(
              `La agenda del profesional está bloqueada (Reunión) del ${day} 3:00 p. m. al ${day} 5:00 p. m. Elige otro horario.`,
            );
            // Orden mes/día del locale, no el de la sede de siempre.
            expect(day).toBe(
              `${NEXT_TUE.slice(5, 7)}/${NEXT_TUE.slice(8, 10)}`,
            );
          },
        );
        // Con 24 h, lo que mostraba (fixture h23).
        const again = await book(dentist2.userId, NEXT_TUE, '16:00', 2).expect(
          409,
        );
        expect((again.body as { message: string }).message).toMatch(
          / 15:00 al .* 17:00\. Elige otro horario\.$/,
        );
      } finally {
        await as(
          api().delete(`/api/v1/schedule-blocks/${(created.body as Body).id}`),
          reception.token,
        ).expect(204);
      }
    });

    it('block at a location without hourCycle is 409 LOCATION_LOCALE_REQUIRED', async () => {
      const created = await block(reception.token, {
        providerId: dentist2.userId,
        start: local(NEXT_WED, '09:00'),
        end: local(NEXT_WED, '12:00'),
        kind: 'MEETING',
      }).expect(201);
      try {
        await withLocationSettings(
          { locale: REGIONAL_NEW_YORK_FIXTURE.locale, hourCycle: null },
          async () => {
            const rejected = await book(
              dentist2.userId,
              NEXT_WED,
              '10:00',
              2,
            ).expect(409);
            expect(rejected.body).toMatchObject({
              code: 'LOCATION_LOCALE_REQUIRED',
              locationId,
            });
            // Sin bloqueo no se pinta nada: se agenda (I4).
            await book(dentist2.userId, NEXT_THU, '10:00', 2).expect(201);
          },
        );
      } finally {
        await as(
          api().delete(`/api/v1/schedule-blocks/${(created.body as Body).id}`),
          reception.token,
        ).expect(204);
      }
    });
  });
});

// DX-252: el mismo análisis con el formateador real de la API en meses y días
// de una cifra (del martes 5 al viernes 8 de enero) y de dos (octubre/noviembre),
// sin esperar a que el calendario llegue a esas fechas.
describe('rango «día/mes» del 409 de vacaciones, a cualquier fecha (DX-252)', () => {
  const vacationFrom = (from: string, toExclusive: string) =>
    blockConflictMessage(
      {
        id: 'b',
        tenantId: 't',
        locationId: null,
        providerId: 'doc',
        start: new Date(local(from, '00:00')),
        end: new Date(local(toExclusive, '00:00')),
        kind: ScheduleBlockKind.VACATION,
        allowsBooking: false,
        note: 'Vacaciones',
        createdById: 'u',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      'America/Bogota',
      regionalFormat(REGIONAL_BOGOTA_FIXTURE),
    );

  it.each([
    ['2027-01-05', '2027-01-09', [5, 1, 8, 1]],
    ['2026-12-29', '2027-01-02', [29, 12, 1, 1]],
    ['2026-11-03', '2026-11-07', [3, 11, 6, 11]],
    ['2026-10-20', '2026-10-24', [20, 10, 23, 10]],
  ])('del %s al día anterior a %s', (from, toExclusive, expected) => {
    expect(vacationRange(vacationFrom(from, toExclusive))).toEqual(expected);
  });
});
