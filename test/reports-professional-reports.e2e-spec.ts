import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
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
  PRODUCTIVITY_FORBIDDEN_MESSAGE,
  PRODUCTIVITY_OWN_ONLY_MESSAGE,
  type ProfessionalProductivity,
} from '../src/modules/reports/application/use-cases/get-professional-productivity.use-case';
import {
  NO_SHOWS_FORBIDDEN_MESSAGE,
  NO_SHOWS_OWN_ONLY_MESSAGE,
  type NoShowsReport,
} from '../src/modules/reports/application/use-cases/get-no-shows.use-case';
import { NO_SHOWS_CSV_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/professional-reports.controller';
import { PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE } from '../src/modules/reports/application/professional-report-scope';
import { RECEIVABLES_EXPORT_FORBIDDEN_MESSAGE } from '../src/modules/receivables/presentation/receivables.controller';

/**
 * DX-304 · «Profesionales», «Inasistencias» y el CSV de «Cartera» por HTTP
 * real. Clínica A con la sede principal y la Norte (Caracas), noviembre de
 * 2026 (fechas fijas, nada depende del reloj):
 *  - la Dra. (DENTIST): 100 USD realizados en la principal, una atendida y
 *    una «No asistió» allí;
 *  - el ADMIN: 40 USD realizados en la Norte y una cancelación tardía allí.
 * Las cifras finas (zonas, cobrado, retirados, RLS) están en el int; aquí,
 * roles, sedes (DX-089), 400, CSV y auditoría.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };
const PRODUCTIVITY = '/reports/professional-productivity';
const NO_SHOWS = '/reports/no-shows';

describe('Reportes de profesionales e inasistencias (DX-304)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let dentistId: string;
  let receptionId: string;
  let onlyNorte: string;
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

  const productivity = async (query: object = {}, token = a.adminToken) =>
    (await get(PRODUCTIVITY, { ...NOVEMBER, ...query }, token).expect(200))
      .body as ProfessionalProductivity;

  const noShows = async (query: object = {}, token = a.adminToken) =>
    (await get(NO_SHOWS, { ...NOVEMBER, ...query }, token).expect(200))
      .body as NoShowsReport;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx304-a');
    b = await registerClinic(app, 'dx304-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    const patientId = await seed.patient('Inasistente');

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
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'DX304',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    const done = async (userId: string, locationId: string, price: number) => {
      const membership = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: a.tenantId, userId },
      });
      const plan = await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId,
          currency: 'USD',
          status: 'ACCEPTED',
        },
      });
      await raw.treatmentPlanItem.create({
        data: {
          tenantId: a.tenantId,
          planId: plan.id,
          toothNumber: '16',
          catalogItemId: catalog.id,
          price,
          status: 'DONE',
          performedById: userId,
          performedByMembershipId: membership.id,
          performedLocationId: locationId,
          completedAt: new Date('2026-11-05T15:00:00Z'),
        },
      });
    };
    await done(dentistId, principal, 100);
    await done(a.adminUserId, norte, 40);
    const appointment = (
      providerId: string,
      locationId: string,
      start: string,
      status: AppointmentStatus,
      late = false,
    ) =>
      raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId,
          patientId,
          providerId,
          start: new Date(start),
          end: new Date(new Date(start).getTime() + 30 * 60_000),
          status,
          ...(late
            ? {
                cancelledAt: new Date(new Date(start).getTime() - 3_600_000),
                cancelledByKind: 'PATIENT_LINK' as const,
                noticeMinutes: 60,
                lateCancellation: true,
              }
            : {}),
        },
      });
    await appointment(
      dentistId,
      principal,
      '2026-11-05T15:00:00Z',
      'COMPLETED',
    );
    await appointment(dentistId, principal, '2026-11-06T15:00:00Z', 'NO_SHOW');
    await appointment(
      a.adminUserId,
      norte,
      '2026-11-07T15:00:00Z',
      'CANCELLED',
      true,
    );

    onlyNorte = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [norte],
        tv: 0,
      })
    ).accessToken;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN: una fila por profesional y totales por moneda (sin auditar: no lleva pacientes)', async () => {
    const before = new Date();
    const r = await productivity();
    expect(r.scope).toBe('CLINIC');
    expect(
      r.rows.map((row) => [row.professionalId, row.production, row.noShowRate]),
    ).toEqual(
      expect.arrayContaining([
        [dentistId, [{ currency: 'USD', count: 1, net: 100 }], 50],
        [a.adminUserId, [{ currency: 'USD', count: 1, net: 40 }], 0],
      ]),
    );
    expect(r.totals.production).toEqual([
      { currency: 'USD', count: 2, net: 140 },
    ]);
    expect(r.definitions.map((d) => d.key)).toContain('noShowRate');
    const events = await raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        occurredAt: { gte: before },
      },
    });
    expect(events).toBe(0);
  });

  it('DENTIST: solo su fila y sus citas; pedir a otro es 403', async () => {
    const r = await productivity({}, tokens.DENTIST);
    expect(r.scope).toBe('OWN');
    expect(r.rows.map((row) => row.professionalId)).toEqual([dentistId]);
    expect(r.totals.production).toEqual([
      { currency: 'USD', count: 1, net: 100 },
    ]);
    expect(JSON.stringify(r)).not.toContain(a.adminUserId);
    const own = await noShows({}, tokens.DENTIST);
    expect(own.items.map((i) => i.professionalId)).toEqual([dentistId]);
    expect(own.summary).toMatchObject({ noShows: 1, lateCancellations: 0 });

    const denied = await get(
      PRODUCTIVITY,
      { ...NOVEMBER, professionalId: a.adminUserId },
      tokens.DENTIST!,
    ).expect(403);
    expect(message(denied)).toBe(PRODUCTIVITY_OWN_ONLY_MESSAGE);
    const deniedList = await get(
      NO_SHOWS,
      { ...NOVEMBER, professionalId: a.adminUserId },
      tokens.DENTIST!,
    ).expect(403);
    expect(message(deniedList)).toBe(NO_SHOWS_OWN_ONLY_MESSAGE);
  });

  it('recepción y asistente → 403; con FINANCIAL_REPORTS_VIEW, la clínica', async () => {
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
      const p = await get(PRODUCTIVITY, NOVEMBER, tokens[role]!).expect(403);
      expect(message(p)).toBe(PRODUCTIVITY_FORBIDDEN_MESSAGE);
      const n = await get(NO_SHOWS, NOVEMBER, tokens[role]!).expect(403);
      expect(message(n)).toBe(NO_SHOWS_FORBIDDEN_MESSAGE);
      await get(`${PRODUCTIVITY}.csv`, NOVEMBER, tokens[role]!).expect(403);
    }
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
    });
    try {
      const r = await productivity({}, tokens.RECEPTION);
      expect(r.scope).toBe('CLINIC');
      expect(r.rows).toHaveLength(2);
      // El CSV de inasistencias (nombres de pacientes) sigue siendo de ADMIN.
      const csv = await get(
        `${NO_SHOWS}.csv`,
        NOVEMBER,
        tokens.RECEPTION!,
      ).expect(403);
      expect(message(csv)).toBe(NO_SHOWS_CSV_FORBIDDEN_MESSAGE);
    } finally {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [] },
      });
    }
  });

  it('restringido a una sede (DX-089): solo lo de allí; otra sede, 403', async () => {
    const r = await productivity({}, onlyNorte);
    expect(r.options.locations.map((l) => l.id)).toEqual([norte]);
    expect(r.rows.map((row) => row.professionalId)).toEqual([a.adminUserId]);
    const list = await noShows({}, onlyNorte);
    expect(list.items.map((i) => i.locationId)).toEqual([norte]);
    for (const path of [PRODUCTIVITY, NO_SHOWS, `${PRODUCTIVITY}.csv`]) {
      const res = await get(
        path,
        { ...NOVEMBER, locationId: principal },
        onlyNorte,
      ).expect(403);
      expect(message(res)).toBe('No tienes acceso a esta sede.');
    }
    // Una sede de otra clínica: el mismo 403.
    const foreign = (
      await raw.location.findFirstOrThrow({ where: { tenantId: b.tenantId } })
    ).id;
    await get(
      PRODUCTIVITY,
      { ...NOVEMBER, locationId: foreign },
      a.adminToken,
    ).expect(403);
  });

  it('400: más de 24 meses, fechas mal formadas, UUID inválido, página fuera de rango', async () => {
    const long = await get(
      PRODUCTIVITY,
      { from: '2025-01-01', to: '2027-01-01' },
      a.adminToken,
    ).expect(400);
    expect(message(long)).toBe(PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE);
    await get(
      PRODUCTIVITY,
      { from: '01/11/2026', to: '2026-11-30' },
      a.adminToken,
    ).expect(400);
    await get(
      PRODUCTIVITY,
      { ...NOVEMBER, professionalId: 'nope' },
      a.adminToken,
    ).expect(400);
    await get(NO_SHOWS, { ...NOVEMBER, pageSize: 101 }, a.adminToken).expect(
      400,
    );
    await get(NO_SHOWS, { ...NOVEMBER, page: 0 }, a.adminToken).expect(400);
  });

  it('«Inasistencias»: % y lista con enlace a la cita, auditada como VIEW de APPOINTMENT', async () => {
    const before = new Date();
    const r = await noShows();
    expect(r.summary).toEqual({
      completedAppointments: 1,
      noShows: 1,
      lateCancellations: 1,
      noShowRate: 33.33,
    });
    expect(r.items.map((i) => i.kind)).toEqual([
      'LATE_CANCELLATION',
      'NO_SHOW',
    ]);
    expect(r.items[0]).toMatchObject({
      patientName: 'Paciente Inasistente',
      noticeMinutes: 60,
      timeZone: 'America/Caracas',
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        occurredAt: { gte: before },
      },
      select: { action: true, resourceType: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'VIEW',
      resourceType: 'APPOINTMENT',
      metadata: expect.objectContaining({
        reason: 'NO_SHOW_REPORT',
      }) as unknown,
    });
  });

  it('CSV: con los filtros en la cabecera, protegido y auditado cuando lleva pacientes', async () => {
    const csv = await get(`${PRODUCTIVITY}.csv`, NOVEMBER, a.adminToken).expect(
      200,
    );
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.startsWith('﻿"Productividad por profesional"')).toBe(true);
    expect(csv.text).toContain('"Período","2026-11-01 a 2026-11-30"');
    expect(csv.text).toContain('"Total","","USD",2,140.00,0.00,1,1,1,33.33');

    const own = await get(
      `${PRODUCTIVITY}.csv`,
      NOVEMBER,
      tokens.DENTIST!,
    ).expect(200);
    expect(own.text).not.toContain('"Total"');

    const before = new Date();
    const list = await get(`${NO_SHOWS}.csv`, NOVEMBER, a.adminToken).expect(
      200,
    );
    expect(list.text).toContain('"No-show %",33.33');
    expect(list.text).toContain('"Paciente Inasistente"');
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        occurredAt: { gte: before },
      },
      select: { action: true, metadata: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'EXPORT',
      metadata: expect.objectContaining({
        reason: 'NO_SHOW_REPORT',
      }) as unknown,
    });
    await get(`${NO_SHOWS}.csv`, NOVEMBER, tokens.DENTIST!).expect(403);
  });

  it('«Cartera»: CSV de los totales por tramo y moneda, solo ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/receivables/aging/summary.csv')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(res.text.startsWith('﻿"Cartera por antigüedad"')).toBe(true);
    expect(res.text).toContain('"Moneda","Deudores","Deuda","Por vencer"');
    const denied = await request(app.getHttpServer())
      .get('/api/v1/receivables/aging/summary.csv')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${tokens.RECEPTION}`)
      .expect(403);
    expect(message(denied)).toBe(RECEIVABLES_EXPORT_FORBIDDEN_MESSAGE);
  });

  it('otra clínica no ve nada de A', async () => {
    const r = (await get(PRODUCTIVITY, NOVEMBER, b.adminToken, b).expect(200))
      .body as ProfessionalProductivity;
    expect(r.rows).toEqual([]);
    const list = (await get(NO_SHOWS, NOVEMBER, b.adminToken, b).expect(200))
      .body as NoShowsReport;
    expect(list.total).toBe(0);
  });
});
