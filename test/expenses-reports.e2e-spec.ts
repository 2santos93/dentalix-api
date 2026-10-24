import { INestApplication } from '@nestjs/common';
import {
  ClinicRole,
  DocType,
  PaymentMethod,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  SUMMARY_PERIOD_INVALID_MESSAGE,
  SUMMARY_PERIOD_TOO_LONG_MESSAGE,
} from '../src/modules/expenses/application/use-cases/get-expense-summary.use-case';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-274 (Task 4) en HTTP real: resumen mensual ingresos − gastos y CSV. Los
// abonos se siembran por `raw` para fijar sede, instante y moneda sin depender
// de la fecha de la corrida (esta suite prueba la LECTURA, no el cobro).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface SummaryRow {
  month: string;
  locationId: string;
  locationName: string;
  currency: string;
  income: number;
  categories: { category: string; amount: number }[];
  expensesTotal: number;
  net: number;
}
interface SummaryBody {
  from: string;
  to: string;
  rows: SummaryRow[];
}

describe('Resumen mensual y CSV de gastos (e2e, DX-274)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let loc1: string;
  let loc2: string;
  const tokens = {} as Record<ClinicRole, string>;

  const admin = () => tokens[ClinicRole.ADMIN];
  const call = (
    verb: 'get' | 'post',
    url: string,
    token: string = admin(),
    host: string = clinic.host,
  ) =>
    request(app.getHttpServer())
      [verb](`/api/v1${url}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);

  const summary = (query: string, location?: string) => {
    const req = call('get', `/expenses/summary?${query}`);
    return location ? req.set('X-Location-Id', location) : req;
  };
  const rowsOf = async (query: string, location?: string) =>
    ((await summary(query, location).expect(200)).body as SummaryBody).rows;
  const csv = (url: string, token = admin()) =>
    call('get', url, token)
      .buffer(true)
      .parse((res, done) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => done(null, data));
      });

  async function expense(patch: Record<string, unknown>): Promise<string> {
    const res = await call('post', '/expenses')
      .send({
        category: 'Papelería',
        amount: 100000,
        currency: 'COP',
        invoiceDate: '2026-10-01',
        locationId: loc1,
        ...patch,
      })
      .expect((r) => {
        if (r.status !== 201) throw new Error(JSON.stringify(r.body));
      });
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx274-resumen');
    other = await registerClinic(app, 'dx274-resumen-otra');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    for (const role of [ClinicRole.DENTIST, ClinicRole.RECEPTION]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    const sedes = await call('get', '/locations').expect(200);
    loc1 = (sedes.body as { id: string }[])[0].id;
    loc2 = (
      (
        await call('post', '/locations')
          .send({ name: 'Sede Norte' })
          .expect(201)
      ).body as { id: string }
    ).id;

    const patient = (
      (
        await call('post', '/patients')
          .send({
            firstName: 'Ana',
            lastName: 'Gómez',
            docType: DocType.CC,
            docNumber: 'RES-1',
            sex: Sex.F,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const plan = await raw.treatmentPlan.create({
      data: { tenantId: clinic.tenantId, patientId: patient },
    });
    const income = (
      locationId: string,
      amount: number,
      currency: string,
      paidAt: string,
      deletedAt?: Date,
    ) =>
      raw.payment.create({
        data: {
          tenantId: clinic.tenantId,
          locationId,
          treatmentPlanId: plan.id,
          patientId: patient,
          amount,
          currency,
          paidAt: new Date(paidAt),
          method: PaymentMethod.CASH,
          deletedAt,
        },
      });
    // Octubre en la sede principal (mediodía de Bogotá = 17:00 UTC).
    await income(loc1, 1000000, 'COP', '2026-10-05T17:00:00Z');
    await income(loc1, 500000.5, 'COP', '2026-10-20T17:00:00Z');
    // Anulado: no cuenta.
    await income(loc1, 999999, 'COP', '2026-10-06T17:00:00Z', new Date());
    // 2026-10-01 03:00Z = 30 sep 22:00 en Bogotá: es septiembre.
    await income(loc1, 200000, 'COP', '2026-10-01T03:00:00Z');
    // Otra sede y otra moneda.
    await income(loc2, 50.25, 'USD', '2026-10-10T17:00:00Z');
    // Sede Norte en Madrid: 23:30Z del 31 oct ya es 1 nov allí (UTC+1) y aún
    // 31 oct en Bogotá, donde está la sede principal: dos zonas en una petición.
    const schedule = await raw.locationSchedule.findFirst({
      where: { locationId: loc2, deletedAt: null },
    });
    if (schedule) {
      await raw.locationSchedule.update({
        where: { id: schedule.id },
        data: { timezone: 'Europe/Madrid' },
      });
    } else {
      await raw.locationSchedule.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: loc2,
          timezone: 'Europe/Madrid',
        },
      });
    }
    await income(loc2, 10, 'USD', '2026-10-31T23:30:00Z');

    await expense({
      category: 'Arriendo',
      amount: 400000,
      invoiceDate: '2026-10-02',
    });
    // Pendiente y pagado a medias cuentan igual: es devengado.
    const partial = await expense({
      category: 'Papelería',
      amount: 100000,
      invoiceDate: '2026-10-15',
      supplier: '=HYPERLINK("http://x")',
      description: 'Resmas y sobres',
    });
    await call('post', `/expenses/${partial}/payments`)
      .send({ amount: 30000, method: 'TRANSFER' })
      .expect(201);
    await expense({
      category: 'Papelería',
      amount: 50000,
      invoiceDate: '2026-10-21',
    });
    await expense({
      category: 'Arriendo',
      amount: 300000,
      invoiceDate: '2026-09-30',
    });
    await expense({
      category: 'Laboratorio',
      amount: 20.5,
      currency: 'USD',
      invoiceDate: '2026-10-11',
      locationId: loc2,
    });
    // Anulado: no cuenta.
    const voided = await expense({
      category: 'Otros',
      amount: 777777,
      invoiceDate: '2026-10-12',
    });
    await call('post', `/expenses/${voided}/void`)
      .send({ reason: 'Registrado por error' })
      .expect(200);
    // Fuera del rango consultado.
    await expense({ invoiceDate: '2026-08-31', amount: 1 });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('resumen', () => {
    it('agrupa por mes, sede y moneda con ingresos, gastos por categoría y neto', async () => {
      const rows = await rowsOf('from=2026-09-01&to=2026-10-31');
      expect(rows.map((r) => [r.month, r.locationName, r.currency])).toEqual([
        ['2026-09', 'Sede principal', 'COP'],
        ['2026-10', 'Sede Norte', 'USD'],
        ['2026-10', 'Sede principal', 'COP'],
      ]);
      const [sep, usd, oct] = rows;
      expect(sep).toMatchObject({
        locationId: loc1,
        income: 200000,
        categories: [{ category: 'Arriendo', amount: 300000 }],
        expensesTotal: 300000,
        net: -100000,
      });
      expect(oct).toMatchObject({
        locationId: loc1,
        income: 1500000.5,
        categories: [
          { category: 'Arriendo', amount: 400000 },
          { category: 'Papelería', amount: 150000 },
        ],
        expensesTotal: 550000,
        net: 950000.5,
      });
      expect(usd).toMatchObject({
        locationId: loc2,
        income: 50.25,
        categories: [{ category: 'Laboratorio', amount: 20.5 }],
        expensesTotal: 20.5,
        net: 29.75,
      });
    });

    it('el rango recorta ambos lados por día civil: solo octubre', async () => {
      const rows = await rowsOf('from=2026-10-01&to=2026-10-31');
      expect(rows.map((r) => [r.month, r.currency, r.income])).toEqual([
        ['2026-10', 'USD', 50.25],
        ['2026-10', 'COP', 1500000.5],
      ]);
    });

    it('un solo día vale (from = to)', async () => {
      const rows = await rowsOf('from=2026-10-02&to=2026-10-02');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ income: 0, expensesTotal: 400000 });
    });

    it('filtra por sede (parámetro y cabecera) y una sede ajena no devuelve nada', async () => {
      const norte = await rowsOf(
        `from=2026-09-01&to=2026-10-31&locationId=${loc2}`,
      );
      expect(norte.map((r) => r.locationId)).toEqual([loc2]);
      expect(await rowsOf('from=2026-09-01&to=2026-10-31', loc2)).toEqual(
        norte,
      );
      const foreign = await call(
        'get',
        `/locations`,
        other.adminToken,
        other.host,
      ).expect(200);
      const foreignId = (foreign.body as { id: string }[])[0].id;
      expect(
        await rowsOf(`from=2026-09-01&to=2026-10-31&locationId=${foreignId}`),
      ).toEqual([]);
    });

    it('con sedes en zonas distintas, cada abono cuenta en el mes de SU sede', async () => {
      const rows = await rowsOf('from=2026-10-01&to=2026-11-30');
      const key = (r: SummaryRow) =>
        `${r.month} ${r.locationName} ${r.currency}`;
      const byKey = new Map(rows.map((r) => [key(r), r.income]));
      // Norte (Madrid): 1 nov. La principal (Bogotá) sigue en octubre.
      expect(byKey.get('2026-11 Sede Norte USD')).toBe(10);
      expect(byKey.get('2026-10 Sede Norte USD')).toBe(50.25);
      expect(byKey.get('2026-10 Sede principal COP')).toBe(1500000.5);
    });

    it('/expenses/summary no cae en :id (la ruta fija va antes)', async () => {
      const res = await summary('from=2026-10-01&to=2026-10-31').expect(200);
      expect((res.body as SummaryBody).rows.length).toBeGreaterThan(0);
    });

    it('sin movimientos, lista vacía', async () => {
      expect(await rowsOf('from=2025-01-01&to=2025-01-31')).toEqual([]);
    });

    it('periodo inválido o de más de 366 días es 400 en español', async () => {
      for (const query of [
        '',
        'from=2026-10-31&to=2026-10-01',
        'from=2026-02-30&to=2026-03-01',
        'from=ayer&to=hoy',
      ]) {
        const res = await summary(query).expect(400);
        expect(JSON.stringify(res.body)).toContain(
          SUMMARY_PERIOD_INVALID_MESSAGE,
        );
      }
      const long = await summary('from=2026-01-01&to=2027-01-02').expect(400);
      expect((long.body as { message: string }).message).toBe(
        SUMMARY_PERIOD_TOO_LONG_MESSAGE,
      );
      await summary('from=2026-01-01&to=2027-01-01').expect(200);
    });

    it('otra clínica no ve estos números', async () => {
      const res = await call(
        'get',
        '/expenses/summary?from=2026-09-01&to=2026-10-31',
        other.adminToken,
        other.host,
      ).expect(200);
      expect((res.body as SummaryBody).rows).toEqual([]);
    });

    it('solo ADMIN: recepción y odontólogo reciben 403', async () => {
      for (const role of [ClinicRole.RECEPTION, ClinicRole.DENTIST]) {
        for (const url of [
          '/expenses/summary?from=2026-10-01&to=2026-10-31',
          '/expenses/summary.csv?from=2026-10-01&to=2026-10-31',
          '/expenses.csv',
        ]) {
          await call('get', url, tokens[role]).expect(403);
        }
      }
    });

    it('audita la consulta como VIEW/EXPENSE_SUMMARY sin datos libres', async () => {
      await summary('from=2026-10-01&to=2026-10-31').expect(200);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'EXPENSE',
          action: 'VIEW',
        },
      });
      expect(
        events.some(
          (e) =>
            (e.metadata as { reason?: string } | null)?.reason ===
            'EXPENSE_SUMMARY',
        ),
      ).toBe(true);
    });
  });

  describe('CSV', () => {
    it('resumen: BOM, CRLF, cabeceras y decimales por moneda', async () => {
      const res = await csv(
        '/expenses/summary.csv?from=2026-09-01&to=2026-10-31',
      ).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="gastos-resumen-2026-09-01-2026-10-31.csv"',
      );
      const text = res.body as string;
      expect(text.startsWith('﻿')).toBe(true);
      const lines = text.slice(1).split('\r\n');
      expect(lines[0]).toBe('Mes,Sede,Moneda,Concepto,Categoría,Importe');
      expect(lines.at(-1)).toBe('');
      // COP sin decimales (1 500 000,50 se redondea); USD a céntimos.
      expect(lines).toContain(
        '2026-10,"Sede principal",COP,Ingresos,"",1500001',
      );
      expect(lines).toContain('2026-10,"Sede Norte",USD,Ingresos,"",50.25');
      expect(lines).toContain(
        '2026-10,"Sede Norte",USD,Gasto,"Laboratorio",20.50',
      );
      expect(lines).toContain('2026-10,"Sede Norte",USD,Neto,"",29.75');
    });

    it('resumen: un periodo inválido es 400 y no deja fichero', async () => {
      await csv('/expenses/summary.csv?from=2027-01-01&to=2026-01-01').expect(
        400,
      );
    });

    it('gastos: mismas filas que la lista, estado en español y anti-fórmulas', async () => {
      const res = await csv(
        '/expenses.csv?from=2026-10-01&to=2026-10-31',
      ).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="gastos-2026-10-01-2026-10-31.csv"',
      );
      const text = res.body as string;
      expect(text.startsWith('﻿')).toBe(true);
      const lines = text.slice(1).split('\r\n');
      expect(lines[0]).toContain('Fecha de factura,Vencimiento,Sede,Categoría');
      // 5 gastos de octubre (incluido el anulado) + cabecera + línea final.
      expect(lines).toHaveLength(7);
      const hyper = lines.find((l) => l.includes('HYPERLINK'))!;
      expect(hyper).toContain(`"'=HYPERLINK(""http://x"")"`);
      expect(hyper).toContain('"Resmas y sobres"');
      expect(hyper).toMatch(/,COP,100000,30000,70000,Parcial,No$/);
      expect(lines.some((l) => l.endsWith(',Anulado,No'))).toBe(true);
      expect(
        lines.some((l) => /,USD,20\.50,0\.00,20\.50,Pendiente,No$/.test(l)),
      ).toBe(true);
    });

    it('gastos: respeta los filtros de la lista', async () => {
      const res = await csv(
        '/expenses.csv?status=PARTIAL&category=papeleria',
      ).expect(200);
      expect((res.body as string).slice(1).split('\r\n')).toHaveLength(3);
    });

    it('gastos: filtros inválidos son 400', async () => {
      await csv('/expenses.csv?from=2026-10-31&to=2026-10-01').expect(400);
      await csv('/expenses.csv?status=NADA').expect(400);
    });

    it('audita las descargas como EXPORT/EXPENSE sin contenido', async () => {
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'EXPENSE',
          action: 'EXPORT',
        },
      });
      const reasons = events.map(
        (e) => (e.metadata as { reason?: string } | null)?.reason,
      );
      expect(reasons).toEqual(
        expect.arrayContaining(['EXPENSE_SUMMARY', 'EXPENSE_LIST']),
      );
      expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(
        'HYPERLINK',
      );
    });
  });
});
