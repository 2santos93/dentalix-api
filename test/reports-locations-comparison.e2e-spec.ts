import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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
  INVALID_PERIOD_MESSAGE,
  PERIOD_TOO_LONG_MESSAGE,
  type ComparisonRow,
  type LocationsComparison,
} from '../src/modules/reports/application/use-cases/get-locations-comparison.use-case';

/**
 * DX-014 · «Comparar sedes» por HTTP real, con actividad fija sembrada por
 * `raw` en tres sedes de la clínica A (Bogotá, UTC−5):
 *
 *  - principal (con el horario por defecto del registro):
 *      octubre 2026 → producción 120.000 COP (100.000 + 30.000 − 10.000 de
 *      descuento), cobrado 90.000 COP y 50 USD, 9 atendidas + 1 no-show (10 %)
 *      de 3 pacientes, uno nuevo;
 *      31/08–30/09 → producción 100.000 COP, cobrado 75.000 COP (5.000 a las
 *      22:00 del 30/09 en Bogotá, que en UTC ya es 1/10), 23 atendidas + 2
 *      no-show (8 %), dos pacientes nuevos;
 *  - Norte (sin horario): 200 USD de producción, 100 USD cobrados y 2
 *    atendidas en octubre;
 *  - Sur: 1.000.000 COP cobrados en octubre y la primera cita atendida (agosto)
 *    de un paciente que en octubre vuelve a la principal (no es nuevo allí).
 *
 * Además un abono anulado (no cuenta) y la clínica B, que no ve nada de A.
 */

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const at = (iso: string) => new Date(iso);

describe('GET /reports/locations-comparison (DX-014)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let sur: string;
  let principalName: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let restrictedAdmin: string;

  function get(
    clinic: Clinic,
    path: string,
    query: object,
    token: string,
    locationId?: string,
  ) {
    const req = request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return locationId ? req.set('X-Location-Id', locationId) : req;
  }

  const report = async (
    query: object = OCTOBER,
    token = a.adminToken,
    locationId?: string,
  ): Promise<LocationsComparison> => {
    const res = await get(
      a,
      '/reports/locations-comparison',
      query,
      token,
      locationId,
    ).expect(200);
    return res.body as LocationsComparison;
  };

  const row = (r: LocationsComparison, id: string): ComparisonRow => {
    const found = r.locations.find((l) => l.locationId === id);
    if (!found) throw new Error(`sin fila para ${id}`);
    return found;
  };
  const amounts = (list: { currency: string; value: number | null }[]) =>
    list.map((m) => [m.currency, m.value]);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'reportes-a');
    b = await registerClinic(app, 'reportes-b');
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
      select: { id: true, name: true },
    });
    principal = main.id;
    principalName = main.name;

    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    sur = await seed.location('Sede Sur');
    const [p1, p2, p3, p4, p5] = await Promise.all(
      ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco'].map((n) => seed.patient(n)),
    );

    // Producción.
    await seed.plan({
      patientId: p1,
      currency: 'COP',
      price: 100_000,
      done: { locationId: principal, at: at('2026-10-05T15:00:00Z') },
    });
    await seed.plan({
      patientId: p2,
      currency: 'COP',
      price: 30_000,
      discount: 10_000,
      done: { locationId: principal, at: at('2026-10-20T15:00:00Z') },
    });
    await seed.plan({
      patientId: p4,
      currency: 'COP',
      price: 100_000,
      done: { locationId: principal, at: at('2026-09-10T15:00:00Z') },
    });
    const usdPlan = await seed.plan({
      patientId: p5,
      currency: 'USD',
      price: 200,
      done: { locationId: norte, at: at('2026-10-12T15:00:00Z') },
    });
    // Aceptado y sin realizar: no es producción.
    const copPlan = await seed.plan({
      patientId: p1,
      currency: 'COP',
      price: 5_000_000,
    });

    // Cobros.
    const pay = (
      locationId: string,
      planId: string,
      patientId: string,
      currency: string,
      amount: number,
      paidAt: string,
      voided = false,
    ) =>
      seed.payment({
        locationId,
        planId,
        patientId,
        currency,
        amount,
        paidAt: at(paidAt),
        voided,
      });
    await pay(principal, copPlan, p1, 'COP', 60_000, '2026-10-03T16:00:00Z');
    // 18:00 del 31/10 en Bogotá (23:00 UTC): aún es octubre.
    await pay(principal, copPlan, p1, 'COP', 30_000, '2026-10-31T23:00:00Z');
    await pay(principal, copPlan, p1, 'COP', 999, '2026-10-04T16:00:00Z', true);
    await pay(principal, copPlan, p1, 'USD', 50, '2026-10-10T16:00:00Z');
    await pay(principal, copPlan, p1, 'COP', 70_000, '2026-09-15T16:00:00Z');
    // 22:00 del 30/09 en Bogotá: del período anterior aunque en UTC sea 1/10.
    await pay(principal, copPlan, p1, 'COP', 5_000, '2026-10-01T03:00:00Z');
    await pay(norte, usdPlan, p5, 'USD', 100, '2026-10-12T16:00:00Z');
    await pay(sur, copPlan, p1, 'COP', 1_000_000, '2026-10-15T16:00:00Z');

    // Citas.
    await seed.appointment({
      locationId: sur,
      patientId: p3,
      day: '2026-08-10',
      status: 'COMPLETED',
    });
    await seed.appointments({
      locationId: principal,
      patientIds: [p1, p4],
      firstDay: '2026-09-01',
      count: 23,
      status: 'COMPLETED',
    });
    await seed.appointments({
      locationId: principal,
      patientIds: [p4],
      firstDay: '2026-09-20',
      count: 2,
      status: 'NO_SHOW',
    });
    await seed.appointments({
      locationId: principal,
      patientIds: [p1, p2, p3],
      firstDay: '2026-10-06',
      count: 9,
      status: 'COMPLETED',
    });
    await seed.appointments({
      locationId: principal,
      patientIds: [p2],
      firstDay: '2026-10-21',
      count: 1,
      status: 'NO_SHOW',
    });
    await seed.appointments({
      locationId: principal,
      patientIds: [p2],
      firstDay: '2026-10-22',
      count: 1,
      status: 'CANCELLED',
    });
    await seed.appointments({
      locationId: norte,
      patientIds: [p5],
      firstDay: '2026-10-12',
      count: 2,
      status: 'COMPLETED',
    });

    // Diciembre en la Norte (DX-279): 3 atendidas, 1 no-show, 1 cancelación
    // tardía y 1 avisada a tiempo.
    for (const [status, late] of [
      ['COMPLETED', undefined],
      ['COMPLETED', undefined],
      ['COMPLETED', undefined],
      ['NO_SHOW', undefined],
      ['CANCELLED', true],
      ['CANCELLED', false],
    ] as const) {
      await seed.appointment({
        locationId: norte,
        patientId: p5,
        day: '2026-12-03',
        status,
        lateCancellation: late,
      });
    }

    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    // DX-089 no deja restringir a un ADMIN (409), pero el reporte respeta el
    // claim `loc` igual: se firma un token de ADMIN con dos sedes.
    restrictedAdmin = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [principal, norte],
        tv: 0,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('una fila por sede en orden de creación, y el período anterior', async () => {
    const r = await report();
    expect(r).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      compare: 'previous',
      previousFrom: '2026-08-31',
      previousTo: '2026-09-30',
      currency: null,
      hasActivity: true,
    });
    expect(r.locations.map((l) => l.name)).toEqual([
      principalName,
      'Sede Norte',
      'Sede Sur',
    ]);
    expect(r.total.name).toBe('Total clínica');
    expect(r.kpis.map((k) => k.key)).toEqual([
      'production',
      'collected',
      'collectionRate',
      'completedAppointments',
      'noShowRate',
      'newPatients',
      'averageTicket',
      'occupancy',
    ]);
  });

  it('producción 100.000 → 120.000 es +20 % y mejora; no-show 8 % → 10 % es +2 p.p. y empeora', async () => {
    const r = await report();
    const main = row(r, principal);
    expect(main.metrics.production).toContainEqual({
      currency: 'COP',
      value: 120_000,
      previous: 100_000,
      change: 20,
      trend: 'BETTER',
    });
    expect(main.metrics.noShowRate).toEqual({
      value: 10,
      previous: 8,
      change: 2,
      trend: 'WORSE',
    });
    const noShowDef = r.kpis.find((k) => k.key === 'noShowRate');
    expect(noShowDef?.changeUnit).toBe('POINTS');
    expect(main.metrics.completedAppointments).toMatchObject({
      value: 9,
      previous: 23,
    });
  });

  it('no-show % suma las cancelaciones tardías al denominador; las avisadas no cuentan', async () => {
    const december = await report({
      from: '2026-12-01',
      to: '2026-12-31',
      compare: 'none',
    });
    // 1 ÷ (3 + 1 + 1 tardía) = 20 %; sin las tardías sería 25 %.
    expect(row(december, norte).metrics.noShowRate.value).toBe(20);
    expect(row(december, norte).metrics.completedAppointments.value).toBe(3);
    expect(december.total.metrics.noShowRate.value).toBe(20);
  });

  it('cobrado por moneda y por día civil de la sede; el anulado no cuenta', async () => {
    const main = row(await report(), principal);
    expect(main.metrics.collected).toEqual([
      {
        currency: 'COP',
        value: 90_000,
        previous: 75_000,
        change: 20,
        trend: 'BETTER',
      },
      {
        currency: 'USD',
        value: 50,
        previous: 0,
        change: null,
        trend: 'BETTER',
      },
    ]);
    expect(amounts(main.metrics.collectionRate)).toEqual([
      ['COP', 75],
      ['USD', null],
    ]);
    // 3 pacientes distintos atendidos en octubre.
    expect(amounts(main.metrics.averageTicket)).toEqual([
      ['COP', 30_000],
      ['USD', 16.67],
    ]);
  });

  it('pacientes nuevos: la primera cita atendida de la clínica, en su sede', async () => {
    const r = await report();
    expect(row(r, principal).metrics.newPatients).toMatchObject({
      value: 1,
      previous: 2,
    });
    expect(row(r, norte).metrics.newPatients.value).toBe(1);
    expect(row(r, sur).metrics.newPatients.value).toBe(0);
  });

  it('ocupación: minutos atendidos ÷ minutos del horario; sin horario, null', async () => {
    const r = await report();
    // Octubre 2026: 22 días de lunes a viernes (480 min) y 5 sábados (240):
    // 11.760 minutos abiertos; 9 citas de 30 min.
    expect(row(r, principal).metrics.occupancy.value).toBe(2.3);
    expect(row(r, norte).metrics.occupancy.value).toBeNull();
    expect(r.total.metrics.occupancy.value).toBe(2.3);
  });

  it('el total da un importe por moneda: nunca suma COP con USD', async () => {
    const { total } = await report();
    expect(amounts(total.metrics.production)).toEqual([
      ['COP', 120_000],
      ['USD', 200],
    ]);
    expect(amounts(total.metrics.collected)).toEqual([
      ['COP', 1_090_000],
      ['USD', 150],
    ]);
    expect(total.metrics.completedAppointments.value).toBe(11);
    expect(total.metrics.newPatients.value).toBe(2);
  });

  it('con `currency` solo salen los importes de esa moneda', async () => {
    const r = await report({ ...OCTOBER, currency: 'USD' });
    expect(r.currency).toBe('USD');
    expect(amounts(r.total.metrics.collected)).toEqual([['USD', 150]]);
    expect(amounts(row(r, principal).metrics.production)).toEqual([['USD', 0]]);
  });

  it('«sin comparación» y «mismo período del año anterior»', async () => {
    const none = await report({ ...OCTOBER, compare: 'none' });
    expect(none.previousFrom).toBeNull();
    expect(row(none, principal).metrics.noShowRate).toEqual({
      value: 10,
      previous: null,
      change: null,
      trend: null,
    });
    const lastYear = await report({ ...OCTOBER, compare: 'previous_year' });
    expect([lastYear.previousFrom, lastYear.previousTo]).toEqual([
      '2025-10-01',
      '2025-10-31',
    ]);
    expect(row(lastYear, principal).metrics.production).toContainEqual({
      currency: 'COP',
      value: 120_000,
      previous: 0,
      change: null,
      trend: 'BETTER',
    });
  });

  it('un período sin actividad: hasActivity false y las sedes en cero', async () => {
    const r = await report({ from: '2026-01-01', to: '2026-01-31' });
    expect(r.hasActivity).toBe(false);
    expect(r.locations).toHaveLength(3);
    expect(r.locations.every((l) => !l.hasActivity)).toBe(true);
  });

  describe('restricción por sedes (DX-089)', () => {
    it('un ADMIN con las sedes principal y Norte no ve la Sur ni su efecto en el total', async () => {
      const r = await report(OCTOBER, restrictedAdmin);
      expect(r.locations.map((l) => l.locationId)).toEqual([principal, norte]);
      expect(amounts(r.total.metrics.collected)).toEqual([
        ['COP', 90_000],
        ['USD', 150],
      ]);
      expect(JSON.stringify(r)).not.toContain(sur);
    });

    it('la sede activa (X-Location-Id) no acota la comparación', async () => {
      const r = await report(OCTOBER, restrictedAdmin, principal);
      expect(r.locations.map((l) => l.locationId)).toEqual([principal, norte]);
      const full = await report(OCTOBER, a.adminToken, norte);
      expect(full.locations).toHaveLength(3);
    });

    it('una sede fuera de las suyas en X-Location-Id es 403', async () => {
      await get(
        a,
        '/reports/locations-comparison',
        OCTOBER,
        restrictedAdmin,
        sur,
      ).expect(403);
    });

    it('el CSV tampoco lleva la sede Sur', async () => {
      const res = await get(
        a,
        '/reports/locations-comparison.csv',
        OCTOBER,
        restrictedAdmin,
      ).expect(200);
      expect(res.text).toContain('"Sede Norte"');
      expect(res.text).not.toContain('Sede Sur');
      expect(res.text).toContain(
        '2026-10-01 a 2026-10-31,2026-08-31 a 2026-09-30,"Total clínica","Cobrado",COP,90000.00,75000.00,20.0,%,Mejora',
      );
    });
  });

  describe('permisos', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
      '%s recibe 403 en español en la lista y en el CSV',
      async (role) => {
        for (const path of [
          '/reports/locations-comparison',
          '/reports/locations-comparison.csv',
        ]) {
          const res = await get(a, path, OCTOBER, tokens[role]!).expect(403);
          expect((res.body as { message: string }).message).toBe(
            REPORTS_FORBIDDEN_MESSAGE,
          );
        }
      },
    );

    it('sin sesión, 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/locations-comparison')
        .query(OCTOBER)
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('validación (400 en español)', () => {
    it.each([
      [{ from: '2026-10-31', to: '2026-10-01' }, INVALID_PERIOD_MESSAGE],
      [{ from: '2026-02-30', to: '2026-03-01' }, INVALID_PERIOD_MESSAGE],
      [{ from: '2025-01-01', to: '2026-01-02' }, PERIOD_TOO_LONG_MESSAGE],
      [
        { from: '01/10/2026', to: '2026-10-31' },
        'from debe ser una fecha AAAA-MM-DD.',
      ],
      [
        { ...OCTOBER, compare: 'yesterday' },
        'compare debe ser previous, previous_year o none.',
      ],
      [
        { ...OCTOBER, currency: 'pesos' },
        'currency debe ser un código de moneda de 3 letras (p. ej. COP).',
      ],
    ])('%j → %s', async (query, message) => {
      const res = await get(
        a,
        '/reports/locations-comparison',
        query,
        a.adminToken,
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain(message);
    });

    it('366 días es el máximo admitido', async () => {
      await report({ from: '2025-10-31', to: '2026-10-31' });
    });
  });

  describe('CSV', () => {
    it('descarga con los filtros activos, protegido y sin caché', async () => {
      const res = await get(
        a,
        '/reports/locations-comparison.csv',
        { ...OCTOBER, compare: 'previous_year' },
        a.adminToken,
      ).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="comparar-sedes-2026-10-01-2026-10-31.csv"',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text.startsWith('\uFEFFPeríodo,Comparado con,Sede')).toBe(
        true,
      );
      expect(res.text).toContain(
        `2026-10-01 a 2026-10-31,2025-10-01 a 2025-10-31,"${principalName}","No-show %",,10.00,,,`,
      );
      expect(res.text).toContain('"Sede Sur"');
    });

    it('la variación de los porcentajes va en puntos (p.p.) y la del resto en %', async () => {
      const res = await get(
        a,
        '/reports/locations-comparison.csv',
        OCTOBER,
        a.adminToken,
      ).expect(200);
      expect(res.text).toContain(
        `"${principalName}","No-show %",,10.00,8.00,2.0,p.p.,Empeora`,
      );
      expect(res.text).toContain(
        `"${principalName}","Producción",COP,120000.00,100000.00,20.0,%,Mejora`,
      );
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B solo ve su sede, sin la actividad de A', async () => {
      const res = await get(
        b,
        '/reports/locations-comparison',
        OCTOBER,
        b.adminToken,
      ).expect(200);
      const r = res.body as LocationsComparison;
      expect(r.locations).toHaveLength(1);
      expect(r.hasActivity).toBe(false);
      expect(r.total.metrics.collected).toEqual([]);
      expect(JSON.stringify(r)).not.toContain(principal);
    });

    it('una sede de A en X-Location-Id es 400 para B', async () => {
      await get(
        b,
        '/reports/locations-comparison',
        OCTOBER,
        b.adminToken,
        principal,
      ).expect(400);
    });
  });
});
