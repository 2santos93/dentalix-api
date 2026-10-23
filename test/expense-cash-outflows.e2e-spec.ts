import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-274 · Salidas de caja menor en el arqueo: recepción paga algo con el
// dinero del cajón → el efectivo esperado baja → el cierre cuadra. Una salida
// anulada con la caja abierta deja de restar; con la caja cerrada sigue
// restando allí y su anulación es un ajuste OUTFLOW_VOID positivo en la caja
// abierta de quien anula (o pendiente de la siguiente de la sede). Arqueo
// ciego sin esperado, recepción solo desde su caja, «exigir caja abierta» y el
// pago de un gasto «Desde mi caja» (R1). Todo por la API.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const BOGOTA = 'America/Bogota';
const today = (): string => civilDateIn(new Date(), BOGOTA);
const KEY = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

const OPEN_REQUIRED = 'Abre tu caja en esta sede para pagar desde el cajón.';
const CASH_ALWAYS_IN_SESSION =
  'Esta clínica registra el efectivo siempre en una caja abierta: marca «Desde mi caja».';

interface Line {
  currency: string;
  method: string;
  opening: number;
  payments: number;
  adjustments: number;
  outflows: number;
  outflowsCount: number;
  expected: number;
}

interface Outflow {
  id: string;
  expenseId: string;
  category: string;
  supplier: string | null;
  amount: number;
  currency: string;
  createdBy: { id: string };
  voidReason?: string | null;
  bookedAsAdjustment?: boolean;
}

interface Adjustment {
  kind: string;
  amount: number;
  sessionId: string | null;
  reason: string | null;
  expensePayment: { id: string; expenseId: string; category: string } | null;
  originalSession: { id: string } | null;
}

interface Detail {
  id: string;
  status: string;
  blindHidden: boolean;
  expected: Line[] | null;
  outflows: Outflow[];
  voidedOutflows: Outflow[];
  adjustments: Adjustment[];
  laterAdjustments: Adjustment[];
  closing: {
    hasDifference: boolean;
    lines: { currency: string; method: string; expected: number }[];
  } | null;
}

interface Expense {
  id: string;
  locationId: string;
  invoiceDate: string;
  status: string;
  amount: number;
  payments: {
    id: string;
    method: string;
    paidOn: string;
    cashSessionId: string | null;
    voidedAt: string | null;
  }[];
}

const detailOf = (res: { body: unknown }): Detail => res.body as Detail;
const expenseOf = (res: { body: unknown }): Expense => res.body as Expense;
const messageOf = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;
const cashLine = (detail: Detail) =>
  detail.expected?.find((l) => l.currency === 'COP' && l.method === 'CASH');

describe('Salidas de caja menor en el arqueo (e2e, DX-274)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let receptionToken: string;
  let receptionId: string;
  let dentistToken: string;
  let sedePrincipal: string;
  let sedeNorte: string;
  let adminSession: string;
  let receptionSession: string;
  /** La primera salida de recepción (15 000), que se anula tras el cierre. */
  let firstOutflow: Expense;

  const server = () => app.getHttpServer();
  const api = (
    verb: 'get' | 'post' | 'put',
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

  const outflow = (
    body: Record<string, unknown>,
    token = receptionToken,
    /** `null` = sin X-Location-Id. */
    locationId: string | null = sedePrincipal,
    key?: string,
  ) => {
    const req = api(
      'post',
      '/cash-sessions/current/outflows',
      token,
      locationId ?? undefined,
    );
    return (key ? req.set('Idempotency-Key', key) : req).send({
      category: 'Mensajería',
      currency: 'COP',
      ...body,
    });
  };

  const open = (
    token: string,
    locationId: string,
    floats: { currency: string; amount: number }[] = [],
  ) =>
    api('post', '/cash-sessions/open', token, locationId)
      .send({ floats })
      .expect(201)
      .then((res) => detailOf(res).id);

  const detail = (id: string, token = clinic.adminToken) =>
    api('get', `/cash-sessions/${id}`, token).expect(200).then(detailOf);

  const close = (id: string, counted: number, token = receptionToken) =>
    api('post', `/cash-sessions/${id}/close`, token)
      .send({ counts: [{ currency: 'COP', method: 'CASH', counted }] })
      .expect(201)
      .then(detailOf);

  const voidPayment = (expenseId: string, paymentId: string, reason: string) =>
    api('post', `/expenses/${expenseId}/payments/${paymentId}/void`)
      .send({ reason })
      .expect(200);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'caja-salidas');
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    receptionId = reception.userId;
    receptionToken = await loginAs(app, clinic.host, reception.email);
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinic.host, dentist.email);
    sedePrincipal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    sedeNorte = (
      (await api('post', '/locations').send({ name: 'Sede Norte' }).expect(201))
        .body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('roles: odontología no registra salidas; recepción sin caja propia es 409 aunque otro tenga la suya abierta', async () => {
    await outflow({ amount: 1_000 }, dentistToken).expect(403);
    adminSession = await open(clinic.adminToken, sedePrincipal);
    const refused = await outflow({ amount: 1_000 }).expect(409);
    expect(messageOf(refused)).toBe(OPEN_REQUIRED);
    // La caja del ADMIN no es de recepción: ni la ve.
    await api('get', `/cash-sessions/${adminSession}`, receptionToken).expect(
      404,
    );
    // Recepción no gestiona gastos (solo registra salidas desde su caja).
    await api('post', '/expenses', receptionToken)
      .send({ category: 'Papelería', amount: 1, currency: 'COP' })
      .expect(403);
    expect(
      await raw.expense.count({ where: { tenantId: clinic.tenantId } }),
    ).toBe(0);
  });

  it('salida → el efectivo esperado baja; repetir con la misma clave no duplica', async () => {
    receptionSession = await open(receptionToken, sedePrincipal, [
      { currency: 'COP', amount: 100_000 },
    ]);
    const res = await outflow(
      {
        amount: 15_000,
        supplier: ' Rappi ',
        description: 'Envío al laboratorio',
      },
      receptionToken,
      sedePrincipal,
      KEY,
    ).expect(201);
    firstOutflow = expenseOf(res);
    expect(firstOutflow).toMatchObject({
      locationId: sedePrincipal,
      invoiceDate: today(),
      status: 'PAID',
      amount: 15_000,
    });
    expect(firstOutflow.payments).toEqual([
      expect.objectContaining({
        method: 'CASH',
        paidOn: today(),
        cashSessionId: receptionSession,
      }),
    ]);
    // La respuesta es el gasto, nunca el esperado de la caja.
    expect(JSON.stringify(res.body)).not.toMatch(/expected/i);

    const again = await outflow(
      {
        amount: 15_000,
        supplier: 'Rappi',
        description: 'Envío al laboratorio',
      },
      receptionToken,
      sedePrincipal,
      KEY,
    ).expect(201);
    expect(expenseOf(again).id).toBe(firstOutflow.id);
    await outflow(
      { amount: 99, description: 'Otra cosa' },
      receptionToken,
      sedePrincipal,
      KEY,
    ).expect(422);
    expect(
      await raw.expensePayment.count({
        where: { cashSessionId: receptionSession },
      }),
    ).toBe(1);

    const seen = await detail(receptionSession, receptionToken);
    expect(cashLine(seen)).toMatchObject({
      opening: 100_000,
      outflows: 15_000,
      outflowsCount: 1,
      expected: 85_000,
    });
    expect(seen.outflows).toEqual([
      expect.objectContaining({
        id: firstOutflow.payments[0].id,
        expenseId: firstOutflow.id,
        category: 'Mensajería',
        supplier: 'Rappi',
        amount: 15_000,
        currency: 'COP',
        createdBy: expect.objectContaining({ id: receptionId }) as unknown,
      }),
    ]);
  });

  it('con X-Location-Id de otra sede, la caja tiene que estar en esa sede (409)', async () => {
    const res = await outflow(
      { amount: 1_000 },
      receptionToken,
      sedeNorte,
    ).expect(409);
    expect(messageOf(res)).toBe(OPEN_REQUIRED);
  });

  it('ADMIN paga un gasto «Desde mi caja»: efectivo, hoy y su caja abierta en la sede del gasto', async () => {
    const created = expenseOf(
      await api('post', '/expenses')
        .send({
          locationId: sedePrincipal,
          category: 'Laboratorio',
          amount: 50_000,
          currency: 'COP',
          invoiceDate: today(),
          payment: { amount: 20_000, method: 'CASH', fromCashSession: true },
        })
        .expect(201),
    );
    expect(created.payments[0]).toMatchObject({ cashSessionId: adminSession });

    const card = await api('post', `/expenses/${created.id}/payments`)
      .send({ amount: 1_000, method: 'CARD', fromCashSession: true })
      .expect(400);
    expect(messageOf(card)).toBe(
      'Un pago desde la caja es siempre en efectivo.',
    );
    await api('post', `/expenses/${created.id}/payments`)
      .send({
        amount: 1_000,
        method: 'CASH',
        paidOn: addCivilDays(today(), -1),
        fromCashSession: true,
      })
      .expect(400);
    const paid = expenseOf(
      await api('post', `/expenses/${created.id}/payments`)
        .send({ amount: 5_000, method: 'CASH', fromCashSession: true })
        .expect(201),
    );
    expect(paid.payments.map((p) => p.cashSessionId)).toEqual([
      adminSession,
      adminSession,
    ]);

    // En la otra sede el ADMIN no tiene caja abierta.
    const norte = await api('post', '/expenses')
      .send({
        locationId: sedeNorte,
        category: 'Laboratorio',
        amount: 1_000,
        currency: 'COP',
        invoiceDate: today(),
        payment: { amount: 1_000, method: 'CASH', fromCashSession: true },
      })
      .expect(409);
    expect(messageOf(norte)).toBe(OPEN_REQUIRED);

    // El esperado puede quedar negativo (no se rechaza: R5/R6).
    expect(cashLine(await detail(adminSession))).toMatchObject({
      outflows: 25_000,
      outflowsCount: 2,
      expected: -25_000,
    });
  });

  it('anular una salida con la caja abierta: deja de restar y sale en «Salidas anuladas», sin ajuste', async () => {
    const second = expenseOf(
      await outflow({ amount: 5_000, category: 'Aseo y cafetería' }).expect(
        201,
      ),
    );
    expect(cashLine(await detail(receptionSession))?.expected).toBe(80_000);
    await voidPayment(
      second.id,
      second.payments[0].id,
      'Se devolvió el dinero',
    );
    const seen = await detail(receptionSession, receptionToken);
    expect(cashLine(seen)).toMatchObject({
      outflows: 15_000,
      outflowsCount: 1,
      expected: 85_000,
    });
    expect(seen.voidedOutflows).toEqual([
      expect.objectContaining({
        id: second.payments[0].id,
        category: 'Aseo y cafetería',
        voidReason: 'Se devolvió el dinero',
        bookedAsAdjustment: false,
      }),
    ]);
    expect(
      await raw.cashSessionAdjustment.count({
        where: { tenantId: clinic.tenantId, kind: 'OUTFLOW_VOID' },
      }),
    ).toBe(0);
  });

  it('el cierre con lo contado = esperado tras las salidas no tiene diferencia', async () => {
    const closed = await close(receptionSession, 85_000);
    expect(closed.status).toBe('CLOSED');
    expect(closed.closing).toMatchObject({
      hasDifference: false,
      lines: [expect.objectContaining({ method: 'CASH', expected: 85_000 })],
    });
  });

  it('anular tras el cierre: la caja cerrada no cambia y la anulación es un OUTFLOW_VOID positivo en la caja abierta de quien anula', async () => {
    await api('post', `/expenses/${firstOutflow.id}/void`)
      .send({ reason: 'Factura duplicada del mensajero' })
      .expect(200);

    const closed = await detail(receptionSession);
    expect(cashLine(closed)).toMatchObject({
      outflows: 15_000,
      outflowsCount: 1,
      expected: 85_000,
    });
    expect(closed.closing?.lines[0].expected).toBe(85_000);
    expect(closed.outflows).toEqual([]);
    expect(closed.voidedOutflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstOutflow.payments[0].id,
          bookedAsAdjustment: true,
        }),
      ]),
    );
    expect(closed.laterAdjustments).toEqual([
      expect.objectContaining({
        kind: 'OUTFLOW_VOID',
        amount: 15_000,
        sessionId: adminSession,
        reason: 'Factura duplicada del mensajero',
        expensePayment: expect.objectContaining({
          id: firstOutflow.payments[0].id,
          expenseId: firstOutflow.id,
          category: 'Mensajería',
        }) as unknown,
      }),
    ]);

    const admin = await detail(adminSession);
    expect(admin.adjustments).toEqual([
      expect.objectContaining({
        kind: 'OUTFLOW_VOID',
        amount: 15_000,
        originalSession: expect.objectContaining({
          id: receptionSession,
        }) as unknown,
      }),
    ]);
    expect(cashLine(admin)).toMatchObject({
      adjustments: 15_000,
      outflows: 25_000,
      expected: -10_000,
    });
  });

  it('sin caja abierta de quien anula, el ajuste queda pendiente y entra en la siguiente caja de la sede', async () => {
    const norte = await open(receptionToken, sedeNorte, [
      { currency: 'COP', amount: 30_000 },
    ]);
    const paid = expenseOf(
      await outflow({ amount: 7_000 }, receptionToken, sedeNorte).expect(201),
    );
    await close(norte, 23_000);
    // El ADMIN no tiene caja en la Norte.
    await voidPayment(paid.id, paid.payments[0].id, 'Compra cancelada');
    const pending = await raw.cashSessionAdjustment.findFirstOrThrow({
      where: { expensePaymentId: paid.payments[0].id },
    });
    expect(pending).toMatchObject({
      kind: 'OUTFLOW_VOID',
      sessionId: null,
      originalSessionId: norte,
      method: 'CASH',
    });
    expect(pending.amount.toNumber()).toBe(7_000);

    const next = await open(receptionToken, sedeNorte);
    const seen = await detail(next, receptionToken);
    expect(seen.adjustments).toEqual([
      expect.objectContaining({ kind: 'OUTFLOW_VOID', amount: 7_000 }),
    ]);
    expect(cashLine(seen)?.expected).toBe(7_000);
    expect(cashLine(await detail(norte))).toMatchObject({
      outflows: 7_000,
      expected: 23_000,
    });
  });

  it('con cajas abiertas en dos sedes y sin X-Location-Id, hay que elegir (409)', async () => {
    await open(receptionToken, sedePrincipal);
    const res = await outflow({ amount: 1_000 }, receptionToken, null).expect(
      409,
    );
    expect(messageOf(res)).toMatch(/varias sedes/);
  });

  it('arqueo ciego: la salida y la caja actual de recepción no muestran el esperado; la lista de salidas sí', async () => {
    await api('put', '/cash-sessions/settings')
      .send({ requireOpenSession: false, blindClose: true })
      .expect(200);
    const res = await outflow({ amount: 2_000 }).expect(201);
    expect(JSON.stringify(res.body)).not.toMatch(/expected/i);

    const current = await api(
      'get',
      '/cash-sessions/current',
      receptionToken,
      sedePrincipal,
    ).expect(200);
    const session = (current.body as { session: Detail }).session;
    expect(session).toMatchObject({ blindHidden: true, expected: null });
    expect(session.outflows).toEqual([
      expect.objectContaining({ amount: 2_000 }),
    ]);
    // El ADMIN sí ve el esperado de esa caja.
    expect(cashLine(await detail(session.id))).toMatchObject({
      outflows: 2_000,
      expected: -2_000,
    });
  });

  it('«exigir caja abierta»: el efectivo fuera de caja es 409 con la indicación; «Desde mi caja» entra', async () => {
    await api('put', '/cash-sessions/settings')
      .send({ requireOpenSession: true, blindClose: false })
      .expect(200);
    const refused = await api('post', '/expenses')
      .send({
        locationId: sedePrincipal,
        category: 'Papelería',
        amount: 3_000,
        currency: 'COP',
        invoiceDate: today(),
        payment: { amount: 3_000, method: 'CASH' },
      })
      .expect(409);
    expect(messageOf(refused)).toBe(CASH_ALWAYS_IN_SESSION);
    const ok = expenseOf(
      await api('post', '/expenses')
        .send({
          locationId: sedePrincipal,
          category: 'Papelería',
          amount: 3_000,
          currency: 'COP',
          invoiceDate: today(),
          payment: { amount: 3_000, method: 'CASH', fromCashSession: true },
        })
        .expect(201),
    );
    expect(ok.payments[0].cashSessionId).toBe(adminSession);
    // La salida de recepción va siempre desde su caja: no le afecta.
    await outflow({ amount: 500 }).expect(201);
  });
});
