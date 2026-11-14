import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { fixedSedeDay } from './support/sede-clock';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-516-bis contra Postgres y por HTTP real: los ajustes por medio de pago
// (IGTF del 3 % sobre el efectivo en divisa, un impuesto porcentual) en los
// dos caminos que DX-516 no probaba:
//  - abonos TARDÍOS: con `paidAt` en un día anterior, cuya caja de la sede ya
//    cerró (entran como ajuste LATE_PAYMENT, por lo cobrado, en la caja
//    abierta) o que no tuvo caja (entran directos en la abierta); con la tasa
//    de ESE día congelada;
//  - abonos contra el SALDO INICIAL (migrado) de un paciente: pendiente por
//    el importe, no por lo cobrado; recibo, estado de cuenta y caja.
// En cada camino, un medio con ajuste (efectivo USD, IGTF 3 %) y otro sin él
// (transferencia). Las fechas son días LABORABLES FIJOS de la sede (nada
// depende de «hoy» ni de su medianoche).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;
const IGTF = { type: 'TAX', label: 'IGTF 3 %', percent: 3 };

/** El día laborable (lun-vie) de la sede más reciente, a ≥ `from` días. */
function weekdayAgo(from: number, before?: string): string {
  for (let ago = from; ago < from + 14; ago++) {
    const { day } = fixedSedeDay(ago);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5 && (before === undefined || day < before)) {
      return day;
    }
  }
  throw new Error('sin día laborable');
}

// D1: tiene una caja cerrada de la sede. D2: sin caja. D3: otra sin caja.
const D1 = weekdayAgo(2);
const D2 = weekdayAgo(2, D1);
// Tasa del D1 distinta a la de los demás días: se congela la de SU día.
const RATE_D1 = 36.5;

interface Adjustment {
  type: string;
  label: string;
  calculation: string;
  percent: number | null;
  fixedAmount: number | null;
  base: number;
  amount: number;
  currency: string;
}

interface PaymentBody {
  id: string;
  amount: number;
  currency: string;
  collectedAmount: number;
  adjustments: Adjustment[];
  openingBalanceId: string | null;
  treatmentPlanId: string | null;
  exchangeRateStatus?: string;
  frozenRate: { fromPerBase: number; date: string; source: string } | null;
}

interface ExpectedLine {
  currency: string;
  method: string;
  opening: number;
  payments: number;
  paymentAdjustments: number;
  adjustments: number;
  expected: number;
}

interface SessionDetail {
  id: string;
  expected: ExpectedLine[];
  adjustments: {
    kind: string;
    amount: number;
    currency: string;
    method: string;
    sessionId: string | null;
    payment: { id: string } | null;
    originalSession: { id: string } | null;
  }[];
  laterAdjustments: { kind: string; amount: number }[];
}

interface ReceiptBody {
  snapshot: {
    payment: {
      amount: number;
      currency: string;
      adjustments?: Adjustment[];
    };
    plan: { id: string } | null;
    openingBalance: { id: string; concept: string } | null;
    planBalance: {
      currency: string;
      billable: number;
      paid: number;
      balance: number;
    } | null;
  };
}

interface MethodBody {
  id: string;
  legacyMethod: string | null;
}

interface Site {
  clinic: Clinic;
  reception: string;
  location: string;
  cash: string;
  transfer: string;
  sessionId: string;
  closedD1: string;
}

describe('Ajustes por medio de pago: abonos tardíos y de saldo inicial (int, DX-516-bis)', () => {
  let app: INestApplication<App>;
  let late: Site;
  let ob: Site;
  let planId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const asReception = (req: request.Test, s: Site) =>
    as(req, s.clinic, s.reception).set('X-Location-Id', s.location);

  const detailOf = async (s: Site, id: string): Promise<SessionDetail> =>
    (await asReception(api().get(`/api/v1/cash-sessions/${id}`), s).expect(200))
      .body as SessionDetail;
  const lineOf = (d: SessionDetail, currency: string, method: string) =>
    d.expected.find((l) => l.currency === currency && l.method === method);
  const receiptOf = async (s: Site, id: string): Promise<ReceiptBody> =>
    (
      await asReception(api().get(`/api/v1/payments/${id}/receipt`), s).expect(
        200,
      )
    ).body as ReceiptBody;
  const planBalance = async (s: Site) =>
    (
      await as(
        api().get(`/api/v1/treatment-plans/${planId}/balance`),
        s.clinic,
      ).expect(200)
    ).body as { paid: number; balance: number };

  const payPlan = (s: Site, body: Record<string, unknown>) =>
    asReception(
      api().post(`/api/v1/treatment-plans/${planId}/payments`),
      s,
    ).send({ currency: 'USD', ...body });
  const payOpening = (
    s: Site,
    openingId: string,
    body: Record<string, unknown>,
  ) =>
    asReception(
      api().post(`/api/v1/opening-balances/${openingId}/payments`),
      s,
    ).send({ currency: 'USD', ...body });

  async function seedPlan(clinic: Clinic): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Tardia',
          docType: 'NATIONAL_ID',
          docNumber: 'DX516B-1',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    // DX-513-bis: el catálogo en la moneda de los planes del spec (USD): sus
    // ítems no necesitan tasa y sus importes no cambian (support/catalog-currency).
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: 'DX516B-1',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const id = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
        )
          .send({ notes: 'Plan DX-516-bis', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${id}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${id}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return id;
  }

  /** Clínica con recepción, IGTF 3 % en el efectivo, caja D1 cerrada y caja abierta. */
  async function bootstrap(subdomain: string): Promise<Site> {
    const clinic = await registerClinic(app, subdomain);
    const member = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    const reception = await loginAs(app, clinic.host, member.email);
    const location = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const methods = (
      await as(
        api().get('/api/v1/payment-methods?includeInactive=true'),
        clinic,
      ).expect(200)
    ).body as MethodBody[];
    const cash = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    const transfer = methods.find((m) => m.legacyMethod === 'TRANSFER')!.id;
    await as(api().post(`/api/v1/payment-methods/${cash}/adjustments`), clinic)
      .send({ ...IGTF, calculation: 'PERCENT' })
      .expect(201);
    // La caja de la sede que cubrió D1 (cerrada), sembrada como en la caja
    // por turno (los triggers ponen la hora del servidor: se salta).
    const start = new Date(`${D1}T08:00:00-04:00`).getTime();
    const closedD1 = await raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      return tx.cashSession.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: location,
          openedById: clinic.adminUserId,
          openedAt: new Date(start),
          status: 'CLOSED',
          closedAt: new Date(start + 10 * HOUR),
          closedById: clinic.adminUserId,
        },
      });
    });
    const site: Site = {
      clinic,
      reception,
      location,
      cash,
      transfer,
      sessionId: '',
      closedD1: closedD1.id,
    };
    const opened = await asReception(
      api().post('/api/v1/cash-sessions/open'),
      site,
    )
      .send({ floats: [{ currency: 'USD', amount: 20 }] })
      .expect(201);
    site.sessionId = (opened.body as { id: string }).id;
    return site;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    // La tasa del D1 (36,5) y la de los demás días (40): la del abono es la
    // de SU día, no la de hoy.
    const days = [D1, D2, fixedSedeDay(0).day, fixedSedeDay(1).day];
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: days } },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: [...new Set(days)].map((date) => ({
        date,
        currency: 'VES',
        rate: date === D1 ? RATE_D1 : 40,
      })),
    });
    late = await bootstrap('dx516b-late');
    ob = await bootstrap('dx516b-open');
    planId = await seedPlan(late.clinic);
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: {
        date: { in: [D1, D2, fixedSedeDay(0).day, fixedSedeDay(1).day] },
      },
    });
    await app.close();
    await raw.$disconnect();
  });

  describe('abonos tardíos', () => {
    let lateCash: PaymentBody;
    let lateTransfer: PaymentBody;
    let directCash: PaymentBody;

    it('con ajuste: efectivo USD del D1 (caja cerrada) congela el IGTF 3 % y entra por lo cobrado como LATE_PAYMENT en la caja abierta', async () => {
      const res = await payPlan(late, {
        amount: 100,
        paidAt: D1,
        paymentMethodId: late.cash,
      }).expect(201);
      lateCash = res.body as PaymentBody;
      expect(lateCash.amount).toBe(100);
      expect(lateCash.collectedAmount).toBe(103);
      expect(lateCash.adjustments).toEqual([
        {
          type: 'TAX',
          label: 'IGTF 3 %',
          calculation: 'PERCENT',
          percent: 3,
          fixedAmount: null,
          base: 100,
          amount: 3,
          currency: 'USD',
        },
      ]);

      // BD: abono sin caja propia, ajuste congelado y apunte tardío por 103.
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: lateCash.id },
        select: { cashSessionId: true, amount: true, currency: true },
      });
      expect(row.cashSessionId).toBeNull();
      expect(row.amount.toNumber()).toBe(100);
      const frozen = await raw.paymentAdjustment.findMany({
        where: { paymentId: lateCash.id },
      });
      expect(frozen.map((f) => f.amount.toNumber())).toEqual([3]);
      const apunte = await raw.cashSessionAdjustment.findMany({
        where: { paymentId: lateCash.id },
      });
      expect(apunte).toHaveLength(1);
      expect(apunte[0]).toMatchObject({
        kind: 'LATE_PAYMENT',
        sessionId: late.sessionId,
        originalSessionId: late.closedD1,
        currency: 'USD',
        method: 'CASH',
      });
      expect(apunte[0].amount.toNumber()).toBe(103);

      // Caja abierta: fondo 20 + apunte tardío 103; el abono NO cuenta
      // dos veces como abono directo.
      const open = await detailOf(late, late.sessionId);
      expect(lineOf(open, 'USD', 'CASH')).toMatchObject({
        opening: 20,
        payments: 0,
        paymentAdjustments: 0,
        adjustments: 103,
        expected: 123,
      });
      expect(
        open.adjustments.map((a) => [a.kind, a.amount, a.originalSession?.id]),
      ).toEqual([['LATE_PAYMENT', 103, late.closedD1]]);
      // La caja cerrada del D1 no cambia: lo tardío figura aparte.
      // (es la caja del ADMIN: recepción solo ve las suyas)
      const closed = (
        await as(
          api().get(`/api/v1/cash-sessions/${late.closedD1}`),
          late.clinic,
        ).expect(200)
      ).body as SessionDetail;
      expect(closed.expected ?? []).toEqual([]);
      expect(closed.laterAdjustments).toEqual([
        expect.objectContaining({ kind: 'LATE_PAYMENT', amount: 103 }),
      ]);

      // Recibo: importe, moneda y ajuste congelados; saldo por el importe.
      const receipt = await receiptOf(late, lateCash.id);
      expect(receipt.snapshot.payment).toMatchObject({
        amount: 100,
        currency: 'USD',
        adjustments: lateCash.adjustments,
      });
      expect(receipt.snapshot.planBalance).toEqual({
        currency: 'USD',
        billable: 1000,
        paid: 100,
        balance: 900,
      });
      // Saldo del plan: abonado 100 (el IGTF se cobra aparte).
      expect(await planBalance(late)).toMatchObject({
        paid: 100,
        balance: 900,
      });
    });

    it('sin ajuste: transferencia en VES del D1 congela la tasa de ESE día y entra por su importe', async () => {
      const res = await payPlan(late, {
        amount: 3650,
        currency: 'VES',
        paidAt: D1,
        paymentMethodId: late.transfer,
      }).expect(201);
      lateTransfer = res.body as PaymentBody;
      expect(lateTransfer.adjustments).toEqual([]);
      expect(lateTransfer.collectedAmount).toBe(3650);
      expect(lateTransfer.frozenRate).toMatchObject({
        fromPerBase: RATE_D1,
        date: D1,
      });
      expect(
        await raw.paymentAdjustment.count({
          where: { paymentId: lateTransfer.id },
        }),
      ).toBe(0);
      const apunte = await raw.cashSessionAdjustment.findFirstOrThrow({
        where: { paymentId: lateTransfer.id },
      });
      expect(apunte).toMatchObject({
        kind: 'LATE_PAYMENT',
        sessionId: late.sessionId,
        originalSessionId: late.closedD1,
        currency: 'VES',
        method: 'TRANSFER',
      });
      expect(apunte.amount.toNumber()).toBe(3650);
      const open = await detailOf(late, late.sessionId);
      expect(lineOf(open, 'VES', 'TRANSFER')).toMatchObject({
        payments: 0,
        paymentAdjustments: 0,
        adjustments: 3650,
        expected: 3650,
      });
      // El efectivo USD no se movió.
      expect(lineOf(open, 'USD', 'CASH')?.expected).toBe(123);
      const receipt = await receiptOf(late, lateTransfer.id);
      expect(receipt.snapshot.payment).toMatchObject({
        amount: 3650,
        currency: 'VES',
      });
      expect(receipt.snapshot.payment).not.toHaveProperty('adjustments');
      // 3.650 VES / 36,5 = 100 USD: 100 + 100 abonados.
      expect(receipt.snapshot.planBalance).toMatchObject({ paid: 200 });
      expect(await planBalance(late)).toMatchObject({
        paid: 200,
        balance: 800,
      });
    });

    it('la caja del día (GET /payments) del D1 suma el importe, el IGTF aparte y lo cobrado', async () => {
      const cash = (
        await asReception(
          api().get(`/api/v1/payments?from=${D1}&to=${D1}`),
          late,
        ).expect(200)
      ).body as {
        items: PaymentBody[];
        summary: {
          byCurrency: { currency: string; total: number }[];
          adjustments: { currency: string; type: string; total: number }[];
          collected: { currency: string; total: number }[];
        };
      };
      expect(cash.items.map((i) => i.id).sort()).toEqual(
        [lateCash.id, lateTransfer.id].sort(),
      );
      expect(
        cash.summary.byCurrency.map((b) => [b.currency, b.total]).sort(),
      ).toEqual([
        ['USD', 100],
        ['VES', 3650],
      ]);
      expect(cash.summary.adjustments).toEqual([
        expect.objectContaining({ currency: 'USD', type: 'TAX', total: 3 }),
      ]);
      expect(
        cash.summary.collected.map((c) => [c.currency, c.total]).sort(),
      ).toEqual([
        ['USD', 103],
        ['VES', 3650],
      ]);
    });

    it('un día sin caja (D2): el abono entra directo en la caja abierta, con el IGTF aparte', async () => {
      const res = await payPlan(late, {
        amount: 50,
        paidAt: D2,
        paymentMethodId: late.cash,
      }).expect(201);
      directCash = res.body as PaymentBody;
      expect(directCash.collectedAmount).toBe(51.5);
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: directCash.id },
        select: { cashSessionId: true },
      });
      expect(row.cashSessionId).toBe(late.sessionId);
      expect(
        await raw.cashSessionAdjustment.count({
          where: { paymentId: directCash.id },
        }),
      ).toBe(0);
      const open = await detailOf(late, late.sessionId);
      expect(lineOf(open, 'USD', 'CASH')).toMatchObject({
        payments: 50,
        paymentAdjustments: 1.5,
        adjustments: 103,
        expected: 174.5,
      });
      expect(await planBalance(late)).toMatchObject({ paid: 250 });
    });

    it('anular el abono tardío compensa lo cobrado entero (−103) en la misma caja y el plan baja por el importe', async () => {
      await as(api().delete(`/api/v1/payments/${lateCash.id}`), late.clinic)
        .send({ reason: 'Cobro duplicado' })
        .expect(200);
      const voids = await raw.cashSessionAdjustment.findMany({
        where: { paymentId: lateCash.id, kind: 'VOID' },
      });
      expect(voids).toHaveLength(1);
      expect(voids[0].sessionId).toBe(late.sessionId);
      expect(voids[0].amount.toNumber()).toBe(-103);
      const open = await detailOf(late, late.sessionId);
      // 20 + 50 + 1,5 + (103 − 103) = 71,5.
      expect(lineOf(open, 'USD', 'CASH')).toMatchObject({
        adjustments: 0,
        expected: 71.5,
      });
      expect(await planBalance(late)).toMatchObject({ paid: 150 });
    });

    it('cobro dividido tardío (D1): cada parte entra como LATE_PAYMENT por lo cobrado de su propio medio', async () => {
      const res = await asReception(
        api().post(`/api/v1/treatment-plans/${planId}/split-payments`),
        late,
      )
        .send({
          paidAt: D1,
          lines: [
            { amount: 50, currency: 'USD', paymentMethodId: late.cash },
            { amount: 3650, currency: 'VES', paymentMethodId: late.transfer },
          ],
        })
        .expect(201);
      const split = (res.body as { payments: PaymentBody[] }).payments;
      expect(
        split.map((p) => [p.collectedAmount, p.adjustments.length]),
      ).toEqual([
        [51.5, 1],
        [3650, 0],
      ]);
      const apuntes = await raw.cashSessionAdjustment.findMany({
        where: { paymentId: { in: split.map((p) => p.id) } },
        orderBy: { amount: 'asc' },
      });
      expect(
        apuntes.map((a) => [a.kind, a.currency, a.method, a.amount.toNumber()]),
      ).toEqual([
        ['LATE_PAYMENT', 'USD', 'CASH', 51.5],
        ['LATE_PAYMENT', 'VES', 'TRANSFER', 3650],
      ]);
      const open = await detailOf(late, late.sessionId);
      expect(lineOf(open, 'USD', 'CASH')).toMatchObject({
        adjustments: 51.5,
        expected: 123,
      });
      expect(lineOf(open, 'VES', 'TRANSFER')?.expected).toBe(7300);
      // 150 + 50 + 3.650 VES a 36,5 (=100) = 300.
      expect(await planBalance(late)).toMatchObject({ paid: 300 });
    });
  });

  describe('abonos contra el saldo inicial', () => {
    let patientId: string;
    let balanceA: string;
    let balanceB: string;

    const statement = async () =>
      (
        await as(
          api().get(`/api/v1/patients/${patientId}/account-statement`),
          ob.clinic,
        ).expect(200)
      ).body as {
        openingBalances: {
          id: string;
          amount: number;
          paid: number;
          pending: number;
        }[];
      };
    const pendingOf = async (id: string) =>
      (await statement()).openingBalances.find((o) => o.id === id)!;

    beforeAll(async () => {
      const user = ob.clinic.adminUserId;
      patientId = (
        await raw.patient.create({
          data: {
            tenantId: ob.clinic.tenantId,
            firstName: 'Luis',
            lastName: 'Migrado',
            documentType: 'NATIONAL_ID',
            docNumber: 'DX516B-OB',
          },
        })
      ).id;
      const newBatch = () =>
        raw.patientImportBatch.create({
          data: {
            tenantId: ob.clinic.tenantId,
            createdById: user,
            locationId: ob.location,
            fileName: 'saldos.csv',
            fileSha256: randomBytes(32).toString('hex'),
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
      const opening = async (concept: string, amount: string) =>
        raw.openingBalance.create({
          data: {
            tenantId: ob.clinic.tenantId,
            locationId: ob.location,
            patientId,
            importBatchId: (await newBatch()).id,
            currency: 'USD',
            amount: new Prisma.Decimal(amount),
            asOfDate: new Date('2026-03-15T00:00:00.000Z'),
            concept,
            createdById: user,
          },
        });
      balanceA = (await opening('Ortodoncia 2025', '300.00')).id;
      balanceB = (await opening('Prótesis 2025', '100.00')).id;
    }, 60_000);

    it('con ajuste: efectivo USD congela el IGTF 3 %; el pendiente baja por el importe y la caja suma lo cobrado', async () => {
      const res = await payOpening(ob, balanceA, {
        amount: 100,
        paidAt: D2,
        paymentMethodId: ob.cash,
      }).expect(201);
      const paid = res.body as PaymentBody;
      expect(paid).toMatchObject({
        amount: 100,
        currency: 'USD',
        collectedAmount: 103,
        openingBalanceId: balanceA,
        treatmentPlanId: null,
      });
      expect(paid.adjustments).toEqual([
        expect.objectContaining({
          type: 'TAX',
          label: 'IGTF 3 %',
          base: 100,
          amount: 3,
          currency: 'USD',
        }),
      ]);
      expect(
        (
          await raw.paymentAdjustment.findMany({
            where: { paymentId: paid.id },
          })
        ).map((f) => [f.base.toNumber(), f.amount.toNumber()]),
      ).toEqual([[100, 3]]);

      // Recibo: ajuste congelado, saldo migrado y pendiente por el importe.
      const receipt = await receiptOf(ob, paid.id);
      expect(receipt.snapshot.plan).toBeNull();
      expect(receipt.snapshot.openingBalance).toMatchObject({
        id: balanceA,
        concept: 'Ortodoncia 2025',
      });
      expect(receipt.snapshot.payment).toMatchObject({
        amount: 100,
        currency: 'USD',
        adjustments: paid.adjustments,
      });
      expect(receipt.snapshot.planBalance).toMatchObject({
        currency: 'USD',
        billable: 300,
        paid: 100,
        balance: 200,
      });
      // Estado de cuenta: el IGTF no abona el saldo.
      expect(await pendingOf(balanceA)).toMatchObject({
        amount: 300,
        paid: 100,
        pending: 200,
      });
      // Caja: fondo 20 + abono 100 + IGTF 3 = 123.
      expect(
        lineOf(await detailOf(ob, ob.sessionId), 'USD', 'CASH'),
      ).toMatchObject({
        payments: 100,
        paymentAdjustments: 3,
        adjustments: 0,
        expected: 123,
      });
      expect(
        await raw.cashSessionAdjustment.count({
          where: { paymentId: paid.id },
        }),
      ).toBe(0);
    });

    it('el tope es el pendiente (el importe), no lo cobrado: 200,01 es 400 y 200 liquida el saldo', async () => {
      await payOpening(ob, balanceA, {
        amount: 200.01,
        paidAt: D2,
        paymentMethodId: ob.cash,
      }).expect(400);
      const rest = (
        await payOpening(ob, balanceA, {
          amount: 200,
          paidAt: D2,
          paymentMethodId: ob.cash,
        }).expect(201)
      ).body as PaymentBody;
      expect(rest.collectedAmount).toBe(206);
      expect(await pendingOf(balanceA)).toMatchObject({
        paid: 300,
        pending: 0,
      });
      expect(
        lineOf(await detailOf(ob, ob.sessionId), 'USD', 'CASH'),
      ).toMatchObject({ payments: 300, paymentAdjustments: 9, expected: 329 });
    });

    it('sin ajuste: transferencia USD no congela nada y el recibo no trae la clave', async () => {
      const paid = (
        await payOpening(ob, balanceB, {
          amount: 40,
          paidAt: D2,
          paymentMethodId: ob.transfer,
        }).expect(201)
      ).body as PaymentBody;
      expect(paid.adjustments).toEqual([]);
      expect(paid.collectedAmount).toBe(40);
      expect(
        await raw.paymentAdjustment.count({ where: { paymentId: paid.id } }),
      ).toBe(0);
      const receipt = await receiptOf(ob, paid.id);
      expect(receipt.snapshot.payment).not.toHaveProperty('adjustments');
      expect(receipt.snapshot.planBalance).toMatchObject({
        billable: 100,
        paid: 40,
        balance: 60,
      });
      expect(await pendingOf(balanceB)).toMatchObject({
        paid: 40,
        pending: 60,
      });
      expect(
        lineOf(await detailOf(ob, ob.sessionId), 'USD', 'TRANSFER'),
      ).toMatchObject({ payments: 40, paymentAdjustments: 0, expected: 40 });
    });

    it('saldo inicial tardío (D1, caja cerrada): entra como LATE_PAYMENT por lo cobrado (41,20) y anularlo lo compensa', async () => {
      const paid = (
        await payOpening(ob, balanceB, {
          amount: 40,
          paidAt: D1,
          paymentMethodId: ob.cash,
        }).expect(201)
      ).body as PaymentBody;
      expect(paid.collectedAmount).toBe(41.2);
      const apunte = await raw.cashSessionAdjustment.findFirstOrThrow({
        where: { paymentId: paid.id },
      });
      expect(apunte).toMatchObject({
        kind: 'LATE_PAYMENT',
        sessionId: ob.sessionId,
        originalSessionId: ob.closedD1,
        currency: 'USD',
        method: 'CASH',
      });
      expect(apunte.amount.toNumber()).toBe(41.2);
      expect(await pendingOf(balanceB)).toMatchObject({
        paid: 80,
        pending: 20,
      });
      expect(
        lineOf(await detailOf(ob, ob.sessionId), 'USD', 'CASH'),
      ).toMatchObject({
        payments: 300,
        paymentAdjustments: 9,
        adjustments: 41.2,
        expected: 370.2,
      });

      await as(api().delete(`/api/v1/payments/${paid.id}`), ob.clinic)
        .send({ reason: 'Cobro duplicado' })
        .expect(200);
      const voided = await raw.cashSessionAdjustment.findFirstOrThrow({
        where: { paymentId: paid.id, kind: 'VOID' },
      });
      expect(voided.amount.toNumber()).toBe(-41.2);
      expect(await pendingOf(balanceB)).toMatchObject({
        paid: 40,
        pending: 60,
      });
      expect(
        lineOf(await detailOf(ob, ob.sessionId), 'USD', 'CASH'),
      ).toMatchObject({ adjustments: 0, expected: 329 });
    });
  });
});
