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
  caracas,
  plusDays,
  quoteFunnelSeeding,
  type FunnelClinic,
} from './support/quote-funnel-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import {
  QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE,
  QUOTE_FUNNEL_FORBIDDEN_MESSAGE,
} from '../src/modules/reports/presentation/quote-funnel.controller';
import {
  QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
  QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE,
  QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE,
  type QuoteFunnelPresentations,
  type QuoteFunnelReport,
} from '../src/modules/reports/application/use-cases/get-quote-funnel.use-case';

/**
 * DX-558 · «Embudo de presupuestos» por HTTP real. Clínica A (Caracas,
 * catálogo en USD) con dos sedes y octubre de 2026:
 *  - de la Dra. (DENTIST) en la principal: uno aceptado (100) y uno
 *    rechazado por precio (300);
 *  - del ADMIN en la Norte: uno pendiente (500).
 * Las cifras finas (parciales, A/B, moneda, rendimiento) están en el int.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const ROUTE = '/reports/quote-funnel';

const { plan } = quoteFunnelSeeding(raw);

describe('GET /reports/quote-funnel (DX-558)', () => {
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
  ): Promise<QuoteFunnelReport> =>
    (await get(ROUTE, { ...OCTOBER, ...query }, token).expect(200))
      .body as QuoteFunnelReport;

  const count = (r: QuoteFunnelReport, key: string) =>
    r.steps.find((s) => s.key === key)?.count;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'embudo-a');
    b = await registerClinic(app, 'embudo-b');
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
    const patientId = await seed.patient('Embudo');

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
    const clinic: FunnelClinic = {
      tenantId: a.tenantId,
      seed,
      main: principal,
      norte,
      patientId,
      dentist: { id: '', userId: dentistId },
      otherDentistId: a.adminUserId,
    };
    const presentedAt = caracas('2026-10-10');
    await plan(clinic, {
      status: 'ACCEPTED',
      presentedAt,
      acceptedAt: plusDays(presentedAt, 2),
      items: [{ price: 100, status: 'ACCEPTED' }],
    });
    await plan(clinic, {
      status: 'REJECTED',
      presentedAt: caracas('2026-10-12'),
      rejectedAt: caracas('2026-10-14'),
      rejectionReason: 'PRICE',
      items: [{ price: 300 }],
    });
    await plan(clinic, {
      status: 'PRESENTED',
      presentedAt: caracas('2026-10-15'),
      locationId: norte,
      createdById: a.adminUserId,
      items: [{ price: 500 }],
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

  it('ADMIN: toda la clínica, con pasos, tasas, motivos, definiciones y opciones', async () => {
    const r = await report();
    expect(r).toMatchObject({
      period: OCTOBER,
      currency: 'USD',
      scope: 'CLINIC',
      restrictedToLocations: false,
      acceptanceRate: { byCount: 33.3, byAmount: 11.1 },
      medianDaysToAccept: 2,
      outcomes: {
        pending: { count: 1, amount: 500 },
        rejected: { count: 1, amount: 300 },
        cancelled: { count: 0, amount: 0 },
      },
      rejectionReasons: [{ reason: 'PRICE', count: 1, amount: 300 }],
      withoutRate: { presentations: 0 },
      warnings: [],
    });
    expect(r.steps.map((s) => [s.key, s.count, s.amount])).toEqual([
      ['PRESENTED', 3, 900],
      ['ACCEPTED', 1, 100],
      ['SCHEDULED', 0, 0],
      ['DONE', 0, 0],
      ['COLLECTED', 0, 0],
    ]);
    expect(r.byProfessional.map((p) => p.professionalId).sort()).toEqual(
      [dentistId, a.adminUserId].sort(),
    );
    expect(r.definitions.map((d) => d.key)).toContain('ACCEPTANCE_RATE');
    expect(r.options.locations.map((l) => l.id)).toEqual([principal, norte]);
  });

  it('DENTIST: solo los suyos (OWN); pedir los de otro es 403', async () => {
    const r = await report({}, tokens.DENTIST);
    expect(r.scope).toBe('OWN');
    expect(count(r, 'PRESENTED')).toBe(2);
    expect(r.byProfessional.map((p) => p.professionalId)).toEqual([dentistId]);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([dentistId]);
    const denied = await get(
      ROUTE,
      { ...OCTOBER, providerId: a.adminUserId },
      tokens.DENTIST!,
    ).expect(403);
    expect((denied.body as { message: string }).message).toBe(
      QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
    );
  });

  it('asistente y recepción sin permiso → 403; con FINANCIAL_REPORTS_VIEW, la clínica', async () => {
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
      for (const path of [ROUTE, `${ROUTE}/presentations`]) {
        const res = await get(
          path,
          { ...OCTOBER, step: 'PRESENTED' },
          tokens[role]!,
        ).expect(403);
        expect((res.body as { message: string }).message).toBe(
          QUOTE_FUNNEL_FORBIDDEN_MESSAGE,
        );
      }
    }
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
    });
    try {
      const r = await report({ providerId: dentistId }, tokens.RECEPTION);
      expect(r.scope).toBe('CLINIC');
      expect(count(r, 'PRESENTED')).toBe(2);
      // El CSV sigue siendo solo de ADMIN.
      const csv = await get(`${ROUTE}.csv`, OCTOBER, tokens.RECEPTION!).expect(
        403,
      );
      expect((csv.body as { message: string }).message).toBe(
        QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE,
      );
    } finally {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [] },
      });
    }
  });

  it('restringido a una sede (DX-089): solo lo presentado allí; otra sede, 403', async () => {
    const r = await report({}, onlyNorte);
    expect(r.restrictedToLocations).toBe(true);
    expect(count(r, 'PRESENTED')).toBe(1);
    expect(r.options.locations.map((l) => l.id)).toEqual([norte]);
    await get(ROUTE, { ...OCTOBER, locationId: principal }, onlyNorte).expect(
      403,
    );
    const main = await report({ locationId: principal });
    expect(count(main, 'PRESENTED')).toBe(2);
  });

  it('400: período de más de 366 días, paso desconocido o motivo sin step=REJECTED', async () => {
    const long = await get(
      ROUTE,
      { from: '2025-01-01', to: '2026-01-02' },
      a.adminToken,
    ).expect(400);
    expect((long.body as { message: string }).message).toBe(
      QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE,
    );
    await get(
      `${ROUTE}/presentations`,
      { ...OCTOBER, step: 'NOPE' },
      a.adminToken,
    ).expect(400);
    const reason = await get(
      `${ROUTE}/presentations`,
      { ...OCTOBER, step: 'ACCEPTED', reason: 'PRICE' },
      a.adminToken,
    ).expect(400);
    expect((reason.body as { message: string }).message).toBe(
      QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE,
    );
  });

  it('detalle: presentaciones con paciente, auditado como VIEW; el DENTIST solo las suyas', async () => {
    const before = new Date();
    const res = await get(
      `${ROUTE}/presentations`,
      { ...OCTOBER, step: 'REJECTED', reason: 'PRICE' },
      a.adminToken,
    ).expect(200);
    const body = res.body as QuoteFunnelPresentations;
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.items[0]).toMatchObject({
      patientName: 'Paciente Embudo',
      professionalId: dentistId,
      presentedAmount: 300,
      outcome: 'REJECTED',
      rejectionReason: 'PRICE',
      timeZone: 'America/Caracas',
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        resourceType: 'TREATMENT_PLAN',
        occurredAt: { gte: before },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'VIEW' });
    expect(events[0].metadata).toMatchObject({
      reason: 'QUOTE_FUNNEL_REPORT',
    });

    const own = (
      await get(
        `${ROUTE}/presentations`,
        { ...OCTOBER, step: 'PRESENTED' },
        tokens.DENTIST!,
      ).expect(200)
    ).body as QuoteFunnelPresentations;
    expect(own.total).toBe(2);
    expect(own.items.every((i) => i.professionalId === dentistId)).toBe(true);
  });

  it('CSV solo ADMIN: una fila por profesional y el total, auditado como EXPORT', async () => {
    const before = new Date();
    const res = await get(`${ROUTE}.csv`, OCTOBER, a.adminToken).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="embudo-de-presupuestos-2026-10-01-2026-10-31.csv"',
    );
    const lines = res.text.trim().split('\r\n');
    expect(lines[4]).toBe('"Moneda","USD"');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe(
      '"Total",3,900.00,1,100.00,0,0.00,0,0.00,0,0.00,33.3,11.1,2',
    );
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        resourceType: 'TREATMENT_PLAN',
        action: 'EXPORT',
        occurredAt: { gte: before },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      reason: 'QUOTE_FUNNEL_REPORT',
    });
    for (const role of [ClinicRole.DENTIST, ClinicRole.RECEPTION]) {
      const denied = await get(`${ROUTE}.csv`, OCTOBER, tokens[role]!).expect(
        403,
      );
      expect((denied.body as { message: string }).message).toBe(
        QUOTE_FUNNEL_CSV_FORBIDDEN_MESSAGE,
      );
    }
  });

  it('otra clínica no ve nada de A', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1${ROUTE}`)
      .query(OCTOBER)
      .set('X-Tenant-Host', b.host)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    expect((res.body as QuoteFunnelReport).steps.map((s) => s.count)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });
});
