import { INestApplication } from '@nestjs/common';
import {
  ClinicRole,
  ExtraPermission,
  Prisma,
  PrismaClient,
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
} from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import {
  TIMING_FORBIDDEN_MESSAGE,
  TIMING_LOCATION_NOT_FOUND_MESSAGE,
  TIMING_OWN_ONLY_MESSAGE,
  TIMING_PERIOD_TOO_LONG_MESSAGE,
  type TimingReport,
} from '../src/modules/reports/application/use-cases/get-timing.use-case';
import type { InClinicView } from '../src/modules/appointments/application/use-cases/list-in-clinic.use-case';

/**
 * DX-275 · «Tiempos» por HTTP real: roles (ADMIN todo; DENTIST lo suyo;
 * recepción y asistente 403, también con FINANCIAL_REPORTS_VIEW), sedes
 * permitidas (DX-089), 404 de la sede de otra clínica, 400, CSV auditado y la
 * marca «sin tiempos» del panel «En clínica». Fechas FIJAS de lunes a jueves
 * en una sede de Caracas (UTC−4): nada depende del reloj. Las reglas finas,
 * p90 y el plan, en los int.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const TIMING = '/reports/timing';
const PERIOD = { from: '2026-03-02', to: '2026-03-06' };
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00.000-04:00`);
const plus = (d: Date, minutes: number) =>
  new Date(d.getTime() + minutes * 60_000);

describe('Reportes › Tiempos (DX-275)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let norte: string;
  let sur: string;
  let dentistId: string;
  let otherId: string;
  let receptionId: string;
  let onlySur: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};

  function get(path: string, query: object, token: string, clinic = a) {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }
  const message = (res: request.Response) =>
    (res.body as { message: unknown }).message;
  const report = async (query: object = {}, token = a.adminToken) =>
    (await get(TIMING, { ...PERIOD, ...query }, token).expect(200))
      .body as TimingReport;
  const auditEvents = (since: Date) =>
    raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, occurredAt: { gte: since } },
      select: { action: true, resourceType: true, metadata: true },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx275-a');
    b = await registerClinic(app, 'dx275-b');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
      if (role === ClinicRole.RECEPTION) receptionId = member.userId;
    }
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    sur = await seed.location('Sede Sur');
    otherId = await seed.provider('Dr. Otro');
    const patient = await seed.patient('Tiempos');
    await seed.providerSchedule({
      providerId: dentistId,
      locationId: norte,
      ranges: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 480,
        endMinute: 720,
      })),
    });
    const visit = async (
      providerId: string,
      locationId: string,
      day: string,
      time: string,
      marks: [number, number, number] | null,
    ) => {
      const start = local(day, time);
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId,
          providerId,
          patientId: patient,
          start,
          end: plus(start, 30),
          status: 'COMPLETED',
          ...(marks
            ? {
                arrivedAt: plus(start, marks[0]),
                seatedAt: plus(start, marks[1]),
                readyForCheckoutAt: plus(start, marks[2]),
              }
            : {}),
        },
      });
    };
    // Odontólogo: 3 medidas (esperas 5, 10 y 0) y una sin tiempos el jueves.
    await visit(dentistId, norte, '2026-03-02', '09:00', [-5, 5, 35]);
    await visit(dentistId, norte, '2026-03-03', '09:00', [0, 10, 40]);
    await visit(dentistId, norte, '2026-03-04', '09:00', [-10, -2, 28]);
    await visit(dentistId, norte, '2026-03-05', '09:00', null);
    // Otro profesional, en Sur: 2 medidas.
    await visit(otherId, sur, '2026-03-02', '10:00', [0, 3, 33]);
    await visit(otherId, sur, '2026-03-03', '10:00', [0, 7, 37]);
    onlySur = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [sur],
        tv: 0,
      })
    ).accessToken;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN: todo el equipo, por profesional, tipo y semana, con definiciones y umbrales (sin auditar: solo agregados)', async () => {
    const since = new Date();
    const r = await report();
    expect(r.scope).toBe('CLINIC');
    expect(r.totals).toMatchObject({
      completed: 6,
      measured: 5,
      withoutTimes: 1,
      incoherent: 0,
      // Esperas 5, 10, 0, 3, 7.
      waitAvgMinutes: 5,
      durationAvgMinutes: 30,
      plannedAvgMinutes: 30,
      durationVsPlannedPercent: 0,
    });
    expect(
      r.byProfessional.map((p) => [p.providerId, p.completed, p.withoutTimes]),
    ).toEqual([
      [otherId, 2, 0],
      [dentistId, 4, 1],
    ]);
    expect(r.byAppointmentType).toMatchObject([
      {
        appointmentTypeId: null,
        appointmentTypeName: 'Sin tipo de cita',
        exceedsPlanned: false,
      },
    ]);
    expect(r.byWeek.map((w) => w.weekStart)).toEqual(['2026-03-02']);
    // Por nombre: «Dr. Otro» antes que «Miembro DENTIST».
    expect(r.occupancy.professionals).toMatchObject([
      {
        providerId: otherId,
        hasSchedule: false,
        attendedMinutes: 60,
        occupancyPercent: null,
      },
      // 5 × 240 disponibles; 4 × 30 atendidos.
      {
        providerId: dentistId,
        availableMinutes: 1200,
        attendedMinutes: 120,
        occupancyPercent: 10,
      },
    ]);
    expect(r.definitions).toHaveLength(15);
    expect(r.thresholds).toEqual({
      maxWaitMinutes: 240,
      maxStartGapMinutes: 720,
      minDurationMinutes: 1,
      maxDurationMinutes: 480,
      overrunPercent: 20,
      overrunMinAppointments: 10,
    });
    expect(r.hasData).toBe(true);
    expect(await auditEvents(since)).toEqual([]);
  });

  it('DENTIST: solo lo suyo (scope OWN); pedir a otro profesional es 403', async () => {
    const r = await report({}, tokens.DENTIST);
    expect(r.scope).toBe('OWN');
    expect(r.filters.providerId).toBe(dentistId);
    expect(r.byProfessional.map((p) => p.providerId)).toEqual([dentistId]);
    expect(r.totals).toMatchObject({
      completed: 4,
      measured: 3,
      withoutTimes: 1,
    });
    expect(r.occupancy.professionals.map((p) => p.providerId)).toEqual([
      dentistId,
    ]);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([dentistId]);
    const denied = await get(
      TIMING,
      { ...PERIOD, providerId: otherId },
      tokens.DENTIST!,
    ).expect(403);
    expect(message(denied)).toBe(TIMING_OWN_ONLY_MESSAGE);
  });

  it('recepción y asistente → 403 (también el CSV); recepción con FINANCIAL_REPORTS_VIEW, también 403', async () => {
    for (const role of [ClinicRole.RECEPTION, ClinicRole.ASSISTANT]) {
      const r = await get(TIMING, PERIOD, tokens[role]!).expect(403);
      expect(message(r)).toBe(TIMING_FORBIDDEN_MESSAGE);
      await get(`${TIMING}.csv`, PERIOD, tokens[role]!).expect(403);
    }
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
    });
    try {
      await get(TIMING, PERIOD, tokens.RECEPTION!).expect(403);
    } finally {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [] },
      });
    }
  });

  it('CSV: mismas tablas, UTF-8 con BOM y un evento EXPORT en la auditoría; el DENTIST descarga lo suyo', async () => {
    const since = new Date();
    const res = await get(`${TIMING}.csv`, PERIOD, a.adminToken).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      'tiempos-2026-03-02-2026-03-06.csv',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.startsWith('\uFEFF"Tiempos de la agenda"')).toBe(true);
    expect(res.text).toContain('"Total",6,5,1,0,5,');
    const events = await auditEvents(since);
    expect(
      events.map((e) => [
        e.action,
        e.resourceType,
        (e.metadata as { reason?: string } | null)?.reason,
      ]),
    ).toEqual([['EXPORT', 'APPOINTMENT', 'TIMING_REPORT']]);
    const own = await get(`${TIMING}.csv`, PERIOD, tokens.DENTIST!).expect(200);
    expect(own.text).toContain('"Total",4,3,1,0,');
    expect(own.text).not.toContain('Dr. Otro');
  });

  it('restringido a una sede (DX-089): solo esa; otra de la clínica, 403; una de otra clínica, 404', async () => {
    const r = await report({}, onlySur);
    expect(r.options.locations.map((l) => l.id)).toEqual([sur]);
    expect(r.totals).toMatchObject({ completed: 2, measured: 2 });
    const denied = await get(
      TIMING,
      { ...PERIOD, locationId: norte },
      onlySur,
    ).expect(403);
    expect(message(denied)).toBe('No tienes acceso a esta sede.');
    const foreign = (
      await raw.location.findFirstOrThrow({ where: { tenantId: b.tenantId } })
    ).id;
    const res = await get(
      TIMING,
      { ...PERIOD, locationId: foreign },
      a.adminToken,
    ).expect(404);
    expect(message(res)).toBe(TIMING_LOCATION_NOT_FOUND_MESSAGE);
    const sede = await report({ locationId: norte });
    expect(sede.filters).toMatchObject({
      locationId: norte,
      locationName: 'Sede Norte',
    });
    expect(sede.totals.completed).toBe(4);
  });

  it('400: período de más de 12 meses, fecha inválida o filtro que no es UUID', async () => {
    const long = await get(
      TIMING,
      { from: '2026-01-01', to: '2027-01-01' },
      a.adminToken,
    ).expect(400);
    expect(message(long)).toBe(TIMING_PERIOD_TOO_LONG_MESSAGE);
    await get(
      TIMING,
      { from: '2026-02-30', to: '2026-03-01' },
      a.adminToken,
    ).expect(400);
    await get(TIMING, { ...PERIOD, providerId: 'nope' }, a.adminToken).expect(
      400,
    );
    await get(TIMING, { to: '2026-03-01' }, a.adminToken).expect(400);
  });

  it('la otra clínica no ve nada de A', async () => {
    const own = await get(TIMING, PERIOD, b.adminToken, b).expect(200);
    expect(own.body as TimingReport).toMatchObject({
      hasData: false,
      byProfessional: [],
    });
    const crossed = await get(
      TIMING,
      { ...PERIOD, providerId: dentistId },
      b.adminToken,
      b,
    ).expect(200);
    expect((crossed.body as TimingReport).totals.completed).toBe(0);
  });

  it('panel «En clínica»: la completada sin tiempos del jueves sale en completedWithoutTimes (también al DENTIST, que solo ve las suyas)', async () => {
    const panel = (token: string) =>
      request(app.getHttpServer())
        .get('/api/v1/appointments/in-clinic')
        .query({ date: '2026-03-05' })
        .set('X-Tenant-Host', a.host)
        .set('X-Location-Id', norte)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    const view = (await panel(tokens.RECEPTION!)).body as InClinicView;
    expect(view.completedWithoutTimes).toEqual([
      expect.objectContaining({
        providerId: dentistId,
        timingIssue: 'WITHOUT_TIMES',
        missingMarks: ['ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT'],
        patientLastName: 'Tiempos',
      }),
    ]);
    // Los campos de siempre siguen ahí.
    expect(view).toMatchObject({
      waiting: [],
      inChair: [],
      readyForCheckout: [],
    });
    const mine = (await panel(tokens.DENTIST!)).body as InClinicView;
    expect(mine.completedWithoutTimes).toHaveLength(1);
    const lunes = (
      await request(app.getHttpServer())
        .get('/api/v1/appointments/in-clinic')
        .query({ date: '2026-03-02' })
        .set('X-Tenant-Host', a.host)
        .set('X-Location-Id', norte)
        .set('Authorization', `Bearer ${tokens.RECEPTION!}`)
        .expect(200)
    ).body as InClinicView;
    expect(lunes.completedWithoutTimes).toEqual([]);
  });
});
