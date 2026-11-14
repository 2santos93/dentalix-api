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
import { ReportSeeder } from './support/reports-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { PROFITABILITY_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/profitability.controller';
import {
  PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE,
  PROFITABILITY_PERIOD_TOO_LONG_MESSAGE,
  type ProfitabilityLines,
  type ProfitabilityReport,
} from '../src/modules/reports/application/use-cases/get-profitability.use-case';
import { PROFITABILITY_CSV_HEADER } from '../src/modules/reports/application/profitability-csv';
import type { ProfitabilityRowView } from '../src/modules/reports/domain/profitability';

/**
 * DX-410 · «Rentabilidad por sede» por HTTP real. Clínica A (sedes en
 * UTC−4), octubre de 2026:
 *
 *  - principal: realizado 1.000 USD (el 5/10) y 200 USD (el 20/9: no es de
 *    octubre); abonos 600 USD y 50.000 VES, uno anulado de 999 USD;
 *    gastos: Laboratorio 300 USD (factura 2/10, pagado 200 el 3/10 y 100 el
 *    3/11), Insumos clínicos 100 USD (factura 25/9, pagado el 2/10) y
 *    Alquiler 20.000 VES (factura 1/10, sin pagar);
 *  - Norte: abono 400 USD; gasto de Mensajería 50 USD facturado y pagado el
 *    10/10;
 *  - Sur: realizado 500 USD y un gasto de Laboratorio 80 USD sin pagar.
 *
 * Caja:    principal USD 600 − (200 + 100) = 300; VES 50.000 − 0.
 *          Norte USD 400 − 50 = 350. Sur: nada.
 *          Grupo USD 1.000 − 350 = 650; VES 50.000.
 * Devengo: principal USD 1.000 − 300 = 700; VES 0 − 20.000.
 *          Norte USD 0 − 50. Sur USD 500 − 80 = 420.
 *          Grupo USD 1.500 − 430 = 1.070; VES −20.000.
 *
 * La clínica B tiene lo suyo y no ve nada de A (ni A de B).
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const at = (iso: string) => new Date(iso);
const PATIENT_LAST_NAMES = ['Rentabilidad', 'Gonzalez-Privado'];

describe('GET /reports/profitability (DX-410)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let sur: string;
  let bLocation: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let restrictedAdmin: string;

  function get(clinic: Clinic, path: string, query: object, token: string) {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  const report = async (
    basis: 'CASH' | 'ACCRUAL',
    extra: object = {},
    token = a.adminToken,
  ): Promise<ProfitabilityReport> => {
    const res = await get(
      a,
      '/reports/profitability',
      { ...OCTOBER, basis, ...extra },
      token,
    ).expect(200);
    return res.body as ProfitabilityReport;
  };

  const lines = async (
    query: object,
    token = a.adminToken,
  ): Promise<ProfitabilityLines> => {
    const res = await get(
      a,
      '/reports/profitability/lines',
      { ...OCTOBER, ...query },
      token,
    ).expect(200);
    return res.body as ProfitabilityLines;
  };

  /** [moneda, ingresos, gastos, resultado] de una fila. */
  const nets = (row: ProfitabilityRowView) =>
    row.currencies.map((c) => [c.currency, c.income, c.expenses, c.net]);
  const rowOf = (r: ProfitabilityReport, id: string) => {
    const found = r.locations.find((l) => l.locationId === id);
    if (!found) throw new Error(`sin fila para ${id}`);
    return found;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'rentabilidad-a');
    b = await registerClinic(app, 'rentabilidad-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    bLocation = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
        select: { id: true },
      })
    ).id;

    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    sur = await seed.location('Sede Sur');
    const [p1, p2] = await Promise.all(
      PATIENT_LAST_NAMES.map((n) => seed.patient(n)),
    );
    const usdPlan = await seed.plan({
      patientId: p1,
      currency: 'USD',
      price: 1_000,
      done: { locationId: principal, at: at('2026-10-05T15:00:00Z') },
    });
    await seed.plan({
      patientId: p1,
      currency: 'USD',
      price: 200,
      done: { locationId: principal, at: at('2026-09-20T15:00:00Z') },
    });
    await seed.plan({
      patientId: p2,
      currency: 'USD',
      price: 500,
      done: { locationId: sur, at: at('2026-10-15T15:00:00Z') },
    });
    const vesPlan = await seed.plan({
      patientId: p2,
      currency: 'VES',
      price: 1_000_000,
    });
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
    await pay(principal, usdPlan, p1, 'USD', 600, '2026-10-06T15:00:00Z');
    await pay(principal, usdPlan, p1, 'USD', 999, '2026-10-07T15:00:00Z', true);
    await pay(principal, vesPlan, p2, 'VES', 50_000, '2026-10-08T15:00:00Z');
    await pay(norte, usdPlan, p1, 'USD', 400, '2026-10-09T15:00:00Z');

    await seed.expense({
      locationId: principal,
      currency: 'USD',
      amount: 300,
      category: 'Laboratorio',
      supplier: 'Laboratorio Dental Ávila',
      invoiceDate: '2026-10-02',
      payments: [
        { amount: 200, paidOn: '2026-10-03' },
        { amount: 100, paidOn: '2026-11-03' },
      ],
    });
    await seed.expense({
      locationId: principal,
      currency: 'USD',
      amount: 100,
      category: 'Insumos clínicos',
      invoiceDate: '2026-09-25',
      payments: [{ amount: 100, paidOn: '2026-10-02' }],
    });
    await seed.expense({
      locationId: principal,
      currency: 'VES',
      amount: 20_000,
      category: 'Alquiler',
      invoiceDate: '2026-10-01',
    });
    await seed.expense({
      locationId: norte,
      currency: 'USD',
      amount: 50,
      category: 'Mensajería',
      invoiceDate: '2026-10-10',
      payments: [{ amount: 50, paidOn: '2026-10-10' }],
    });
    await seed.expense({
      locationId: sur,
      currency: 'USD',
      amount: 80,
      category: 'Laboratorio',
      invoiceDate: '2026-10-20',
    });

    // Clínica B: lo suyo, que A nunca ve.
    const seedB = new ReportSeeder(raw, b.tenantId);
    const pb = await seedB.patient('Clinica B');
    const planB = await seedB.plan({
      patientId: pb,
      currency: 'USD',
      price: 77_777,
      done: { locationId: bLocation, at: at('2026-10-05T15:00:00Z') },
    });
    await seedB.payment({
      planId: planB,
      patientId: pb,
      locationId: bLocation,
      currency: 'USD',
      amount: 66_666,
      paidAt: at('2026-10-05T15:00:00Z'),
    });
    await seedB.expense({
      locationId: bLocation,
      currency: 'USD',
      amount: 55_555,
      category: 'Laboratorio',
      invoiceDate: '2026-10-05',
      payments: [{ amount: 55_555, paidOn: '2026-10-05' }],
    });

    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    // DX-089 no deja restringir a un ADMIN (409), pero el informe respeta el
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

  describe('Caja', () => {
    it('cada sede y el total del grupo, con la base en la cabecera', async () => {
      const r = await report('CASH');
      expect(r).toMatchObject({
        from: '2026-10-01',
        to: '2026-10-31',
        basis: 'CASH',
        definition: {
          basis: 'CASH',
          label: 'Caja',
          incomeLabel: 'Cobrado',
          expensesLabel: 'Gastos pagados',
        },
        locationId: null,
        restrictedToLocations: false,
        hasActivity: true,
      });
      expect(r.locations.map((l) => l.locationId)).toEqual([
        principal,
        norte,
        sur,
      ]);
      expect(nets(rowOf(r, principal))).toEqual([
        ['USD', 600, 300, 300],
        ['VES', 50_000, 0, 50_000],
      ]);
      expect(nets(rowOf(r, norte))).toEqual([['USD', 400, 50, 350]]);
      expect(rowOf(r, sur).currencies).toEqual([]);
      expect(r.total).toMatchObject({
        locationId: null,
        name: 'Total del grupo',
      });
      expect(nets(r.total)).toEqual([
        ['USD', 1_000, 350, 650],
        ['VES', 50_000, 0, 50_000],
      ]);
      expect(r.total.currencies[0]).toMatchObject({
        incomeCount: 2,
        expenseCount: 3,
        margin: 65,
        categories: [
          { category: 'Laboratorio', amount: 200, count: 1 },
          { category: 'Insumos clínicos', amount: 100, count: 1 },
          { category: 'Mensajería', amount: 50, count: 1 },
        ],
      });
    });

    it('el detalle de cada cifra suma esa cifra', async () => {
      const income = await lines({
        basis: 'CASH',
        side: 'INCOME',
        currency: 'USD',
        locationId: principal,
      });
      expect(income).toMatchObject({
        total: 600,
        count: 1,
        page: 1,
        pageSize: 25,
      });
      expect(income.lines[0]).toMatchObject({
        date: '2026-10-06',
        locationId: principal,
        amount: 600,
        category: null,
      });
      const lab = await lines({
        basis: 'CASH',
        side: 'EXPENSE',
        currency: 'USD',
        locationId: principal,
        category: 'Laboratorio',
      });
      expect(lab).toMatchObject({
        total: 200,
        count: 1,
        category: 'Laboratorio',
      });
      expect(lab.lines[0]).toMatchObject({
        date: '2026-10-03',
        concept: 'Laboratorio Dental Ávila',
        method: 'Transferencia',
      });
      // Sin sede: el total del grupo.
      const group = await lines({
        basis: 'CASH',
        side: 'EXPENSE',
        currency: 'USD',
      });
      expect(group).toMatchObject({ total: 350, count: 3, locationId: null });
      expect(new Set(group.lines.map((l) => l.locationName)).size).toBe(2);
    });
  });

  describe('Devengo', () => {
    it('producción realizada − gastos por fecha de factura, pagados o no', async () => {
      const r = await report('ACCRUAL');
      expect(r.definition).toMatchObject({
        label: 'Devengo',
        incomeLabel: 'Producción realizada',
        expensesLabel: 'Gastos facturados',
      });
      expect(nets(rowOf(r, principal))).toEqual([
        ['USD', 1_000, 300, 700],
        ['VES', 0, 20_000, -20_000],
      ]);
      expect(nets(rowOf(r, norte))).toEqual([['USD', 0, 50, -50]]);
      expect(nets(rowOf(r, sur))).toEqual([['USD', 500, 80, 420]]);
      expect(nets(r.total)).toEqual([
        ['USD', 1_500, 430, 1_070],
        ['VES', 0, 20_000, -20_000],
      ]);
      expect(r.total.currencies[1].margin).toBeNull();
    });

    it('el detalle: procedimientos realizados y gastos con su estado de pago', async () => {
      const done = await lines({
        basis: 'ACCRUAL',
        side: 'INCOME',
        currency: 'USD',
      });
      expect(done).toMatchObject({ total: 1_500, count: 2 });
      expect(done.lines.map((l) => [l.date, l.amount])).toEqual([
        ['2026-10-15', 500],
        ['2026-10-05', 1_000],
      ]);
      const expenses = await lines({
        basis: 'ACCRUAL',
        side: 'EXPENSE',
        currency: 'USD',
        category: 'Laboratorio',
      });
      expect(
        expenses.lines.map((l) => [l.locationName, l.amount, l.paymentStatus]),
      ).toEqual([
        ['Sede Sur', 80, 'UNPAID'],
        [expect.any(String), 300, 'PAID'],
      ]);
    });
  });

  it('sin datos de pacientes en el informe, el detalle ni el CSV', async () => {
    const bodies = [
      JSON.stringify(await report('CASH')),
      JSON.stringify(await report('ACCRUAL')),
      JSON.stringify(
        await lines({ basis: 'CASH', side: 'INCOME', currency: 'USD' }),
      ),
      JSON.stringify(
        await lines({ basis: 'ACCRUAL', side: 'INCOME', currency: 'USD' }),
      ),
      (
        await get(
          a,
          '/reports/profitability.csv',
          { ...OCTOBER, basis: 'CASH' },
          a.adminToken,
        )
      ).text,
    ];
    for (const body of bodies) {
      for (const name of PATIENT_LAST_NAMES) expect(body).not.toContain(name);
      expect(body).not.toContain('patientId');
    }
  });

  it('el CSV usa la misma definición que la pantalla', async () => {
    const res = await get(
      a,
      '/reports/profitability.csv',
      { ...OCTOBER, basis: 'ACCRUAL' },
      a.adminToken,
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="rentabilidad-devengo-2026-10-01-2026-10-31.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = res.text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(rows[0]).toBe(PROFITABILITY_CSV_HEADER.join(','));
    const p = '"2026-10-01 a 2026-10-31","Devengo"';
    expect(rows).toEqual(
      expect.arrayContaining([
        `${p},"Sede Sur","USD","Producción realizada","",500.00,1`,
        `${p},"Sede Sur","USD","Gastos facturados","Laboratorio",80.00,1`,
        `${p},"Sede Sur","USD","Resultado","",420.00,`,
        `${p},"Total del grupo","USD","Resultado","",1070.00,`,
        `${p},"Total del grupo","VES","Resultado","",-20000.00,`,
      ]),
    );
  });

  describe('sedes (DX-089)', () => {
    it('un miembro restringido ve solo sus sedes y el total solo las suma a ellas', async () => {
      const r = await report('CASH', {}, restrictedAdmin);
      expect(r.restrictedToLocations).toBe(true);
      expect(r.locations.map((l) => l.locationId)).toEqual([principal, norte]);
      expect(nets(r.total)).toEqual([
        ['USD', 1_000, 350, 650],
        ['VES', 50_000, 0, 50_000],
      ]);
      const accrual = await report('ACCRUAL', {}, restrictedAdmin);
      // Sur (500 − 80) no entra.
      expect(nets(accrual.total)[0]).toEqual(['USD', 1_000, 350, 650]);
      const detail = await lines(
        { basis: 'ACCRUAL', side: 'INCOME', currency: 'USD' },
        restrictedAdmin,
      );
      expect(detail).toMatchObject({ total: 1_000, count: 1 });
    });

    it('una sede fuera de las suyas, de otra clínica o inventada es 403', async () => {
      for (const [token, locationId] of [
        [restrictedAdmin, sur],
        [a.adminToken, bLocation],
        [a.adminToken, '00000000-0000-4000-8000-000000000000'],
      ] as const) {
        for (const path of [
          '/reports/profitability',
          '/reports/profitability.csv',
        ]) {
          await get(
            a,
            path,
            { ...OCTOBER, basis: 'CASH', locationId },
            token,
          ).expect(403);
        }
        await get(
          a,
          '/reports/profitability/lines',
          {
            ...OCTOBER,
            basis: 'CASH',
            side: 'INCOME',
            currency: 'USD',
            locationId,
          },
          token,
        ).expect(403);
      }
    });

    it('con `locationId`, solo esa sede', async () => {
      const r = await report('CASH', { locationId: norte });
      expect(r.locationId).toBe(norte);
      expect(r.locations.map((l) => l.locationId)).toEqual([norte]);
      expect(nets(r.total)).toEqual([['USD', 400, 50, 350]]);
    });
  });

  it('la clínica B no ve nada de A, ni A de B', async () => {
    const res = await get(
      b,
      '/reports/profitability',
      { ...OCTOBER, basis: 'CASH' },
      b.adminToken,
    ).expect(200);
    const r = res.body as ProfitabilityReport;
    expect(r.locations.map((l) => l.locationId)).toEqual([bLocation]);
    expect(nets(r.total)).toEqual([['USD', 66_666, 55_555, 11_111]]);
    // A: sus tres sedes y sus importes exactos, sin nada de B.
    const mine = await report('CASH');
    expect(mine.locations.map((l) => l.locationId)).toEqual([
      principal,
      norte,
      sur,
    ]);
    expect(nets(mine.total)).toEqual([
      ['USD', 1_000, 350, 650],
      ['VES', 50_000, 0, 50_000],
    ]);
    const detail = await lines({
      basis: 'CASH',
      side: 'EXPENSE',
      currency: 'USD',
    });
    expect(detail.lines.map((l) => l.locationId)).not.toContain(bLocation);
  });

  describe('permisos', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
      '%s recibe 403 en español en el informe, el CSV y el detalle',
      async (role) => {
        for (const [path, query] of [
          ['/reports/profitability', { basis: 'CASH' }],
          ['/reports/profitability.csv', { basis: 'CASH' }],
          [
            '/reports/profitability/lines',
            { basis: 'CASH', side: 'INCOME', currency: 'USD' },
          ],
        ] as const) {
          const res = await get(
            a,
            path,
            { ...OCTOBER, ...query },
            tokens[role]!,
          ).expect(403);
          expect((res.body as { message: string }).message).toBe(
            PROFITABILITY_FORBIDDEN_MESSAGE,
          );
        }
      },
    );

    it('sin sesión, 401', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/reports/profitability')
        .query({ ...OCTOBER, basis: 'CASH' })
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('validación', () => {
    it.each([
      [{ ...OCTOBER }],
      [{ ...OCTOBER, basis: 'PROFIT' }],
      [{ from: '2026-10-31', to: '2026-10-01', basis: 'CASH' }],
      [{ from: '2026-13-01', to: '2026-10-01', basis: 'CASH' }],
      [{ ...OCTOBER, basis: 'CASH', locationId: 'no-es-uuid' }],
    ])('400 con %j', async (query) => {
      await get(a, '/reports/profitability', query, a.adminToken).expect(400);
    });

    it('más de 366 días es 400 con su mensaje', async () => {
      const res = await get(
        a,
        '/reports/profitability',
        { from: '2025-01-01', to: '2026-01-02', basis: 'CASH' },
        a.adminToken,
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROFITABILITY_PERIOD_TOO_LONG_MESSAGE,
      );
    });

    it('el detalle exige lado y moneda; la categoría solo con gastos', async () => {
      for (const query of [
        { basis: 'CASH', currency: 'USD' },
        { basis: 'CASH', side: 'INCOME' },
        { basis: 'CASH', side: 'INCOME', currency: 'usd' },
        { basis: 'CASH', side: 'INCOME', currency: 'USD', pageSize: 101 },
      ]) {
        await get(
          a,
          '/reports/profitability/lines',
          { ...OCTOBER, ...query },
          a.adminToken,
        ).expect(400);
      }
      const res = await get(
        a,
        '/reports/profitability/lines',
        {
          ...OCTOBER,
          basis: 'CASH',
          side: 'INCOME',
          currency: 'USD',
          category: 'Laboratorio',
        },
        a.adminToken,
      ).expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE,
      );
    });
  });

  it('sin movimientos en el período: las sedes salen vacías', async () => {
    const r = await report('CASH', { from: '2020-01-01', to: '2020-01-31' });
    expect(r.hasActivity).toBe(false);
    expect(r.locations).toHaveLength(3);
    expect(r.total.currencies).toEqual([]);
  });
});
