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
import {
  scheduledProductionSeeding,
  type ScheduledClinic,
} from './support/scheduled-production-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import {
  SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE,
  SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE,
  SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE,
  SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
  type ScheduledProductionReport,
  type ScheduledProductionUnlinked,
} from '../src/modules/reports/application/use-cases/get-scheduled-production.use-case';
import { FORECAST_FORMULA } from '../src/modules/reports/domain/scheduled-production';

/**
 * DX-567 · «Producción agendada y previsión del mes» por HTTP real. Clínica A
 * (Caracas, catálogo en USD) con dos sedes y octubre de 2026:
 *  - de la Dra. (DENTIST) en la principal: una cita con 40 + 60, una
 *    cancelada con 300 y una sin tratamiento ligado;
 *  - del ADMIN en la Norte: una cita con 500.
 * Las cifras finas (doble vínculo, moneda, previsión, zonas, rendimiento)
 * están en el int; aquí, roles, 403, 400 y la auditoría de la lista.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const ROUTE = '/reports/scheduled-production';
const UNLINKED = `${ROUTE}/unlinked`;

const { plan, appointment } = scheduledProductionSeeding(raw);

describe('GET /reports/scheduled-production (DX-567)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let dentistId: string;
  let receptionId: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let onlyNorte: string;

  function get(path: string, query: object, token: string) {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${token}`);
  }

  const report = async (
    query: object = {},
    token = a.adminToken,
  ): Promise<ScheduledProductionReport> =>
    (await get(ROUTE, { ...OCTOBER, ...query }, token).expect(200))
      .body as ScheduledProductionReport;

  const message = (res: request.Response) =>
    (res.body as { message: unknown }).message;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'agendado-a');
    b = await registerClinic(app, 'agendado-b');
    await raw.tenant.update({
      where: { id: a.tenantId },
      data: { catalogCurrency: 'USD' },
    });
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    const patientId = await seed.patient('Agendado');

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
    const clinic: ScheduledClinic = {
      tenantId: a.tenantId,
      seed,
      main: principal,
      norte,
      patientId,
      dentist: { id: '', userId: dentistId },
      otherDentistId: a.adminUserId,
    };
    const [i40, i60] = await plan(clinic, [{ price: 40 }, { price: 60 }]);
    await appointment(clinic, '2026-10-10', { items: [i40, i60] });
    const [i300] = await plan(clinic, [{ price: 300 }]);
    await appointment(clinic, '2026-10-12', {
      items: [i300],
      status: 'CANCELLED',
    });
    await appointment(clinic, '2026-10-14');
    const [i500] = await plan(clinic, [{ price: 500 }]);
    await appointment(clinic, '2026-10-15', {
      items: [i500],
      locationId: norte,
      providerId: a.adminUserId,
    });

    onlyNorte = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [norte],
        tv: 0,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN: toda la clínica por día y profesional, con previsión, definiciones y opciones (sin auditar)', async () => {
    const before = new Date();
    const r = await report();
    expect(r).toMatchObject({
      period: OCTOBER,
      currency: 'USD',
      scope: 'CLINIC',
      restrictedToLocations: false,
      filters: { locationId: null, providerId: null },
      totals: {
        scheduledAmount: 600,
        appointments: 3,
        appointmentsWithoutItems: 1,
      },
      withoutRate: { appointments: 0, items: 0 },
      unattributedDone: 0,
      warnings: [],
    });
    expect(r.byDay).toHaveLength(31);
    expect(r.byDay.find((d) => d.date === '2026-10-10')).toEqual({
      date: '2026-10-10',
      scheduledAmount: 100,
      appointments: 1,
      appointmentsWithoutItems: 0,
    });
    expect(r.byDay.find((d) => d.date === '2026-10-12')).toMatchObject({
      scheduledAmount: 0,
      appointments: 0,
    });
    expect(
      r.byProfessional.map((p) => [p.professionalId, p.scheduledAmount]),
    ).toEqual([
      [a.adminUserId, 500],
      [dentistId, 100],
    ]);
    expect(r.byDayAndProfessional).toEqual([
      {
        date: '2026-10-10',
        professionalId: dentistId,
        scheduledAmount: 100,
        appointments: 1,
      },
      {
        date: '2026-10-14',
        professionalId: dentistId,
        scheduledAmount: 0,
        appointments: 1,
      },
      {
        date: '2026-10-15',
        professionalId: a.adminUserId,
        scheduledAmount: 500,
        appointments: 1,
      },
    ]);
    // La previsión es del mes en curso (reloj real): solo su forma.
    expect(r.forecast.month).toMatch(/^\d{4}-\d{2}$/);
    expect(r.forecast.itemsWithoutRate).toBe(0);
    for (const amount of [
      r.forecast.producedToDate,
      r.forecast.scheduledPending,
      r.forecast.forecast,
    ]) {
      expect(typeof amount).toBe('number');
    }
    const forecast = r.definitions.find((d) => d.key === 'FORECAST');
    expect(forecast?.howItIsCalculated[0]).toBe(`${FORECAST_FORMULA}.`);
    expect(r.options.locations.map((l) => l.id)).toEqual([principal, norte]);
    // El agregado no lleva pacientes: no se audita.
    const events = await raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        occurredAt: { gte: before },
        resourceType: 'APPOINTMENT',
      },
    });
    expect(events).toBe(0);
  });

  it('DENTIST: solo lo suyo (OWN); pedir lo de otro es 403', async () => {
    const r = await report({}, tokens.DENTIST);
    expect(r.scope).toBe('OWN');
    expect(r.filters.providerId).toBe(dentistId);
    expect(r.totals).toEqual({
      scheduledAmount: 100,
      appointments: 2,
      appointmentsWithoutItems: 1,
    });
    expect(r.byProfessional.map((p) => p.professionalId)).toEqual([dentistId]);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([dentistId]);
    for (const path of [ROUTE, UNLINKED]) {
      const denied = await get(
        path,
        { ...OCTOBER, providerId: a.adminUserId },
        tokens.DENTIST!,
      ).expect(403);
      expect(message(denied)).toBe(SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE);
    }
  });

  it('asistente y recepción sin permiso → 403; con FINANCIAL_REPORTS_VIEW, la clínica', async () => {
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
      for (const path of [ROUTE, UNLINKED]) {
        const res = await get(path, OCTOBER, tokens[role]!).expect(403);
        expect(message(res)).toBe(SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE);
      }
    }
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
    });
    try {
      const r = await report({ providerId: a.adminUserId }, tokens.RECEPTION);
      expect(r.scope).toBe('CLINIC');
      expect(r.totals.scheduledAmount).toBe(500);
      const list = (await get(UNLINKED, OCTOBER, tokens.RECEPTION!).expect(200))
        .body as ScheduledProductionUnlinked;
      expect(list.total).toBe(1);
    } finally {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [] },
      });
    }
  });

  it('restringido a una sede (DX-089): solo lo de allí; otra sede, 403', async () => {
    const r = await report({}, onlyNorte);
    expect(r.restrictedToLocations).toBe(true);
    expect(r.totals).toMatchObject({ scheduledAmount: 500, appointments: 1 });
    expect(r.options.locations.map((l) => l.id)).toEqual([norte]);
    for (const path of [ROUTE, UNLINKED]) {
      const res = await get(
        path,
        { ...OCTOBER, locationId: principal },
        onlyNorte,
      ).expect(403);
      expect(message(res)).toBe('No tienes acceso a esta sede.');
    }
    const main = await report({ locationId: principal });
    expect(main.totals.scheduledAmount).toBe(100);
  });

  it('400: más de 62 días, fechas al revés o mal formadas, página fuera de rango', async () => {
    const long = await get(
      ROUTE,
      { from: '2026-10-01', to: '2026-12-02' },
      a.adminToken,
    ).expect(400);
    expect(message(long)).toBe(SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE);
    const reversed = await get(
      ROUTE,
      { from: '2026-10-31', to: '2026-10-01' },
      a.adminToken,
    ).expect(400);
    expect(message(reversed)).toBe(SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE);
    await get(
      ROUTE,
      { from: '31/10/2026', to: '2026-10-31' },
      a.adminToken,
    ).expect(400);
    await get(ROUTE, { ...OCTOBER, providerId: 'nope' }, a.adminToken).expect(
      400,
    );
    await get(UNLINKED, { ...OCTOBER, pageSize: 101 }, a.adminToken).expect(
      400,
    );
    await get(UNLINKED, { ...OCTOBER, page: 0 }, a.adminToken).expect(400);
  });

  it('lista sin tratamiento: con paciente, auditada como VIEW de APPOINTMENT', async () => {
    const before = new Date();
    const res = await get(UNLINKED, OCTOBER, a.adminToken).expect(200);
    const body = res.body as ScheduledProductionUnlinked;
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.items[0]).toMatchObject({
      status: 'SCHEDULED',
      patientName: 'Paciente Agendado',
      professionalId: dentistId,
      locationId: principal,
      locationName: expect.any(String) as unknown,
      timeZone: 'America/Caracas',
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        resourceType: 'APPOINTMENT',
        occurredAt: { gte: before },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'VIEW' });
    expect(events[0].metadata).toMatchObject({
      reason: 'SCHEDULED_PRODUCTION_REPORT',
    });
  });

  it('otra clínica no ve nada de A', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1${ROUTE}`)
      .query(OCTOBER)
      .set('X-Tenant-Host', b.host)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    expect((res.body as ScheduledProductionReport).totals).toMatchObject({
      appointments: 0,
      appointmentsWithoutItems: 0,
    });
  });
});
