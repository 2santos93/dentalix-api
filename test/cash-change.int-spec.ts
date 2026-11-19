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

// DX-570 contra Postgres y por HTTP real: vuelto al cobrar en efectivo,
// entregado en otra moneda o por otro medio, en el mismo abono. El caso del
// ticket: el paciente paga 45 USD con un billete de 50 y la clínica le
// devuelve 5 USD en bolívares por un medio digital que pide referencia.
//   - el plan recibe 45; la caja espera +50 USD en efectivo y −182,50 VES por
//     su medio (TRANSFER, tipo base del medio digital);
//   - anular con la caja abierta revierte las dos cosas; con la caja cerrada
//     (DX-345) son ajustes VOID (−50 USD) y CHANGE_VOID (+182,50 VES) en la
//     caja abierta de quien anula;
//   - un abono tardío (día de una caja ya cerrada) entra como LATE_PAYMENT
//     (+50) y su vuelto como CHANGE_LATE (−182,50);
//   - dos abonos con vuelto y una anulación simultáneos sobre la misma caja;
//   - la BD repite el cuadre y la inmutabilidad (red bajo la API).
// Fechas: días FIJOS de la sede (support/sede-clock), nunca «ahora + N».
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;
const RATE = 36.5;
/** Día de los abonos directos: ayer en la sede, sin caja cerrada. */
const DAY = fixedSedeDay(1).day;
/** Día con una caja de la sede ya cerrada (abonos tardíos). */
const CLOSED_DAY = fixedSedeDay(4).day;

interface ChangeLine {
  method: string;
  currency: string;
  amount: number;
  equivalentAmount: number;
  reference: string | null;
  rate: { fromPerBase: number; toPerBase: number; date: string } | null;
}

interface PaymentBody {
  id: string;
  amount: number;
  currency: string;
  cashChange: {
    tendered: number;
    remainderToCredit: number;
    lines: ChangeLine[];
  } | null;
}

interface ExpectedLine {
  currency: string;
  method: string;
  opening: number;
  payments: number;
  changeIn: number;
  changeOut: number;
  adjustments: number;
  expected: number;
}

interface SessionDetail {
  id: string;
  expected: ExpectedLine[] | null;
  payments: { id: string; cashChange: { tendered: number } | null }[] | null;
  adjustments:
    | {
        kind: string;
        amount: number;
        currency: string;
        method: string;
        payment: { id: string } | null;
      }[]
    | null;
}

describe('Vuelto al cobrar en efectivo (int, DX-570)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let reception: string;
  let location: string;
  let cashMethod: string;
  let mobileMethod: string;
  let planId: string;
  let sessionId: string;
  let closedSession: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const asReception = (req: request.Test) =>
    as(req, reception).set('X-Location-Id', location);

  const pay = (body: Record<string, unknown>) =>
    asReception(api().post(`/api/v1/treatment-plans/${planId}/payments`)).send({
      amount: 45,
      currency: 'USD',
      paidAt: DAY,
      paymentMethodId: cashMethod,
      ...body,
    });
  const vesChange = (amount = 182.5, reference = '0412-5551234') => ({
    paymentMethodId: mobileMethod,
    currency: 'VES',
    amount,
    reference,
  });
  const detailOf = async (id: string): Promise<SessionDetail> =>
    (await asReception(api().get(`/api/v1/cash-sessions/${id}`)).expect(200))
      .body as SessionDetail;
  const lineOf = (d: SessionDetail, currency: string, method: string) =>
    d.expected?.find((l) => l.currency === currency && l.method === method);
  const expectedOf = async (currency: string, method: string, id = sessionId) =>
    lineOf(await detailOf(id), currency, method)?.expected ?? 0;
  const voidPayment = (id: string) =>
    asReception(api().delete(`/api/v1/payments/${id}`)).send({
      reason: 'Cobro duplicado',
    });

  async function openSession(): Promise<string> {
    const opened = await asReception(api().post('/api/v1/cash-sessions/open'))
      .send({
        floats: [
          { currency: 'USD', amount: 20 },
          { currency: 'VES', amount: 1000 },
        ],
      })
      .expect(201);
    return (opened.body as { id: string }).id;
  }

  async function closeSession(id: string): Promise<void> {
    const detail = await detailOf(id);
    const counts = (detail.expected ?? []).map((l) => ({
      currency: l.currency,
      method: l.method,
      counted: Math.max(l.expected, 0),
    }));
    await asReception(api().post(`/api/v1/cash-sessions/${id}/close`))
      .send({ counts, differenceReason: 'Vuelto por transferencia (DX-570)' })
      .expect(201);
  }

  async function seedPlan(): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'))
        .send({
          firstName: 'Ana',
          lastName: 'Vuelto',
          docType: 'NATIONAL_ID',
          docNumber: 'DX570-1',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'))
        .send({
          code: 'DX570-1',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const id = (
      (
        await as(api().post(`/api/v1/patients/${patient.id}/treatment-plans`))
          .send({ notes: 'Plan DX-570', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${id}/items`))
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(api().patch(`/api/v1/treatment-plans/${id}/items/${planItem.id}`))
      .send({ status: 'DONE' })
      .expect(200);
    return id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    const days = [DAY, CLOSED_DAY];
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: days }, currency: 'VES' },
    });
    await raw.exchangeRateSnapshot.createMany({
      data: days.map((date) => ({ date, currency: 'VES', rate: RATE })),
    });
    clinic = await registerClinic(app, 'dx570-change');
    const member = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinic.host, member.email);
    location = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    const methods = (await as(api().get('/api/v1/payment-methods')).expect(200))
      .body as { id: string; legacyMethod: string | null }[];
    cashMethod = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    mobileMethod = (
      (
        await as(api().post('/api/v1/payment-methods'))
          .send({
            name: 'Pago móvil',
            kind: 'DIGITAL',
            requiresReference: true,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    planId = await seedPlan();
    // La caja de la sede que cubrió CLOSED_DAY, ya cerrada (los triggers
    // ponen la hora del servidor: se salta, como en DX-516-bis).
    const start = new Date(`${CLOSED_DAY}T08:00:00-04:00`).getTime();
    closedSession = (
      await raw.$transaction(async (tx) => {
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
      })
    ).id;
    sessionId = await openSession();
  }, 120_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [DAY, CLOSED_DAY] }, currency: 'VES' },
    });
    await app.close();
    await raw.$disconnect();
  });

  let ticketPayment: PaymentBody;

  it('45 USD con 50 recibidos y 5 USD en VES por el medio digital: el plan recibe 45; la caja +50 USD en efectivo y −182,50 VES por su medio', async () => {
    const res = await pay({ tendered: 50, change: [vesChange()] }).expect(201);
    ticketPayment = res.body as PaymentBody;
    expect(ticketPayment.amount).toBe(45);
    expect(ticketPayment.cashChange).toEqual({
      tendered: 50,
      remainderToCredit: 0,
      lines: [
        expect.objectContaining({
          method: 'TRANSFER',
          currency: 'VES',
          amount: 182.5,
          equivalentAmount: 5,
          reference: '0412-5551234',
          rate: expect.objectContaining({
            fromPerBase: RATE,
            toPerBase: 1,
            date: DAY,
          }) as unknown,
        }),
      ],
    });

    // BD: lo recibido en el abono y la línea con su tasa congelada.
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: ticketPayment.id },
      select: { amount: true, tenderedAmount: true, cashSessionId: true },
    });
    expect(row.amount.toNumber()).toBe(45);
    expect(row.tenderedAmount?.toNumber()).toBe(50);
    expect(row.cashSessionId).toBe(sessionId);

    const balance = (
      await as(api().get(`/api/v1/treatment-plans/${planId}/balance`)).expect(
        200,
      )
    ).body as { paid: number };
    expect(balance.paid).toBe(45);

    const detail = await detailOf(sessionId);
    expect(lineOf(detail, 'USD', 'CASH')).toMatchObject({
      opening: 20,
      payments: 45,
      changeIn: 5,
      changeOut: 0,
      expected: 70,
    });
    expect(lineOf(detail, 'VES', 'TRANSFER')).toMatchObject({
      payments: 0,
      changeOut: 182.5,
      expected: -182.5,
    });
    // El fondo en VES efectivo no se toca: el vuelto salió por otro medio.
    expect(lineOf(detail, 'VES', 'CASH')?.expected).toBe(1000);
    expect(
      detail.payments?.find((p) => p.id === ticketPayment.id)?.cashChange,
    ).toMatchObject({ tendered: 50 });
  });

  it('el recibo muestra recibido, aplicado y vuelto con su tasa y su fecha', async () => {
    const receipt = (
      await asReception(
        api().get(`/api/v1/payments/${ticketPayment.id}/receipt`),
      ).expect(200)
    ).body as { snapshot: { cashChange?: Record<string, unknown> } };
    expect(receipt.snapshot.cashChange).toEqual({
      currency: 'USD',
      tendered: 50,
      applied: 45,
      collected: 45,
      remainderToCredit: 0,
      lines: [
        expect.objectContaining({
          paymentMethodName: 'Pago móvil',
          currency: 'VES',
          amount: 182.5,
          equivalentAmount: 5,
          reference: '0412-5551234',
          rate: expect.objectContaining({
            fromPerBase: RATE,
            date: DAY,
          }) as unknown,
        }),
      ],
    });
  });

  it('la auditoría del abono lleva sus líneas de vuelto, sin la referencia', async () => {
    const event = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'PAYMENT',
        resourceId: ticketPayment.id,
        action: 'CREATE',
      },
      select: { metadata: true },
    });
    expect((event.metadata as { cashChange?: unknown }).cashChange).toEqual({
      currency: 'USD',
      tendered: 50,
      remainderToCredit: 0,
      lines: [
        {
          currency: 'VES',
          amount: 182.5,
          method: 'TRANSFER',
          equivalentAmount: 5,
          hasReference: true,
        },
      ],
    });
    expect(JSON.stringify(event.metadata)).not.toContain('5551234');
  });

  it('el vuelto no puede superar lo recibido menos lo aplicado (422) y el medio que pide referencia la exige (400)', async () => {
    await pay({ tendered: 50, change: [vesChange(200)] }).expect(422);
    await pay({
      tendered: 50,
      change: [{ ...vesChange(), reference: undefined }],
    }).expect(400);
    // «Recibido» solo en efectivo.
    const methods = (await as(api().get('/api/v1/payment-methods')).expect(200))
      .body as { id: string; legacyMethod: string | null }[];
    await pay({
      paymentMethodId: methods.find((m) => m.legacyMethod === 'TRANSFER')!.id,
      reference: 'T-1',
      tendered: 50,
    }).expect(400);
  });

  it('la diferencia sin devolver va a saldo a favor con aviso: 422 con el resto y, confirmada, se suma al abono', async () => {
    const warned = await pay({
      tendered: 50,
      change: [vesChange(109.5)],
    }).expect(422);
    expect(warned.body).toMatchObject({
      code: 'CASH_CHANGE_REMAINDER',
      remainder: 2,
      currency: 'USD',
    });
    const before = await expectedOf('USD', 'CASH');
    const confirmed = (
      await pay({
        tendered: 50,
        change: [vesChange(109.5)],
        changeRemainderToCredit: true,
      }).expect(201)
    ).body as PaymentBody;
    expect(confirmed.amount).toBe(47);
    expect(confirmed.cashChange?.remainderToCredit).toBe(2);
    expect(await expectedOf('USD', 'CASH')).toBe(before + 50);
    await voidPayment(confirmed.id).expect(200);
  });

  it('sin «Recibido», el cobro funciona como hoy', async () => {
    const before = await expectedOf('USD', 'CASH');
    const plain = (await pay({}).expect(201)).body as PaymentBody;
    expect(plain.cashChange).toBeNull();
    expect(await expectedOf('USD', 'CASH')).toBe(before + 45);
    await voidPayment(plain.id).expect(200);
    expect(await expectedOf('USD', 'CASH')).toBe(before);
  });

  it('anular con la caja abierta revierte también el vuelto', async () => {
    const usd = await expectedOf('USD', 'CASH');
    const ves = await expectedOf('VES', 'TRANSFER');
    const p = (await pay({ tendered: 50, change: [vesChange()] }).expect(201))
      .body as PaymentBody;
    expect(await expectedOf('USD', 'CASH')).toBe(usd + 50);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(ves - 182.5);
    await voidPayment(p.id).expect(200);
    expect(await expectedOf('USD', 'CASH')).toBe(usd);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(ves);
  });

  it('concurrencia: dos abonos con vuelto y una anulación a la vez sobre la misma caja cuadran', async () => {
    const usd = await expectedOf('USD', 'CASH');
    const ves = await expectedOf('VES', 'TRANSFER');
    const victim = (
      await pay({ tendered: 50, change: [vesChange()] }).expect(201)
    ).body as PaymentBody;
    const [a, b, voided] = await Promise.all([
      pay({ tendered: 50, change: [vesChange(182.5, 'A-1')] }),
      pay({
        tendered: 50,
        change: [{ paymentMethodId: cashMethod, currency: 'USD', amount: 5 }],
      }),
      voidPayment(victim.id),
    ]);
    expect([a.status, b.status, voided.status]).toEqual([201, 201, 200]);
    // a: +50 USD efectivo, −182,50 VES transferencia; b: +45 USD efectivo
    // neto (50 entran, 5 salen); la anulada no cuenta.
    expect(await expectedOf('USD', 'CASH')).toBe(usd + 95);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(ves - 182.5);
    const lines = await raw.paymentChangeLine.count({
      where: {
        tenantId: clinic.tenantId,
        paymentId: {
          in: [(a.body as PaymentBody).id, (b.body as PaymentBody).id],
        },
      },
    });
    expect(lines).toBe(2);
  });

  it('con la caja cerrada (DX-345): anular es VOID −50 USD y CHANGE_VOID +182,50 VES en la caja abierta de quien anula', async () => {
    const p = (await pay({ tendered: 50, change: [vesChange()] }).expect(201))
      .body as PaymentBody;
    const firstSession = sessionId;
    await closeSession(firstSession);
    sessionId = await openSession();

    await voidPayment(p.id).expect(200);
    const adjustments = await raw.cashSessionAdjustment.findMany({
      where: {
        OR: [{ paymentId: p.id }, { changeLine: { paymentId: p.id } }],
      },
      orderBy: { kind: 'asc' },
    });
    expect(
      adjustments.map((a) => [
        a.kind,
        a.currency,
        a.method,
        a.amount.toNumber(),
        a.sessionId,
        a.originalSessionId,
      ]),
    ).toEqual([
      ['VOID', 'USD', 'CASH', -50, sessionId, firstSession],
      ['CHANGE_VOID', 'VES', 'TRANSFER', 182.5, sessionId, firstSession],
    ]);
    // La caja nueva: fondo + los dos ajustes.
    expect(await expectedOf('USD', 'CASH')).toBe(20 - 50);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(182.5);
    const detail = await detailOf(sessionId);
    expect(detail.adjustments?.map((a) => [a.kind, a.payment?.id])).toEqual(
      expect.arrayContaining([
        ['VOID', p.id],
        ['CHANGE_VOID', p.id],
      ]),
    );
  });

  it('abono tardío (día de una caja cerrada): LATE_PAYMENT +50 y CHANGE_LATE −182,50 en la caja abierta', async () => {
    const usd = await expectedOf('USD', 'CASH');
    const ves = await expectedOf('VES', 'TRANSFER');
    const p = (
      await pay({
        paidAt: CLOSED_DAY,
        tendered: 50,
        change: [vesChange()],
      }).expect(201)
    ).body as PaymentBody;
    const adjustments = await raw.cashSessionAdjustment.findMany({
      where: {
        OR: [{ paymentId: p.id }, { changeLine: { paymentId: p.id } }],
      },
      orderBy: { kind: 'asc' },
    });
    expect(
      adjustments.map((a) => [
        a.kind,
        a.amount.toNumber(),
        a.originalSessionId,
      ]),
    ).toEqual([
      ['LATE_PAYMENT', 50, closedSession],
      ['CHANGE_LATE', -182.5, closedSession],
    ]);
    expect(await expectedOf('USD', 'CASH')).toBe(usd + 50);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(ves - 182.5);
    // Anularlo con su caja abierta compensa los dos en la misma caja.
    await voidPayment(p.id).expect(200);
    expect(await expectedOf('USD', 'CASH')).toBe(usd);
    expect(await expectedOf('VES', 'TRANSFER')).toBe(ves);
  });

  it('arqueo ciego (SEC-043): recepción no ve el esperado ni los abonos con su vuelto', async () => {
    await as(api().put('/api/v1/cash-sessions/settings'))
      .send({ requireOpenSession: false, blindClose: true })
      .expect(200);
    try {
      const detail = await detailOf(sessionId);
      expect(detail.expected).toBeNull();
      expect(detail.payments).toBeNull();
      expect(detail.adjustments).toBeNull();
    } finally {
      await as(api().put('/api/v1/cash-sessions/settings'))
        .send({ requireOpenSession: false, blindClose: false })
        .expect(200);
    }
  });

  describe('la BD repite las reglas (red bajo la API)', () => {
    /** Como la app: rol sin privilegios y la clínica en la sesión (RLS). */
    const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE dentalix_app`);
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_tenant = '${clinic.tenantId}'`,
        );
        return fn(tx);
      });

    it('lo recibido no cambia, ni el importe de un abono con vuelto', async () => {
      await expect(
        asApp(
          (tx) => tx.$executeRaw`UPDATE "payments" SET "tenderedAmount" = 60
            WHERE "id" = ${ticketPayment.id}::uuid`,
        ),
      ).rejects.toThrow(/no cambia/);
      await expect(
        asApp(
          (tx) => tx.$executeRaw`UPDATE "payments" SET "amount" = 40
            WHERE "id" = ${ticketPayment.id}::uuid`,
        ),
      ).rejects.toThrow(/no cambia/);
    });

    it('una línea de vuelto no se edita ni se borra', async () => {
      await expect(
        asApp(
          (tx) => tx.$executeRaw`UPDATE "payment_change_lines" SET "amount" = 1
            WHERE "paymentId" = ${ticketPayment.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|inalterable/);
      await expect(
        asApp(
          (tx) => tx.$executeRaw`DELETE FROM "payment_change_lines"
            WHERE "paymentId" = ${ticketPayment.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|no admite/);
    });

    it('un abono con «Recibido» que no cuadra no llega al COMMIT', async () => {
      const source = await raw.payment.findUniqueOrThrow({
        where: { id: ticketPayment.id },
      });
      await expect(
        raw.payment.create({
          data: {
            tenantId: source.tenantId,
            locationId: source.locationId,
            treatmentPlanId: source.treatmentPlanId,
            patientId: source.patientId,
            amount: 45,
            currency: 'USD',
            paidAt: source.paidAt,
            method: 'CASH',
            exchangeRateCurrency: 'USD',
            tenderedAmount: 50,
          },
        }),
      ).rejects.toThrow(/no cuadra|Q3570/);
    });
  });
});
