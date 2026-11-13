import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { CSV_BOM } from '../src/shared/csv/csv-cells';
import { EXPENSE_PAYABLES_CSV_HEADER } from '../src/modules/expenses/application/expense-payables-csv';
import { createE2eApp } from './support/create-e2e-app';
import { withBody } from './support/with-body';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { locationBody } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

// DX-411 en HTTP real: cuentas por pagar por proveedor, su CSV y el detalle.
// Los gastos se crean por la API. Los vencimientos se fijan relativos al
// «hoy» de una sede cuya zona está lejos de la medianoche (sede-clock), así
// que la API y el spec ven el mismo día aunque la corrida cruce horas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Amounts {
  openCount: number;
  pending: number;
  overdueCount: number;
  overdue: number;
  dueIn7DaysCount: number;
  dueIn7Days: number;
  dueIn30DaysCount: number;
  dueIn30Days: number;
  noDueDateCount: number;
  noDueDate: number;
}
interface Row extends Amounts {
  supplierKey: string;
  supplier: string | null;
  currency: string;
  oldestDueDate: string | null;
}
interface PayablesBody {
  rows: Row[];
  totals: (Amounts & { currency: string })[];
}
interface DetailBody {
  supplierKey: string;
  supplier: string | null;
  currency: string;
  items: { id: string; pendingAmount: number; overdue: boolean }[];
  total: number;
}

const LAB = 'laboratorio dental avila';

describe('Cuentas por pagar por proveedor (e2e, DX-411)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let sede: string;
  let otherSede: string;
  let today: string;
  const ids: Record<string, string> = {};
  const tokens = {} as Record<ClinicRole, string>;

  const admin = () => tokens[ClinicRole.ADMIN];
  const call = (
    verb: 'get' | 'post',
    url: string,
    token: string = admin(),
    host: string = clinic.host,
  ) =>
    withBody(
      request(app.getHttpServer())
        [verb](`/api/v1${url}`)
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${token}`),
    );
  const payables = async (query = '', location?: string) => {
    const req = call('get', `/expenses/payables${query}`);
    if (location) req.set('X-Location-Id', location);
    return (await req.expect(200)).body as PayablesBody;
  };
  const detail = async (query: string) =>
    (await call('get', `/expenses/payables/expenses?${query}`).expect(200))
      .body as DetailBody;
  const csv = (url: string) =>
    call('get', url)
      .buffer(true)
      .parse((res, done) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => done(null, data));
      });
  const day = (offset: number) => addCivilDays(today, offset);

  async function expense(
    name: string,
    patch: Record<string, unknown>,
  ): Promise<string> {
    const res = await call('post', '/expenses')
      .send({
        category: 'Laboratorio',
        supplier: 'Laboratorio Dental Ávila',
        currency: 'USD',
        invoiceDate: day(-40),
        locationId: sede,
        ...patch,
      })
      .expect((r) => {
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      });
    ids[name] = (res.body as { id: string }).id;
    return ids[name];
  }
  const pay = (id: string, amount: number) =>
    call('post', `/expenses/${id}/payments`)
      .send({ amount, method: 'TRANSFER' })
      .expect(201);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx411-cxp');
    other = await registerClinic(app, 'dx411-cxp-otra');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    for (const role of [ClinicRole.DENTIST, ClinicRole.RECEPTION]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    const fixture = sedeTodayFixture();
    today = civilDateIn(new Date(), fixture.timeZone);
    sede = (
      (
        await call('post', '/locations')
          .send(locationBody(fixture, { name: 'Sede Este' }))
          .expect(201)
      ).body as { id: string }
    ).id;
    const sedes = await call('get', '/locations').expect(200);
    const principal = (sedes.body as { id: string }[]).find(
      (l) => l.id !== sede,
    )!.id;
    otherSede = (
      (
        await call('get', '/locations', other.adminToken, other.host).expect(
          200,
        )
      ).body as { id: string }[]
    )[0].id;

    // Sede Este (hoy = `today`):
    await expense('A1', { amount: 120, dueDate: day(-1) }); // vencido
    await pay(ids.A1, 20); // pendiente 100
    await expense('A2', {
      amount: 80,
      supplier: '  laboratorio   dental avila ',
      dueDate: day(0), // vence hoy: 7 y 30 días
    });
    await expense('A3', {
      amount: 30,
      supplier: 'LABORATORIO DENTAL ÁVILA',
      dueDate: day(10), // solo 30 días
    });
    await expense('A4', { amount: 40 }); // sin vencimiento
    await expense('A5', { amount: 50, dueDate: day(-5) });
    await pay(ids.A5, 50); // pagado: fuera
    await expense('A6', { amount: 999, dueDate: day(-5) });
    await call('post', `/expenses/${ids.A6}/void`)
      .send({ reason: 'Registrado por error' })
      .expect(200); // anulado: fuera
    await expense('A7', {
      amount: 25,
      supplier: null,
      category: 'Mensajería',
      dueDate: day(3), // sin proveedor, 7 días
    });
    await expense('A8', { amount: 1000, currency: 'VES', dueDate: day(20) });
    // Sede principal, sin vencimiento (su «hoy» no importa): el más reciente
    // del grupo, su grafía es la que se muestra.
    await expense('B1', {
      amount: 70,
      locationId: principal,
      invoiceDate: '2026-10-01',
      supplier: 'Laboratorio Dental Ávila',
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('agrupa por proveedor normalizado y moneda, lo más urgente primero, con totales por moneda', async () => {
    const body = await payables();
    expect(body.rows).toEqual([
      {
        // A1 100 vencido; A2 80 hoy; A3 30 en 10 días; A4 40 y B1 70 sin
        // vencimiento. 100 + 80 + 30 + 40 + 70 = 320.
        supplierKey: LAB,
        supplier: 'Laboratorio Dental Ávila',
        currency: 'USD',
        oldestDueDate: day(-1),
        openCount: 5,
        pending: 320,
        overdueCount: 1,
        overdue: 100,
        dueIn7DaysCount: 1,
        dueIn7Days: 80,
        dueIn30DaysCount: 2,
        dueIn30Days: 110,
        noDueDateCount: 2,
        noDueDate: 110,
      },
      {
        supplierKey: '',
        supplier: null,
        currency: 'USD',
        oldestDueDate: day(3),
        openCount: 1,
        pending: 25,
        overdueCount: 0,
        overdue: 0,
        dueIn7DaysCount: 1,
        dueIn7Days: 25,
        dueIn30DaysCount: 1,
        dueIn30Days: 25,
        noDueDateCount: 0,
        noDueDate: 0,
      },
      {
        supplierKey: LAB,
        supplier: 'Laboratorio Dental Ávila',
        currency: 'VES',
        oldestDueDate: day(20),
        openCount: 1,
        pending: 1000,
        overdueCount: 0,
        overdue: 0,
        dueIn7DaysCount: 0,
        dueIn7Days: 0,
        dueIn30DaysCount: 1,
        dueIn30Days: 1000,
        noDueDateCount: 0,
        noDueDate: 0,
      },
    ]);
    expect(body.totals).toEqual([
      {
        currency: 'USD',
        openCount: 6,
        pending: 345,
        overdueCount: 1,
        overdue: 100,
        dueIn7DaysCount: 2,
        dueIn7Days: 105,
        dueIn30DaysCount: 3,
        dueIn30Days: 135,
        noDueDateCount: 2,
        noDueDate: 110,
      },
      {
        currency: 'VES',
        openCount: 1,
        pending: 1000,
        overdueCount: 0,
        overdue: 0,
        dueIn7DaysCount: 0,
        dueIn7Days: 0,
        dueIn30DaysCount: 1,
        dueIn30Days: 1000,
        noDueDateCount: 0,
        noDueDate: 0,
      },
    ]);
  });

  it('filtra por sede (cabecera o parámetro) y por moneda', async () => {
    for (const body of [
      await payables('', sede),
      await payables(`?locationId=${sede}`),
    ]) {
      const lab = body.rows.find(
        (r) => r.supplierKey === LAB && r.currency === 'USD',
      );
      expect(lab).toMatchObject({ openCount: 4, pending: 250, noDueDate: 40 });
    }
    const ves = await payables('?currency=ves');
    expect(ves.rows.map((r) => [r.supplierKey, r.currency])).toEqual([
      [LAB, 'VES'],
    ]);
    expect(ves.totals.map((t) => t.currency)).toEqual(['VES']);
  });

  it('solo cuentan los pagos vivos: pagar y anular el pago mueve los tramos', async () => {
    const paid = (await pay(ids.A2, 80)).body as {
      payments: { id: string }[];
    };
    const afterPay = (await payables('?currency=USD')).rows[0];
    expect(afterPay).toMatchObject({
      openCount: 4,
      pending: 240,
      dueIn7DaysCount: 0,
    });
    await call(
      'post',
      `/expenses/${ids.A2}/payments/${paid.payments.at(-1)!.id}/void`,
    )
      .send({ reason: 'Pago duplicado' })
      .expect(200);
    const afterVoid = (await payables('?currency=USD')).rows[0];
    expect(afterVoid).toMatchObject({
      openCount: 5,
      pending: 320,
      dueIn7DaysCount: 1,
    });
  });

  it('CSV: mismas filas y orden, celdas protegidas y decimales de la moneda', async () => {
    const res = await csv('/expenses/payables.csv').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(
      'cuentas-por-pagar.csv',
    );
    const text = res.body as string;
    expect(text.startsWith(CSV_BOM)).toBe(true);
    const lines = text.slice(CSV_BOM.length).split('\r\n');
    expect(lines).toEqual([
      EXPENSE_PAYABLES_CSV_HEADER.join(','),
      `"Laboratorio Dental Ávila",USD,5,320.00,100.00,1,80.00,1,110.00,2,110.00,${day(-1)}`,
      `"Sin proveedor",USD,1,25.00,0.00,0,25.00,1,25.00,1,0.00,${day(3)}`,
      `"Laboratorio Dental Ávila",VES,1,1000.00,0.00,0,0.00,0,1000.00,1,0.00,${day(20)}`,
      '',
    ]);
    const onlyVes = await csv('/expenses/payables.csv?currency=VES').expect(
      200,
    );
    expect((onlyVes.body as string).split('\r\n')).toHaveLength(3);
  });

  it('detalle: los abiertos del proveedor por vencimiento, sin vencimiento al final', async () => {
    const body = await detail(
      `supplierKey=${encodeURIComponent(LAB)}&currency=USD`,
    );
    expect(body).toMatchObject({
      supplierKey: LAB,
      supplier: 'Laboratorio Dental Ávila',
      currency: 'USD',
      total: 5,
    });
    expect(body.items.map((i) => [i.id, i.pendingAmount, i.overdue])).toEqual([
      [ids.A1, 100, true],
      [ids.A2, 80, false],
      [ids.A3, 30, false],
      // Sin vencimiento: primero la factura más antigua (B1, del 01/10).
      [ids.B1, 70, false],
      [ids.A4, 40, false],
    ]);
    // La clave admite cualquier grafía del proveedor.
    const loose = await detail(
      `supplierKey=${encodeURIComponent(' LABORATORIO  DENTAL ÁVILA')}&currency=usd&locationId=${sede}`,
    );
    expect(loose.items.map((i) => i.id)).toEqual([
      ids.A1,
      ids.A2,
      ids.A3,
      ids.A4,
    ]);
    const none = await detail('supplierKey=&currency=USD');
    expect(none).toMatchObject({ supplier: null, total: 1 });
    expect(none.items.map((i) => i.id)).toEqual([ids.A7]);
  });

  it('valida sede, moneda y proveedor (400 en español)', async () => {
    await call('get', '/expenses/payables?currency=XX').expect(400);
    await call('get', '/expenses/payables?locationId=no-uuid').expect(400);
    await call('get', '/expenses/payables/expenses?currency=USD').expect(400);
    await call(
      'get',
      `/expenses/payables/expenses?supplierKey=${encodeURIComponent(LAB)}`,
    ).expect(400);
  });

  it('solo ADMIN: recepción y odontología reciben 403', async () => {
    for (const role of [ClinicRole.RECEPTION, ClinicRole.DENTIST]) {
      for (const url of [
        '/expenses/payables',
        '/expenses/payables.csv',
        `/expenses/payables/expenses?supplierKey=${encodeURIComponent(LAB)}&currency=USD`,
      ]) {
        await call('get', url, tokens[role]).expect(403);
      }
    }
  });

  it('aislamiento: otra clínica no ve nada, ni pidiendo una sede ajena', async () => {
    const asOther = (url: string) =>
      call('get', url, other.adminToken, other.host).expect(200);
    expect((await asOther('/expenses/payables')).body).toEqual({
      rows: [],
      totals: [],
    });
    expect(
      (await asOther(`/expenses/payables?locationId=${sede}`)).body,
    ).toEqual({ rows: [], totals: [] });
    const foreignCsv = await asOther(
      `/expenses/payables.csv?locationId=${sede}`,
    );
    expect(String(foreignCsv.text).split('\r\n')).toHaveLength(2);
    expect(
      (
        await asOther(
          `/expenses/payables/expenses?supplierKey=${encodeURIComponent(LAB)}&currency=USD&locationId=${sede}`,
        )
      ).body,
    ).toMatchObject({ items: [], total: 0 });
    // Y la clínica A no ve la sede de B.
    expect(await payables(`?locationId=${otherSede}`)).toEqual({
      rows: [],
      totals: [],
    });
  });
});
