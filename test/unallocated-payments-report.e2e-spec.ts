import { randomUUID } from 'node:crypto';
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
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  locationBody,
  REGIONAL_TOKYO_FIXTURE,
} from './support/location-fixtures';

// DX-399 · «Cobrado sin imputar / a cuenta» (GET /reports/unallocated-payments
// y su CSV). Todo se siembra por la API real (planes, ítems, abonos, anulación,
// reasignación); lo único crudo es mover un abono de instante y lo que se lee
// para comprobar la equivalencia con `payment_allocations`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Row {
  paymentId: string;
  patient: { id: string; fullName: string };
  location: { id: string; name: string };
  paidOn: string;
  paymentAmount: number;
  paymentCurrency: string;
  planId: string;
  planCurrency: string;
  allocated: number;
  unallocated: number;
}
interface Page {
  from: string;
  to: string;
  filters: { locationId: string | null; locationName: string | null };
  options: { locations: { id: string; name: string }[] };
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  totals: {
    currency: string;
    count: number;
    allocated: number;
    unallocated: number;
  }[];
  paymentsWithoutRateCount: number;
}

const TEETH = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28];
const PERIOD = 'from=2026-10-01&to=2026-10-31';
let toothSeq = 0;

describe('Cobrado sin imputar / a cuenta (e2e, DX-399)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let catalogA: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let norteOnlyToken: string;
  const patients: Record<string, string> = {};
  const pays: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const call = (
    verb: 'get' | 'post' | 'patch' | 'put' | 'delete',
    clinic: Clinic,
    path: string,
    token = clinic.adminToken,
    locationId?: string,
  ) => {
    const req = request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return locationId ? req.set('X-Location-Id', locationId) : req;
  };

  async function patient(clinic: Clinic, name: string): Promise<string> {
    return (
      await raw.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: name,
          lastName: 'Cuenta',
          docNumber: `DX399-${clinic.subdomain}-${name}`,
          countryCode: 'VE',
        },
        select: { id: true },
      })
    ).id;
  }

  async function catalog(clinic: Clinic): Promise<string> {
    const res = await call('post', clinic, '/catalog/items')
      .send({
        code: 'DX399-RESINA',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function plan(
    clinic: Clinic,
    patientId: string,
    catalogItemId: string,
    prices: number[],
    currency = 'USD',
  ): Promise<{ planId: string; items: string[] }> {
    const created = await call(
      'post',
      clinic,
      `/patients/${patientId}/treatment-plans`,
    )
      .send({ currency })
      .expect(201);
    const planId = (created.body as { id: string }).id;
    const items: string[] = [];
    for (const price of prices) {
      const item = await call(
        'post',
        clinic,
        `/treatment-plans/${planId}/items`,
      )
        .send({
          toothNumber: String(TEETH[toothSeq++ % TEETH.length]),
          catalogItemId,
          price,
        })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call('patch', clinic, `/treatment-plans/${planId}/items/${itemId}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);
      items.push(itemId);
    }
    return { planId, items };
  }

  async function pay(
    clinic: Clinic,
    planId: string,
    amount: number,
    paidAt: string,
    opts: { currency?: string; locationId?: string } = {},
  ): Promise<string> {
    const res = await call(
      'post',
      clinic,
      `/treatment-plans/${planId}/payments`,
      clinic.adminToken,
      opts.locationId ?? principal,
    )
      .send({
        amount,
        currency: opts.currency ?? 'USD',
        paidAt,
        method: 'TRANSFER',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const report = async (
    clinic: Clinic,
    query = PERIOD,
    token = clinic.adminToken,
  ): Promise<Page> =>
    (
      await call(
        'get',
        clinic,
        `/reports/unallocated-payments?${query}`,
        token,
      ).expect(200)
    ).body as Page;
  const idsOf = (page: Page) => page.items.map((r) => r.paymentId);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    // GBP no tiene tasa los días del test: sus abonos quedan «sin tasa».
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: ['2026-10-12', '2026-10-13'] } },
    });
    a = await registerClinic(app, 'dx399-a');
    b = await registerClinic(app, 'dx399-b');
    const sedes = (await call('get', a, '/locations').expect(200)).body as {
      id: string;
    }[];
    principal = sedes[0].id;
    norte = (
      (
        await call('post', a, '/locations')
          .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Sede Norte' }))
          .expect(201)
      ).body as { id: string }
    ).id;
    catalogA = await catalog(a);

    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const { email } = await seedMember(raw, a, role);
      const token = await loginAs(app, a.host, email);
      if (role === ClinicRole.RECEPTION) receptionToken = token;
      if (role === ClinicRole.DENTIST) dentistToken = token;
      if (role === ClinicRole.ASSISTANT) assistantToken = token;
    }
    const restricted = await raw.user.create({
      data: {
        email: 'norte@dx399-a.test',
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
        fullName: 'Recepción Norte',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: restricted.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await call('put', a, `/staff/${restricted.id}/locations`)
      .send({ locationIds: [norte] })
      .expect(200);
    norteOnlyToken = await loginAs(app, a.host, 'norte@dx399-a.test');

    patients.ana = await patient(a, 'Ana');
    patients.beto = await patient(a, 'Beto');
    patients.cata = await patient(a, 'Cata');

    // Ana: plan de 100; abona 130 el 20/10 -> 100 imputado, 30 a cuenta.
    const anaPlan = await plan(a, patients.ana, catalogA, [100]);
    pays.overpaid = await pay(a, anaPlan.planId, 130, '2026-10-20');
    // Ana: otro plan de 50 pagado exacto -> nada a cuenta, fuera del informe.
    const exact = await plan(a, patients.ana, catalogA, [50]);
    pays.exact = await pay(a, exact.planId, 50, '2026-10-20');
    // Beto: plan de 80 con abono de 60 en Sede Norte, y luego un ADMIN lo
    // fija a mano sin ninguna línea -> los 60 quedan a cuenta.
    const betoPlan = await plan(a, patients.beto, catalogA, [80]);
    pays.manualEmpty = await pay(a, betoPlan.planId, 60, '2026-10-18', {
      locationId: norte,
    });
    const version = (
      (
        await call(
          'get',
          a,
          `/payments/${pays.manualEmpty}/allocations`,
        ).expect(200)
      ).body as { version: string }
    ).version;
    await call('put', a, `/payments/${pays.manualEmpty}/allocations`)
      .send({ expectedVersion: version, mode: 'MANUAL', allocations: [] })
      .expect(200);
    // Cata: abono fuera del período (septiembre), uno anulado y uno de un plan cancelado.
    const cataPlan = await plan(a, patients.cata, catalogA, [40]);
    pays.september = await pay(a, cataPlan.planId, 90, '2026-09-10');
    pays.voided = await pay(a, cataPlan.planId, 90, '2026-10-05');
    await call('delete', a, `/payments/${pays.voided}`)
      .send({ reason: 'Registrado por error' })
      .expect(200);
    const cancelled = await plan(a, patients.cata, catalogA, [40]);
    pays.cancelled = await pay(a, cancelled.planId, 70, '2026-10-06');
    await call('patch', a, `/treatment-plans/${cancelled.planId}`)
      .send({ status: 'CANCELLED' })
      .expect(200);
    // Cata: un abono en GBP sin tasa -> no tiene base: se cuenta aparte.
    pays.noRate = await pay(a, cataPlan.planId, 25, '2026-10-12', {
      currency: 'GBP',
    });

    // Clínica B: su propio abono de más, que A nunca ve.
    const pb = await patient(b, 'Zoe');
    const catalogB = await catalog(b);
    const bPlan = await plan(b, pb, catalogB, [10]);
    pays.b = await pay(b, bPlan.planId, 99, '2026-10-20', {
      locationId: (
        (await call('get', b, '/locations').expect(200)).body as {
          id: string;
        }[]
      )[0].id,
    });
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('lists only the live, billable, in-period payments with something unallocated', async () => {
    const page = await report(a);
    expect(new Set(idsOf(page))).toEqual(
      new Set([pays.overpaid, pays.manualEmpty]),
    );
    // Del más reciente al más antiguo.
    expect(idsOf(page)).toEqual([pays.overpaid, pays.manualEmpty]);
    const overpaid = page.items[0];
    expect(overpaid).toMatchObject({
      patient: { id: patients.ana, fullName: 'Ana Cuenta' },
      location: { id: principal },
      paidOn: '2026-10-20',
      paymentAmount: 130,
      paymentCurrency: 'USD',
      planCurrency: 'USD',
      allocated: 100,
      unallocated: 30,
    });
    expect(page.items[1]).toMatchObject({
      location: { id: norte, name: 'Sede Norte' },
      paymentAmount: 60,
      allocated: 0,
      unallocated: 60,
    });
    expect(page.totals).toEqual([
      { currency: 'USD', count: 2, allocated: 100, unallocated: 90 },
    ]);
    expect(page.total).toBe(2);
    expect(page.paymentsWithoutRateCount).toBe(1);
    expect(page.options.locations.map((l) => l.id).sort()).toEqual(
      [principal, norte].sort(),
    );
  });

  it('equivalence: every figure matches payment_allocations and GET /payments/:id/allocations', async () => {
    const page = await report(a);
    for (const row of page.items) {
      const lines = await raw.paymentAllocation.findMany({
        where: { paymentId: row.paymentId },
      });
      const allocated = lines.reduce(
        (n, l) => n + Math.round(Number(l.amount) * 100),
        0,
      );
      expect(Math.round(row.allocated * 100)).toBe(allocated);
      const detail = (
        await call('get', a, `/payments/${row.paymentId}/allocations`).expect(
          200,
        )
      ).body as { allocated: number; unallocated: number; planAmount: number };
      expect(detail.allocated).toBe(row.allocated);
      expect(detail.unallocated).toBe(row.unallocated);
      expect(row.allocated + row.unallocated).toBeCloseTo(detail.planAmount, 2);
    }
    const sum = (k: 'allocated' | 'unallocated') =>
      Math.round(page.items.reduce((n, r) => n + r[k] * 100, 0)) / 100;
    expect(page.totals[0].allocated).toBe(sum('allocated'));
    expect(page.totals[0].unallocated).toBe(sum('unallocated'));
  });

  it('filters by date (civil days) and by sede', async () => {
    expect(idsOf(await report(a, 'from=2026-10-19&to=2026-10-31'))).toEqual([
      pays.overpaid,
    ]);
    expect(idsOf(await report(a, 'from=2026-10-18&to=2026-10-18'))).toEqual([
      pays.manualEmpty,
    ]);
    expect(idsOf(await report(a, 'from=2026-09-01&to=2026-09-30'))).toEqual([
      pays.september,
    ]);
    const bySede = await report(a, `${PERIOD}&locationId=${norte}`);
    expect(idsOf(bySede)).toEqual([pays.manualEmpty]);
    expect(bySede.filters).toEqual({
      locationId: norte,
      locationName: 'Sede Norte',
    });
    expect(bySede.totals).toEqual([
      { currency: 'USD', count: 1, allocated: 0, unallocated: 60 },
    ]);
  });

  it('cuts the day at the sede zone: the same instant is the 20th in Caracas and the 21st in Tokyo', async () => {
    // 2026-10-21T02:30Z = 20/10 22:30 en Caracas (UTC−4) = 21/10 11:30 en Tokio (UTC+9).
    const instant = new Date('2026-10-21T02:30:00.000Z');
    await raw.payment.updateMany({
      where: { id: { in: [pays.overpaid, pays.manualEmpty] } },
      data: { paidAt: instant },
    });
    try {
      const upTo20 = await report(a, 'from=2026-10-20&to=2026-10-20');
      expect(idsOf(upTo20)).toEqual([pays.overpaid]);
      expect(upTo20.items[0].paidOn).toBe('2026-10-20');
      const on21 = await report(a, 'from=2026-10-21&to=2026-10-21');
      expect(idsOf(on21)).toEqual([pays.manualEmpty]);
      expect(on21.items[0].paidOn).toBe('2026-10-21');
    } finally {
      await raw.payment.update({
        where: { id: pays.overpaid },
        data: { paidAt: new Date('2026-10-20T16:00:00.000Z') },
      });
      await raw.payment.update({
        where: { id: pays.manualEmpty },
        data: { paidAt: new Date('2026-10-18T03:00:00.000Z') },
      });
    }
  });

  it('paginates and totals cover every row, not only the page', async () => {
    const first = await report(a, `${PERIOD}&pageSize=1&page=1`);
    const second = await report(a, `${PERIOD}&pageSize=1&page=2`);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.items[0].paymentId).not.toBe(second.items[0].paymentId);
    expect(first.totals).toEqual(second.totals);
    expect(first.totals[0].unallocated).toBe(90);
  });

  it('a payment becomes fully allocated and leaves the report (live recompute)', async () => {
    const extra = await plan(a, patients.ana, catalogA, [40]);
    const id = await pay(a, extra.planId, 70, '2026-10-22');
    expect(idsOf(await report(a))).toContain(id);
    // Se acepta otro ítem de 30: el reparto automático cubre el sobrante.
    const item = await call('post', a, `/treatment-plans/${extra.planId}/items`)
      .send({
        toothNumber: String(TEETH[toothSeq++ % TEETH.length]),
        catalogItemId: catalogA,
        price: 30,
      })
      .expect(201);
    await call(
      'patch',
      a,
      `/treatment-plans/${extra.planId}/items/${(item.body as { id: string }).id}`,
    )
      .send({ status: 'ACCEPTED' })
      .expect(200);
    expect(idsOf(await report(a))).not.toContain(id);
  });

  describe('CSV', () => {
    it('downloads the same rows with BOM, no-store and a dated file name', async () => {
      const res = await call(
        'get',
        a,
        `/reports/unallocated-payments.csv?${PERIOD}`,
        receptionToken,
      ).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(
        'cobrado-sin-imputar-2026-10-01-2026-10-31.csv',
      );
      expect(res.headers['cache-control']).toBe('no-store');
      const text = res.text;
      expect(text.startsWith('\uFEFF')).toBe(true);
      const lines = text.slice(1).trim().split('\r\n');
      expect(
        lines.some(
          (l) =>
            l.startsWith('"Abono","Ana Cuenta",') &&
            l.endsWith('"2026-10-20","USD",130.00,"USD",100.00,30.00'),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.startsWith('"Total","2 abonos"'))).toBe(true);
      expect(lines.at(-1)).toBe(
        '"Total","2 abonos","","","",,"USD",100.00,90.00',
      );
    });

    it('filters by sede like the screen', async () => {
      const res = await call(
        'get',
        a,
        `/reports/unallocated-payments.csv?${PERIOD}&locationId=${norte}`,
      ).expect(200);
      expect(res.text).toContain('"Sede","Sede Norte"');
      expect(res.text).toContain('Beto Cuenta');
      expect(res.text).not.toContain('Ana Cuenta');
    });
  });

  describe('net of credit refunded or transferred out (DX-253, round 1)', () => {
    const AUGUST = 'from=2026-08-01&to=2026-08-31';
    const creditPatients: Record<string, string> = {};

    const refund = (planId: string, paymentIds: string[], amount: number) =>
      call(
        'post',
        a,
        `/treatment-plans/${planId}/credit-refunds`,
        a.adminToken,
        principal,
      )
        .send({
          amount,
          currency: 'USD',
          method: 'TRANSFER',
          reason: 'El paciente se muda de ciudad',
          paymentIds,
        })
        .expect(201);
    const unallocatedOf = async (query = AUGUST) =>
      new Map(
        (await report(a, query)).items.map((r) => [r.paymentId, r.unallocated]),
      );

    /**
     * Referencia independiente sobre las tablas crudas (no usa `credit-netting`):
     * por plan cobrable, cada salida en orden cronológico gasta primero lo
     * recibido por traspaso (TRANSFER_IN, sin mirar su fecha, DX-399-ter) y
     * después el excedente de los abonos registrados ANTES que ella, del
     * `paidAt` más reciente al más antiguo (DX-399/DX-399-bis). No depende del
     * orden de los tests: vale con cualquier dato del tenant.
     */
    async function expectedNet(): Promise<Map<string, number>> {
      const cents = (v: unknown) => Math.round(Number(v) * 100);
      const livePatients = await raw.patient.findMany({
        where: { tenantId: a.tenantId, deletedAt: null },
        select: { id: true },
      });
      const payments = await raw.payment.findMany({
        where: {
          tenantId: a.tenantId,
          deletedAt: null,
          treatmentPlanId: { not: null },
          plan: {
            status: { notIn: ['CANCELLED', 'REJECTED'] },
            deletedAt: null,
          },
          patientId: { in: livePatients.map((x) => x.id) },
        },
        select: {
          id: true,
          treatmentPlanId: true,
          paidAt: true,
          createdAt: true,
        },
      });
      const left = new Map<string, number>();
      for (const p of payments) {
        const base = await raw.paymentPlanAmount.findUnique({
          where: { paymentId: p.id },
        });
        if (!base) continue;
        const alloc = await raw.paymentAllocation.findMany({
          where: { paymentId: p.id },
        });
        const un =
          cents(base.amount) - alloc.reduce((n, l) => n + cents(l.amount), 0);
        if (un > 0) left.set(p.id, un);
      }
      const entries = await raw.patientCreditEntry.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const received = new Map<string, number>();
      for (const e of entries) {
        if (e.kind === 'TRANSFER_IN') {
          received.set(
            e.treatmentPlanId,
            (received.get(e.treatmentPlanId) ?? 0) + cents(e.amount),
          );
        }
      }
      for (const e of entries) {
        if (e.kind === 'TRANSFER_IN') continue;
        let out = -cents(e.amount);
        const fromTransfers = Math.min(
          out,
          received.get(e.treatmentPlanId) ?? 0,
        );
        received.set(
          e.treatmentPlanId,
          (received.get(e.treatmentPlanId) ?? 0) - fromTransfers,
        );
        out -= fromTransfers;
        const candidates = payments
          .filter(
            (p) =>
              p.treatmentPlanId === e.treatmentPlanId &&
              left.has(p.id) &&
              p.createdAt.getTime() <= e.createdAt.getTime(),
          )
          .sort(
            (x, y) =>
              y.paidAt.getTime() - x.paidAt.getTime() ||
              y.createdAt.getTime() - x.createdAt.getTime() ||
              (x.id < y.id ? 1 : -1),
          );
        for (const p of candidates) {
          if (out <= 0) break;
          const take = Math.min(out, left.get(p.id) as number);
          left.set(p.id, (left.get(p.id) as number) - take);
          out -= take;
        }
      }
      return new Map([...left].filter(([, v]) => v > 0));
    }

    /** El informe del año entero = la referencia, y cada fila = el detalle de su abono. */
    async function expectEquivalence(): Promise<void> {
      const expected = await expectedNet();
      const page = await report(
        a,
        'from=2026-01-01&to=2026-12-31&pageSize=100',
      );
      const listed = new Map(
        page.items.map((r) => [r.paymentId, Math.round(r.unallocated * 100)]),
      );
      expect(listed).toEqual(expected);
      for (const row of page.items) {
        const detail = (
          await call('get', a, `/payments/${row.paymentId}/allocations`).expect(
            200,
          )
        ).body as { onAccount: number };
        expect(detail.onAccount).toBe(row.unallocated);
      }
    }

    beforeAll(async () => {
      for (const name of ['Dora', 'Eva', 'Fede', 'Gina', 'Hugo', 'Ines']) {
        creditPatients[name] = await patient(a, name);
      }
    });

    it('a partial refund reduces the row; a total refund removes it', async () => {
      const dora = await plan(a, creditPatients.Dora, catalogA, [100]);
      const doraPay = await pay(a, dora.planId, 130, '2026-08-05');
      const eva = await plan(a, creditPatients.Eva, catalogA, [100]);
      const evaPay = await pay(a, eva.planId, 130, '2026-08-06');
      expect(await unallocatedOf()).toEqual(
        new Map([
          [evaPay, 30],
          [doraPay, 30],
        ]),
      );

      await refund(dora.planId, [doraPay], 10);
      expect(await unallocatedOf()).toEqual(
        new Map([
          [evaPay, 30],
          [doraPay, 20],
        ]),
      );
      // El detalle del abono dice lo mismo: sin imputar a ítems 30, devuelto 10, a cuenta 20.
      const detail = (
        await call('get', a, `/payments/${doraPay}/allocations`).expect(200)
      ).body as { unallocated: number; creditOut: number; onAccount: number };
      expect(detail).toMatchObject({
        unallocated: 30,
        creditOut: 10,
        onAccount: 20,
      });
      const page = await report(a, AUGUST);
      expect(page.totals).toEqual([
        { currency: 'USD', count: 2, allocated: 200, unallocated: 50 },
      ]);

      await refund(eva.planId, [evaPay], 30);
      expect(await unallocatedOf()).toEqual(new Map([[doraPay, 20]]));
      await refund(dora.planId, [doraPay], 20);
      expect((await report(a, AUGUST)).items).toEqual([]);
    });

    it('a transfer out removes the money from the source row', async () => {
      const fede = await plan(a, creditPatients.Fede, catalogA, [100]);
      const fedePay = await pay(a, fede.planId, 130, '2026-08-07');
      const target = await plan(a, creditPatients.Fede, catalogA, [50]);
      expect((await unallocatedOf()).get(fedePay)).toBe(30);
      await call(
        'post',
        a,
        `/treatment-plans/${fede.planId}/credit-transfers`,
        a.adminToken,
        principal,
      )
        .send({ targetPlanId: target.planId, amount: 30, currency: 'USD' })
        .expect(201);
      expect((await unallocatedOf()).has(fedePay)).toBe(false);
    });

    it('applies the refund to the most recent payments first, never below 0', async () => {
      const gina = await plan(a, creditPatients.Gina, catalogA, [50]);
      const older = await pay(a, gina.planId, 40, '2026-08-10');
      const newer = await pay(a, gina.planId, 40, '2026-08-11');
      for (const id of [older, newer]) {
        const { version } = (
          await call('get', a, `/payments/${id}/allocations`).expect(200)
        ).body as { version: string };
        await call('put', a, `/payments/${id}/allocations`)
          .send({ expectedVersion: version, mode: 'MANUAL', allocations: [] })
          .expect(200);
      }
      expect(await unallocatedOf()).toEqual(
        new Map([
          [newer, 40],
          [older, 40],
        ]),
      );
      // Las dos quedaron a cuenta (80) con un plan de 50: hay 30 de saldo a favor.
      await refund(gina.planId, [older, newer], 30);
      expect(await unallocatedOf()).toEqual(
        new Map([
          [newer, 10],
          [older, 40],
        ]),
      );
    });

    it('equivalence: every live payment matches the reference, and the excluded ones have nothing unallocated net of credit', async () => {
      await expectEquivalence();
    });

    it('a VES payment to a USD plan is listed in the plan currency with its own amount', async () => {
      await raw.exchangeRateSnapshot.deleteMany({
        where: { date: '2026-08-12' },
      });
      await raw.exchangeRateSnapshot.create({
        data: { date: '2026-08-12', currency: 'VES', rate: 40 },
      });
      const hugo = await plan(a, creditPatients.Hugo, catalogA, [60]);
      const id = await pay(a, hugo.planId, 4000, '2026-08-12', {
        currency: 'VES',
      });
      const row = (await report(a, AUGUST)).items.find(
        (r) => r.paymentId === id,
      );
      expect(row).toMatchObject({
        paymentAmount: 4000,
        paymentCurrency: 'VES',
        planCurrency: 'USD',
        allocated: 60,
        unallocated: 40,
      });
      await raw.exchangeRateSnapshot.deleteMany({
        where: { date: '2026-08-12' },
      });
    });

    it('excludes a migrated-balance payment and a deleted patient', async () => {
      const batch = await raw.patientImportBatch.create({
        data: {
          tenantId: a.tenantId,
          createdById: a.adminUserId,
          locationId: principal,
          fileName: 'saldos.csv',
          fileSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          fileFormat: 'CSV',
          fileSizeBytes: 10,
          columnMapping: {},
          totalRows: 1,
          validRows: 1,
          duplicateRows: 0,
          errorRows: 0,
          preparedRows: 1,
        },
      });
      const opening = await raw.openingBalance.create({
        data: {
          tenantId: a.tenantId,
          locationId: principal,
          patientId: creditPatients.Ines,
          importBatchId: batch.id,
          currency: 'USD',
          amount: 500,
          asOfDate: new Date('2026-07-01T00:00:00.000Z'),
          concept: 'Saldo anterior',
          createdById: a.adminUserId,
        },
      });
      const migrated = (
        await call(
          'post',
          a,
          `/opening-balances/${opening.id}/payments`,
          a.adminToken,
          principal,
        )
          .send({
            amount: 100,
            currency: 'USD',
            paidAt: '2026-08-14',
            method: 'CASH',
          })
          .expect(201)
      ).body as { id: string };
      expect(idsOf(await report(a, AUGUST))).not.toContain(migrated.id);

      const gone = await patient(a, 'Borrada');
      const gonePlan = await plan(a, gone, catalogA, [10]);
      const gonePay = await pay(a, gonePlan.planId, 50, '2026-08-15');
      expect(idsOf(await report(a, AUGUST))).toContain(gonePay);
      await raw.patient.update({
        where: { id: gone },
        data: { deletedAt: new Date() },
      });
      expect(idsOf(await report(a, AUGUST))).not.toContain(gonePay);
    });

    it('a same-currency payment without a base is not a missing rate; a foreign-currency one is', async () => {
      const before = (await report(a, AUGUST)).paymentsWithoutRateCount;
      // Un abono en la moneda del plan al que se le quita la base (espera al barrido).
      const wait = await plan(a, creditPatients.Ines, catalogA, [10]);
      const waiting = await pay(a, wait.planId, 20, '2026-08-16');
      await raw.paymentAllocation.deleteMany({ where: { paymentId: waiting } });
      await raw.paymentPlanAmount.delete({ where: { paymentId: waiting } });
      expect(
        await raw.paymentPlanAmount.count({ where: { paymentId: waiting } }),
      ).toBe(0);
      expect((await report(a, AUGUST)).paymentsWithoutRateCount).toBe(before);
      // Control positivo: uno en GBP, sin tasa ese día, sí cuenta.
      await pay(a, wait.planId, 5, '2026-08-17', { currency: 'GBP' });
      expect((await report(a, AUGUST)).paymentsWithoutRateCount).toBe(
        before + 1,
      );
    });

    it('DX-399-bis: a MANUAL allocation cannot pin the refunded money either (Spanish 400, nothing written)', async () => {
      const mara = await patient(a, 'Mara');
      const maraPlan = await plan(a, mara, catalogA, [100]);
      const old = await pay(a, maraPlan.planId, 130, '2026-09-15');
      await refund(maraPlan.planId, [old], 30);
      const item = await call(
        'post',
        a,
        `/treatment-plans/${maraPlan.planId}/items`,
      )
        .send({ toothNumber: '32', catalogItemId: catalogA, price: 30 })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call(
        'patch',
        a,
        `/treatment-plans/${maraPlan.planId}/items/${itemId}`,
      )
        .send({ status: 'ACCEPTED' })
        .expect(200);
      const { version } = (
        await call('get', a, `/payments/${old}/allocations`).expect(200)
      ).body as { version: string };
      const put = (cents: [string, number][]) =>
        call('put', a, `/payments/${old}/allocations`).send({
          expectedVersion: version,
          mode: 'MANUAL',
          allocations: cents.map(([id, amount]) => ({
            treatmentPlanItemId: id,
            amount,
          })),
        });
      const res = await put([
        [maraPlan.items[0], 100],
        [itemId, 30],
      ]).expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /ya se devolvieron o traspasaron del saldo a favor \(máximo .*100/,
      );
      // Nada se escribió: el abono sigue en sus 100 AUTO y el informe no lo lista.
      const rows = await raw.paymentAllocation.findMany({
        where: { paymentId: old },
      });
      expect(rows.map((r) => Number(r.amount))).toEqual([100]);
      expect(rows.every((r) => r.source === 'AUTO')).toBe(true);
      // Lo que queda a cuenta sí se puede fijar a mano.
      await put([[maraPlan.items[0], 100]]).expect(200);
    });

    it('a refund only nets payments registered BEFORE it: overpay, refund, then a later payment', async () => {
      const jana = await patient(a, 'Jana');
      const janaPlan = await plan(a, jana, catalogA, [100]);
      const first = await pay(a, janaPlan.planId, 130, '2026-06-10');
      await refund(janaPlan.planId, [first], 30);
      const second = await pay(a, janaPlan.planId, 50, '2026-07-10');
      const june = await unallocatedOf('from=2026-06-01&to=2026-06-30');
      const july = await unallocatedOf('from=2026-07-01&to=2026-07-31');
      expect(june.has(first)).toBe(false);
      expect(july.get(second)).toBe(50);
    });

    it('DX-399-bis: overpay, refund, a new item and its payment leave nothing on account (report = Cartera = 0)', async () => {
      const lola = await patient(a, 'Lola');
      const lolaPlan = await plan(a, lola, catalogA, [100]);
      const old = await pay(a, lolaPlan.planId, 130, '2026-09-05');
      await refund(lolaPlan.planId, [old], 30);
      // Un ítem nuevo de 30: la imputación automática NO puede cubrirlo con los
      // 30 del abono antiguo, que ya se devolvieron.
      const item = await call(
        'post',
        a,
        `/treatment-plans/${lolaPlan.planId}/items`,
      )
        .send({ toothNumber: '31', catalogItemId: catalogA, price: 30 })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call(
        'patch',
        a,
        `/treatment-plans/${lolaPlan.planId}/items/${itemId}`,
      )
        .send({ status: 'ACCEPTED' })
        .expect(200);
      const fresh = await pay(a, lolaPlan.planId, 30, '2026-09-06');

      const SEPT = 'from=2026-09-01&to=2026-09-30';
      const sept = await report(a, SEPT);
      expect(idsOf(sept)).not.toContain(old);
      expect(idsOf(sept)).not.toContain(fresh);
      // Cartera › Saldo a favor: Lola no tiene saldo.
      const credit = (
        await call(
          'get',
          a,
          '/receivables/credit-balances?pageSize=100',
        ).expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(credit.items.map((r) => r.patient.id)).not.toContain(lola);
      // El abono nuevo cubre el ítem nuevo; el antiguo sigue en sus 100.
      const sumOf = (rows: { amount: unknown }[]) =>
        rows.reduce((n, l) => n + Math.round(Number(l.amount) * 100), 0);
      expect(
        sumOf(
          await raw.paymentAllocation.findMany({ where: { paymentId: old } }),
        ),
      ).toBe(10000);
      expect(
        sumOf(
          await raw.paymentAllocation.findMany({ where: { paymentId: fresh } }),
        ),
      ).toBe(3000);
    });
    it('DX-399-ter: own surplus, a transfer in, a refund of 30 and a new item: the item is covered, nothing pending, and the statement says the same as the report and Cartera', async () => {
      const mia = await patient(a, 'Mia');
      // Plan P: ítem de 70 y abono de 100 -> 30 propios a cuenta.
      const p = await plan(a, mia, catalogA, [70]);
      const own = await pay(a, p.planId, 100, '2026-09-10');
      // Plan Q del mismo paciente con 30 a cuenta, que se traspasan a P.
      const q = await plan(a, mia, catalogA, [20]);
      await pay(a, q.planId, 50, '2026-09-10');
      await call(
        'post',
        a,
        `/treatment-plans/${q.planId}/credit-transfers`,
        a.adminToken,
        principal,
      )
        .send({ targetPlanId: p.planId, amount: 30, currency: 'USD' })
        .expect(201);
      // Se devuelven 30 de P: salen de lo recibido por traspaso.
      await refund(p.planId, [own], 30);
      const item = await call('post', a, `/treatment-plans/${p.planId}/items`)
        .send({ toothNumber: '32', catalogItemId: catalogA, price: 30 })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call('patch', a, `/treatment-plans/${p.planId}/items/${itemId}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);

      // Estado de cuenta / pestaña Plan: saldo 0, ningún ítem pendiente, nada sin imputar.
      const balance = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as {
        balance: number;
        unallocated: number;
        items: { itemId: string; balance: number; paid: number }[];
      };
      expect(balance.balance).toBe(0);
      expect(balance.unallocated).toBe(0);
      expect(balance.items.map((i) => i.balance)).toEqual([0, 0]);
      expect(balance.items.find((i) => i.itemId === itemId)?.paid).toBe(30);
      // Ventana «Ver imputación»: el abono no tiene nada atribuido ni a cuenta.
      const detail = (
        await call('get', a, `/payments/${own}/allocations`).expect(200)
      ).body as { unallocated: number; creditOut: number; onAccount: number };
      expect(detail).toMatchObject({
        unallocated: 0,
        creditOut: 0,
        onAccount: 0,
      });
      // Informe y Cartera: 0.
      const sept = await report(a, 'from=2026-09-01&to=2026-09-30');
      expect(idsOf(sept)).not.toContain(own);
      const credit = (
        await call(
          'get',
          a,
          '/receivables/credit-balances?pageSize=100',
        ).expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(credit.items.map((r) => r.patient.id)).not.toContain(mia);
    });

    it('DX-399-ter: the statement «Sin imputar» is net of the refund, like the report and the payment window', async () => {
      const nora = await patient(a, 'Nora');
      const p = await plan(a, nora, catalogA, [100]);
      const over = await pay(a, p.planId, 130, '2026-09-12');
      await refund(p.planId, [over], 10);
      const balance = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as { paid: number; allocated: number; unallocated: number };
      // Cobrado 130 = imputado 100 + a cuenta 20 + devuelto 10.
      expect(balance).toMatchObject({
        paid: 130,
        allocated: 100,
        unallocated: 20,
      });
      const row = (await report(a, 'from=2026-09-01&to=2026-09-30')).items.find(
        (r) => r.paymentId === over,
      );
      expect(row?.unallocated).toBe(20);
      const detail = (
        await call('get', a, `/payments/${over}/allocations`).expect(200)
      ).body as { onAccount: number };
      expect(detail.onAccount).toBe(20);
    });

    it('DX-399-ter (F1): a cancelled plan refunded in full shows nothing on account on the statement and the payment window, like Cartera', async () => {
      const olga = await patient(a, 'Olga');
      const p = await plan(a, olga, catalogA, [100]);
      const paid = await pay(a, p.planId, 100, '2026-09-14');
      await call('patch', a, `/treatment-plans/${p.planId}`)
        .send({ status: 'CANCELLED' })
        .expect(200);
      await refund(p.planId, [paid], 100);
      const balance = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as { balance: number; paid: number; unallocated: number };
      expect(balance).toMatchObject({ balance: 0, paid: 100, unallocated: 0 });
      const detail = (
        await call('get', a, `/payments/${paid}/allocations`).expect(200)
      ).body as { unallocated: number; creditOut: number; onAccount: number };
      expect(detail).toMatchObject({
        unallocated: 100,
        creditOut: 100,
        onAccount: 0,
      });
      const credit = (
        await call(
          'get',
          a,
          '/receivables/credit-balances?pageSize=100',
        ).expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(credit.items.map((r) => r.patient.id)).not.toContain(olga);
      // Un plan cancelado no está en el informe.
      const sept = await report(a, 'from=2026-09-01&to=2026-09-30');
      expect(idsOf(sept)).not.toContain(paid);
    });

    it('DX-399-ter (N1): a transfer coming back reallocates the receiving plan by itself: the pending item is covered, nothing on account, Cartera 0', async () => {
      const pia = await patient(a, 'Pia');
      const p = await plan(a, pia, catalogA, [70]);
      const own = await pay(a, p.planId, 100, '2026-09-16');
      const q = await plan(a, pia, catalogA, [20]);
      await pay(a, q.planId, 20, '2026-09-16');
      const transfer = (from: string, to: string) =>
        call(
          'post',
          a,
          `/treatment-plans/${from}/credit-transfers`,
          a.adminToken,
          principal,
        )
          .send({ targetPlanId: to, amount: 30, currency: 'USD' })
          .expect(201);
      // P -> Q 30: el excedente de P sale.
      await transfer(p.planId, q.planId);
      // Ítem nuevo de 30 en P: queda pendiente (no hay nada a cuenta).
      const item = await call('post', a, `/treatment-plans/${p.planId}/items`)
        .send({ toothNumber: '33', catalogItemId: catalogA, price: 30 })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call('patch', a, `/treatment-plans/${p.planId}/items/${itemId}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);
      const before = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as { items: { itemId: string; balance: number }[] };
      expect(before.items.find((i) => i.itemId === itemId)?.balance).toBe(30);
      // Q -> P 30: vuelve, y el traspaso mismo deja P repartido (sin reparto a mano).
      await transfer(q.planId, p.planId);
      const balance = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as {
        balance: number;
        unallocated: number;
        items: { itemId: string; balance: number }[];
      };
      expect(balance.balance).toBe(0);
      expect(balance.unallocated).toBe(0);
      expect(balance.items.map((i) => i.balance)).toEqual([0, 0]);
      const detail = (
        await call('get', a, `/payments/${own}/allocations`).expect(200)
      ).body as { onAccount: number };
      expect(detail.onAccount).toBe(0);
      const sept = await report(a, 'from=2026-09-01&to=2026-09-30');
      expect(idsOf(sept)).not.toContain(own);
      const credit = (
        await call(
          'get',
          a,
          '/receivables/credit-balances?pageSize=100',
        ).expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(credit.items.map((r) => r.patient.id)).not.toContain(pia);
    });

    it('DX-399-quater: own surplus 30, 30 received by transfer and a new item of 60: the item is paid (30 + 30) with no manual step, and Cartera, the Plan and the statement agree on 0', async () => {
      const rita = await patient(a, 'Rita');
      // P: ítem de 70 y abono de 100 -> 30 propios a cuenta.
      const p = await plan(a, rita, catalogA, [70]);
      const own = await pay(a, p.planId, 100, '2026-09-18');
      // Q, del mismo paciente, con 30 a cuenta que traspasa a P.
      const q = await plan(a, rita, catalogA, [20]);
      await pay(a, q.planId, 50, '2026-09-18');
      await call(
        'post',
        a,
        `/treatment-plans/${q.planId}/credit-transfers`,
        a.adminToken,
        principal,
      )
        .send({ targetPlanId: p.planId, amount: 30, currency: 'USD' })
        .expect(201);
      // Ítem nuevo de 60 en P, aceptado.
      const item = await call('post', a, `/treatment-plans/${p.planId}/items`)
        .send({ toothNumber: '34', catalogItemId: catalogA, price: 60 })
        .expect(201);
      const itemId = (item.body as { id: string }).id;
      await call('patch', a, `/treatment-plans/${p.planId}/items/${itemId}`)
        .send({ status: 'ACCEPTED' })
        .expect(200);

      type Balance = {
        balance: number;
        allocated: number;
        unallocated: number;
        transfersInOnAccount?: number;
        items: {
          itemId: string;
          paid: number;
          balance: number;
          paidByTransfersIn?: number;
        }[];
      };
      const balance = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as Balance;
      expect(balance.balance).toBe(0);
      expect(balance.items.map((i) => i.balance)).toEqual([0, 0]);
      expect(balance.items.find((i) => i.itemId === itemId)).toMatchObject({
        paid: 60,
        balance: 0,
        paidByTransfersIn: 30,
      });
      expect(balance).toMatchObject({ allocated: 100, unallocated: 0 });
      expect(balance.transfersInOnAccount ?? 0).toBe(0);
      // «Ver imputación»: el abono dio 30 al ítem y lo recibido los otros 30.
      const detail = (
        await call('get', a, `/payments/${own}/allocations`).expect(200)
      ).body as {
        onAccount: number;
        allocations: { treatmentPlanItemId: string; amount: number }[];
        items: { itemId: string; paidByTransfersIn?: number; free: number }[];
      };
      expect(detail.onAccount).toBe(0);
      expect(
        detail.allocations.find((l) => l.treatmentPlanItemId === itemId)
          ?.amount,
      ).toBe(30);
      expect(
        detail.items.find((i) => i.itemId === itemId)?.paidByTransfersIn,
      ).toBe(30);
      // Cartera: ni deuda ni saldo a favor.
      const aging = (
        await call('get', a, '/receivables/aging?pageSize=100').expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(aging.items.map((r) => r.patient.id)).not.toContain(rita);
      const credit = (
        await call(
          'get',
          a,
          '/receivables/credit-balances?pageSize=100',
        ).expect(200)
      ).body as { items: { patient: { id: string } }[] };
      expect(credit.items.map((r) => r.patient.id)).not.toContain(rita);
      // El informe no lista el abono (nada a cuenta).
      const sept = await report(a, 'from=2026-09-01&to=2026-09-30');
      expect(idsOf(sept)).not.toContain(own);

      // El ítem vuelve a propuesto: lo recibido se libera y queda a cuenta del plan.
      await call('patch', a, `/treatment-plans/${p.planId}/items/${itemId}`)
        .send({ status: 'PROPOSED' })
        .expect(200);
      const freed = (
        await call('get', a, `/treatment-plans/${p.planId}/balance`).expect(200)
      ).body as Balance;
      expect(freed.balance).toBe(-60);
      expect(freed.items.map((i) => i.balance)).toEqual([0, 0]);
      expect(freed.unallocated).toBe(30);
      expect(freed.transfersInOnAccount).toBe(30);
    });

    it('F4: the equivalence still holds at the end, after every chronology and transfer scenario above', async () => {
      await expectEquivalence();
    });
  });

  describe('roles, sedes and isolation', () => {
    it('ADMIN and RECEPTION read; DENTIST and ASSISTANT get 403 in Spanish', async () => {
      await report(a, PERIOD, receptionToken);
      for (const token of [dentistToken, assistantToken]) {
        for (const path of [
          `/reports/unallocated-payments?${PERIOD}`,
          `/reports/unallocated-payments.csv?${PERIOD}`,
        ]) {
          const res = await call('get', a, path, token).expect(403);
          expect((res.body as { message: string }).message).toBe(
            'Tu rol no tiene acceso a lo cobrado sin imputar: es para administración y recepción.',
          );
        }
      }
    });

    it('a member restricted to Sede Norte sees only its payments and 403 for the other sede', async () => {
      const page = await report(a, PERIOD, norteOnlyToken);
      expect(idsOf(page)).toEqual([pays.manualEmpty]);
      expect(page.options.locations.map((l) => l.id)).toEqual([norte]);
      await call(
        'get',
        a,
        `/reports/unallocated-payments?${PERIOD}&locationId=${principal}`,
        norteOnlyToken,
      ).expect(403);
    });

    it('clinic B sees only its own payment and A never sees it', async () => {
      const pageB = await report(b);
      expect(idsOf(pageB)).toEqual([pays.b]);
      expect(pageB.totals).toEqual([
        { currency: 'USD', count: 1, allocated: 10, unallocated: 89 },
      ]);
      expect(idsOf(await report(a))).not.toContain(pays.b);
      // La sede de A, desde B: 403 (la misma respuesta que una sede ajena).
      await call(
        'get',
        b,
        `/reports/unallocated-payments?${PERIOD}&locationId=${principal}`,
      ).expect(403);
    });

    it('rejects bad periods with 400', async () => {
      for (const query of [
        'from=2026-10-31&to=2026-10-01',
        'from=2024-01-01&to=2026-12-31',
        'from=hoy&to=2026-10-01',
        'to=2026-10-01',
      ]) {
        await call('get', a, `/reports/unallocated-payments?${query}`).expect(
          400,
        );
      }
    });
  });

  it('audits the view and the download without a patient', async () => {
    await report(a);
    await call('get', a, `/reports/unallocated-payments.csv?${PERIOD}`).expect(
      200,
    );
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'ACCOUNT_STATEMENT',
        metadata: { path: ['reason'], equals: 'UNALLOCATED_PAYMENTS' },
      },
    });
    expect(events.map((e) => e.action).sort()).toEqual(
      expect.arrayContaining(['EXPORT', 'VIEW']),
    );
    expect(events.every((e) => e.patientId === null)).toBe(true);
  });
});
