import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
  ClinicRole,
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
import { REPORTS_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/locations-comparison.controller';
import {
  CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE,
  CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE,
  type ChairOccupancyReport,
} from '../src/modules/reports/application/use-cases/get-chair-occupancy.use-case';

/**
 * DX-481 · «Ocupación por sillón» por HTTP real, sobre la BD. Lunes
 * 2026-10-19 y martes 2026-10-20 en America/Caracas (UTC−4 fijo):
 *  - Sede principal: horario lun–vie 9–13 y 15–19 (por la API), cierre de
 *    toda la sede el lunes 12–16 y el martes festivo recurrente → 360 min
 *    abiertos por sillón. Sillón 1 (atendida, inasistencia, cancelada y una
 *    en el festivo), Sillón 2 (reservada), un sillón desactivado con una
 *    atendida, otro desactivado sin citas, y una cita sin sillón.
 *  - Sede Norte: sin horario, un sillón con una atendida.
 * Además el miembro restringido (DX-089), los permisos, la validación, el
 * CSV auditado y el aislamiento entre clínicas.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MON = '2026-10-19';
const TUE = '2026-10-20';
const PERIOD = { from: MON, to: TUE };
/** Hora de pared de la sede (UTC−4 fijo) como instante. */
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-04:00`);

describe('GET /reports/chair-occupancy (DX-481)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  const chairs: Record<string, string> = {};
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let restrictedAdmin: string;

  const api = () => request(app.getHttpServer());
  const get = (
    path: string,
    query: object = PERIOD,
    token = a.adminToken,
    host = a.host,
  ) =>
    api()
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);

  const report = async (
    query: object = PERIOD,
    token = a.adminToken,
  ): Promise<ChairOccupancyReport> =>
    (await get('/reports/chair-occupancy', query, token).expect(200))
      .body as ChairOccupancyReport;

  const exportEvents = () =>
    raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        action: 'EXPORT',
        resourceType: 'APPOINTMENT',
        metadata: { path: ['reason'], equals: 'CHAIR_OCCUPANCY_REPORT' },
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'sillones-a');
    b = await registerClinic(app, 'sillones-b');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    await api()
      .put('/api/v1/locations/schedule')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        ranges: [1, 2, 3, 4, 5].flatMap((weekday) => [
          { weekday, startMinute: 540, endMinute: 780 },
          { weekday, startMinute: 900, endMinute: 1140 },
        ]),
      })
      .expect(200);
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    const dentist = await seed.dentist();
    const patient = await seed.patient('Sillones');

    const chair = async (
      key: string,
      locationId: string,
      name: string,
      sortOrder: number,
      active = true,
    ) => {
      chairs[key] = (
        await raw.chair.create({
          data: { tenantId: a.tenantId, locationId, name, sortOrder, active },
          select: { id: true },
        })
      ).id;
    };
    await chair('s1', principal, 'Sillón 1', 0);
    await chair('s2', principal, 'Sillón 2', 1);
    await chair('old', principal, 'Sillón prestado', 2, false);
    await chair('unused', principal, 'Sillón viejo', 3, false);
    await chair('n1', norte, 'Sillón A', 0);

    const appt = (
      locationId: string,
      chairKey: string | null,
      day: string,
      from: string,
      to: string,
      status: AppointmentStatus,
    ) =>
      raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId,
          patientId: patient,
          providerId: dentist.userId,
          chairId: chairKey === null ? null : chairs[chairKey],
          start: local(day, from),
          end: local(day, to),
          status,
          createdAt: local('2026-10-01', '09:00'),
        },
      });
    await appt(principal, 's1', MON, '09:00', '10:00', 'COMPLETED');
    await appt(principal, 's1', MON, '10:00', '10:30', 'NO_SHOW');
    await appt(principal, 's1', MON, '10:30', '11:00', 'CANCELLED');
    await appt(principal, 's2', MON, '11:00', '12:00', 'SCHEDULED');
    await appt(principal, 'old', MON, '16:00', '16:30', 'COMPLETED');
    await appt(principal, null, MON, '17:00', '17:30', 'COMPLETED');
    await appt(principal, 's1', TUE, '09:00', '10:00', 'COMPLETED');
    await appt(norte, 'n1', MON, '13:00', '14:00', 'COMPLETED');

    // Cierre de toda la sede (sin profesional, no admite citas) y uno que sí
    // admite citas (no cierra).
    for (const allowsBooking of [false, true]) {
      await raw.scheduleBlock.create({
        data: {
          tenantId: a.tenantId,
          locationId: principal,
          start: local(MON, allowsBooking ? '09:00' : '12:00'),
          end: local(MON, allowsBooking ? '11:00' : '16:00'),
          kind: 'MEETING',
          allowsBooking,
        },
      });
    }
    // El martes, festivo de cada año; uno retirado no cuenta.
    await raw.locationHoliday.create({
      data: {
        tenantId: a.tenantId,
        locationId: principal,
        date: new Date('2020-10-20'),
        name: 'Festivo local',
        recurring: true,
      },
    });
    await raw.locationHoliday.create({
      data: {
        tenantId: a.tenantId,
        locationId: principal,
        date: new Date(`${MON}`),
        name: 'Retirado',
        deletedAt: new Date(),
      },
    });

    // DX-089 no deja restringir a un ADMIN (409), pero el informe respeta el
    // claim `loc` igual: se firma un token de ADMIN con la sede principal.
    restrictedAdmin = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [principal],
        tv: 0,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('calcula abiertos, reservados, atendidos, inasistencias y «Sin sillón» por sillón', async () => {
    const r = await report();
    expect(r).toMatchObject({
      from: MON,
      to: TUE,
      locationId: null,
      restrictedToLocations: false,
    });
    expect(r.locations.map((l) => l.locationId)).toEqual([principal, norte]);
    const [main, other] = r.locations;
    expect(main).toMatchObject({
      timeZone: 'America/Caracas',
      hasSchedule: true,
      holidayDays: 1,
      // 480 del lunes − 120 del cierre; el martes es festivo.
      openMinutesPerChair: 360,
    });
    expect(main.chairs.map((c) => [c.chairName, c.active])).toEqual([
      ['Sillón 1', true],
      ['Sillón 2', true],
      ['Sillón prestado', false],
    ]);
    expect(main.chairs[0]).toMatchObject({
      chairId: chairs.s1,
      openMinutes: 360,
      reservedMinutes: 90,
      attendedMinutes: 60,
      noShowMinutes: 30,
      reservedAppointments: 3,
      attendedAppointments: 2,
      noShowAppointments: 1,
      reservedRate: 0.25,
      attendedRate: 0.1667,
    });
    expect(main.chairs[1]).toMatchObject({
      reservedMinutes: 60,
      attendedMinutes: 0,
    });
    expect(main.noChair).toMatchObject({
      openMinutes: null,
      reservedMinutes: 30,
      attendedMinutes: 30,
      reservedRate: null,
    });
    expect(main.totals).toMatchObject({
      openMinutes: 1080,
      reservedMinutes: 180,
      attendedMinutes: 90,
      noShowMinutes: 30,
      reservedRate: 0.1667,
      attendedRate: 0.0833,
    });
    expect(other).toMatchObject({
      locationName: 'Sede Norte',
      hasSchedule: false,
      openMinutesPerChair: null,
      noChair: null,
      totals: {
        openMinutes: null,
        reservedMinutes: 60,
        attendedMinutes: 60,
        reservedRate: null,
      },
    });
  });

  describe('sedes (DX-089)', () => {
    it('un miembro restringido solo ve sus sedes', async () => {
      const r = await report(PERIOD, restrictedAdmin);
      expect(r.restrictedToLocations).toBe(true);
      expect(r.locations.map((l) => l.locationId)).toEqual([principal]);
    });

    it('ADMIN puede acotar a una sede', async () => {
      const r = await report({ ...PERIOD, locationId: norte });
      expect(r.locationId).toBe(norte);
      expect(r.locations.map((l) => l.locationId)).toEqual([norte]);
    });

    it('un miembro restringido no puede pedir una sede que no es suya (403), ni en el CSV', async () => {
      for (const path of [
        '/reports/chair-occupancy',
        '/reports/chair-occupancy.csv',
      ]) {
        const res = await get(
          path,
          { ...PERIOD, locationId: norte },
          restrictedAdmin,
        ).expect(403);
        expect((res.body as { message: string }).message).toBe(
          'No tienes acceso a esta sede.',
        );
      }
    });

    it('una sede de otra clínica es el mismo 403', async () => {
      await get(
        '/reports/chair-occupancy',
        { ...PERIOD, locationId: principal },
        b.adminToken,
        b.host,
      ).expect(403);
    });
  });

  describe('permisos', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
      '%s recibe 403 en español en el informe y en el CSV (sin auditoría)',
      async (role) => {
        const events = await exportEvents();
        for (const path of [
          '/reports/chair-occupancy',
          '/reports/chair-occupancy.csv',
        ]) {
          const res = await get(path, PERIOD, tokens[role]).expect(403);
          expect((res.body as { message: string }).message).toBe(
            REPORTS_FORBIDDEN_MESSAGE,
          );
        }
        await expect(exportEvents()).resolves.toBe(events);
      },
    );

    it('sin sesión, 401', async () => {
      await api()
        .get('/api/v1/reports/chair-occupancy')
        .query(PERIOD)
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('validación (400 en español)', () => {
    it.each([
      [
        { from: '2026-10-31', to: '2026-10-01' },
        CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE,
      ],
      [
        { from: '2025-01-01', to: '2026-01-02' },
        CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE,
      ],
    ])('%o', async (query, message) => {
      const res = await get('/reports/chair-occupancy', query).expect(400);
      expect((res.body as { message: string }).message).toBe(message);
    });

    it('fechas e ids mal formados', async () => {
      await get('/reports/chair-occupancy', { from: 'ayer', to: TUE }).expect(
        400,
      );
      const res = await get('/reports/chair-occupancy', {
        ...PERIOD,
        locationId: 'no-es-un-uuid',
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'locationId debe ser un UUID.',
      );
    });
  });

  describe('CSV', () => {
    it('con los filtros activos y la fórmula, sin pacientes, sin caché y auditado (EXPORT)', async () => {
      const events = await exportEvents();
      const res = await get(
        '/reports/chair-occupancy.csv',
        PERIOD,
        restrictedAdmin,
      ).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="ocupacion-sillones-${MON}-${TUE}.csv"`,
      );
      const lines = res.text.trim().split('\r\n');
      // UTF-8 con BOM (trim() se lo come: se mira en el texto).
      expect(res.text.startsWith('﻿"Ocupación por sillón"\r\n')).toBe(true);
      expect(lines).toContain(`"Período","${MON} a ${TUE}"`);
      expect(lines).toContain('"Sede","Todas tus sedes"');
      expect(lines.find((l) => l.startsWith('"Cómo se calcula"'))).toContain(
        'Ocupación = reservados ÷ abiertos',
      );
      const principalName = (
        await raw.location.findUniqueOrThrow({
          where: { id: principal },
          select: { name: true },
        })
      ).name;
      expect(lines).toContain(
        `"${principalName}","Sillón","Sillón 1","Sí",360,90,25.0,60,16.7,30,3,2,1`,
      );
      expect(lines).toContain(
        `"${principalName}","Sin sillón","","Sí",,30,,30,,0,1,1,0`,
      );
      expect(lines).toContain(
        `"${principalName}","Total sede","","Sí",1080,180,16.7,90,8.3,30,5,3,1`,
      );
      // Solo las sedes del usuario y ningún paciente.
      expect(res.text).not.toMatch(/Sede Norte|Sillones|Paciente/);
      await expect(exportEvents()).resolves.toBe(events + 1);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B no ve sedes, sillones ni citas de A', async () => {
      const res = await get(
        '/reports/chair-occupancy',
        PERIOD,
        b.adminToken,
        b.host,
      ).expect(200);
      const r = res.body as ChairOccupancyReport;
      const ids = JSON.stringify(r);
      expect(ids).not.toContain(principal);
      expect(ids).not.toContain(chairs.s1);
      for (const l of r.locations) {
        expect(l.chairs).toEqual([]);
        expect(l.totals.reservedMinutes).toBe(0);
      }
    });
  });
});
