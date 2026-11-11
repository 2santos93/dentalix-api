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
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { REPORTS_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/locations-comparison.controller';
import {
  RECOVERED_SLOTS_INVALID_PERIOD_MESSAGE,
  RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE,
  type RecoveredSlotsReport,
} from '../src/modules/reports/application/use-cases/get-recovered-slots.use-case';

/**
 * DX-436 · «Huecos recuperados» por HTTP real: la recepción cancela una cita
 * de la semana que viene y agenda en su hueco a un pendiente de la lista
 * («Agendar aquí»); el informe lo cuenta como 1 liberado, 1 rellenado y 1 por
 * la lista. Además una segunda sede (Norte) con un hueco rellenado sembrado
 * por `raw`, para el miembro restringido (DX-089), y los permisos, la
 * validación y el CSV auditado.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const CARACAS_MS = 4 * 60 * 60 * 1000;

/** YYYY-MM-DD (zona de la sede) del primer martes a 7 días o más: siempre futuro. */
function nextTuesday(): string {
  let t = Date.now() - CARACAS_MS + 7 * DAY_MS;
  while (new Date(t).getUTCDay() !== 2) t += DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
/** Hora de pared de la sede (UTC−4 fijo) como instante. */
function local(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00-04:00`);
}

const TUE = nextTuesday();
const PERIOD = { from: TUE, to: TUE };

interface Body {
  id: string;
  [key: string]: unknown;
}

describe('GET /reports/recovered-slots (DX-436)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let dentistId: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let restrictedAdmin: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = a.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  const get = (
    path: string,
    query: object = PERIOD,
    token = a.adminToken,
    host = a.host,
  ) => as(api().get(`/api/v1${path}`).query(query), token, host);

  const report = async (
    query: object = PERIOD,
    token = a.adminToken,
  ): Promise<RecoveredSlotsReport> =>
    (await get('/reports/recovered-slots', query, token).expect(200))
      .body as RecoveredSlotsReport;

  const exportEvents = () =>
    raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        action: 'EXPORT',
        resourceType: 'APPOINTMENT',
        metadata: { path: ['reason'], equals: 'RECOVERED_SLOTS_REPORT' },
      },
    });

  async function createPatient(doc: string, firstName: string) {
    const res = await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        firstName,
        lastName: 'Huecos',
        docType: 'NATIONAL_ID',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as Body).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'huecos-a');
    b = await registerClinic(app, 'huecos-b');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    // Horario conocido de la sede: lun–vie 9–13 y 15–19.
    await as(api().put('/api/v1/locations/schedule'), a.adminToken)
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

    // Sede Norte: un hueco de las 10:00 cancelado a las 7:00 y sin rellenar
    // (la otra cita de la doctora allí es a las 15:00).
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    const [n1, n2] = [
      await seed.patient('Norte1'),
      await seed.patient('Norte2'),
    ];
    const start = local(TUE, '10:00');
    const end = local(TUE, '10:30');
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: norte,
        patientId: n1,
        providerId: dentistId,
        start,
        end,
        status: 'CANCELLED',
        createdAt: local(TUE, '06:00'),
        cancelledAt: local(TUE, '07:00'),
        cancelledByKind: 'PATIENT_LINK',
        noticeMinutes: 180,
        lateCancellation: true,
      },
    });
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: norte,
        patientId: n2,
        providerId: dentistId,
        start: local(TUE, '15:00'),
        end: local(TUE, '15:30'),
        createdAt: local(TUE, '06:00'),
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

  it('cancelar → agendar un pendiente en el hueco → el informe muestra 1 recuperado por la lista', async () => {
    const before = await report(PERIOD, restrictedAdmin);
    expect(before.totals.freedSlots).toBe(0);

    const ana = await createPatient('436001', 'Ana');
    const berta = await createPatient('436002', 'Berta');
    const start = local(TUE, '10:00').toISOString();
    const booked = await as(
      api().post('/api/v1/appointments'),
      tokens.RECEPTION!,
    )
      .send({
        patientId: ana,
        providerId: dentistId,
        start,
        end: local(TUE, '10:30').toISOString(),
      })
      .expect(201);
    await as(
      api().patch(`/api/v1/appointments/${(booked.body as Body).id}`),
      tokens.RECEPTION!,
    )
      .send({ status: 'CANCELLED', ...STAFF_CANCELLATION })
      .expect(200);
    const entry = await as(api().post('/api/v1/waitlist'), tokens.RECEPTION!)
      .send({ patientId: berta, locationId: principal, durationMinutes: 30 })
      .expect(201);
    await as(
      api().post(`/api/v1/waitlist/${(entry.body as Body).id}/schedule`),
      tokens.RECEPTION!,
    )
      .send({ providerId: dentistId, start })
      .expect(201);

    const r = await report(PERIOD, restrictedAdmin);
    expect(r).toMatchObject({
      from: TUE,
      to: TUE,
      locationId: null,
      providerId: null,
      restrictedToLocations: true,
    });
    expect(r.totals).toMatchObject({
      freedSlots: 1,
      freedMinutes: 30,
      filledSlots: 1,
      partiallyFilledSlots: 0,
      recoveredMinutes: 30,
      filledByListSlots: 1,
      fillRate: 1,
      filledWithin30MinRate: 1,
      filledWithin24hRate: 1,
      cancellationRate: 0.5,
      unvaluedRecoveredSlots: 1,
      recoveredValue: [],
    });
    expect(r.totals.meanMinutesToFill).toBeLessThan(30);
    expect(r.byProvider).toEqual([
      expect.objectContaining({
        providerId: dentistId,
        providerName: 'Miembro DENTIST',
        freedSlots: 1,
      }),
    ]);
    expect(r.byWeek).toHaveLength(1);
  });

  describe('sedes (DX-089)', () => {
    it('ADMIN ve todas sus sedes: también el hueco de la Norte', async () => {
      const r = await report();
      expect(r.restrictedToLocations).toBe(false);
      expect(r.totals).toMatchObject({ freedSlots: 2, filledSlots: 1 });
      const onlyNorte = await report({ ...PERIOD, locationId: norte });
      expect(onlyNorte.totals).toMatchObject({
        freedSlots: 1,
        filledSlots: 0,
      });
    });

    it('un miembro restringido no puede pedir una sede que no es suya (403)', async () => {
      const res = await get(
        '/reports/recovered-slots',
        { ...PERIOD, locationId: norte },
        restrictedAdmin,
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'No tienes acceso a esta sede.',
      );
    });

    it('una sede de otra clínica es el mismo 403', async () => {
      await get(
        '/reports/recovered-slots',
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
          '/reports/recovered-slots',
          '/reports/recovered-slots.csv',
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
        .get('/api/v1/reports/recovered-slots')
        .query(PERIOD)
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('validación (400 en español)', () => {
    it.each([
      [
        { from: '2026-10-31', to: '2026-10-01' },
        RECOVERED_SLOTS_INVALID_PERIOD_MESSAGE,
      ],
      [
        { from: '2025-01-01', to: '2026-01-02' },
        RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE,
      ],
    ])('%o', async (query, message) => {
      const res = await get('/reports/recovered-slots', query).expect(400);
      expect((res.body as { message: string }).message).toBe(message);
    });

    it('fechas y ids mal formados', async () => {
      await get('/reports/recovered-slots', { from: 'ayer', to: TUE }).expect(
        400,
      );
      const res = await get('/reports/recovered-slots', {
        ...PERIOD,
        providerId: 'no-es-un-uuid',
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'providerId debe ser un UUID.',
      );
    });
  });

  describe('CSV', () => {
    it('solo agregados, protegido, sin caché y auditado (EXPORT)', async () => {
      const events = await exportEvents();
      const res = await get('/reports/recovered-slots.csv').expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="huecos-recuperados-${TUE}-${TUE}.csv"`,
      );
      const text = res.text;
      expect(text.startsWith('﻿"Huecos recuperados"')).toBe(true);
      const lines = text.trim().split('\r\n');
      expect(lines.find((l) => l.startsWith('"Total",'))).toMatch(
        /^"Total","",2,60,1,0,30,1,50\.0,50\.0,50\.0,/,
      );
      // Ni pacientes ni citas: solo el nombre del profesional del personal.
      expect(text).not.toMatch(/Ana|Berta|Norte1|Norte2/);
      await expect(exportEvents()).resolves.toBe(events + 1);
      const [event] = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          action: 'EXPORT',
          resourceType: 'APPOINTMENT',
        },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      });
      expect(event).toMatchObject({
        actorUserId: a.adminUserId,
        actorRole: 'ADMIN',
        patientId: null,
      });
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B no ve nada de A, ni con el profesional de A', async () => {
      const res = await get(
        '/reports/recovered-slots',
        { ...PERIOD, providerId: dentistId },
        b.adminToken,
        b.host,
      ).expect(200);
      const r = res.body as RecoveredSlotsReport;
      expect(r.totals.freedSlots).toBe(0);
      expect(r.byProvider).toEqual([]);
    });
  });
});
