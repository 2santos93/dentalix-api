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
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';

// DX-027 · Caja por turno: abrir con fondo → cobrar → anular → cerrar con
// arqueo (esperado vs contado, motivo si no cuadra) → cierre inmutable →
// anulación posterior como ajuste en la caja siguiente → abono tardío →
// reapertura y corrección del ADMIN → «exigir caja abierta» y «arqueo ciego»,
// con roles (RECEPTION solo las suyas) y aislamiento entre clínicas. Todo por
// la API salvo la siembra de un plan y de una caja de AYER (DIRECT_URL).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const BOGOTA = 'America/Bogota';
const today = (): string => civilDateIn(new Date(), BOGOTA);

interface Line {
  currency: string;
  method: string;
  opening: number;
  payments: number;
  adjustments: number;
  expected: number;
}

interface Adjustment {
  id: string;
  kind: string;
  amount: number;
  sessionId: string | null;
  payment: { id: string } | null;
  originalSession: { id: string } | null;
}

interface Detail {
  id: string;
  status: string;
  openedBy: { id: string; fullName: string | null };
  location: { id: string; name: string };
  floats: { currency: string; amount: number }[];
  differences: { currency: string; amount: number }[];
  blindHidden: boolean;
  expected: Line[] | null;
  payments: { id: string }[] | null;
  voidedPayments: { id: string; bookedAsAdjustment: boolean }[];
  adjustments: Adjustment[];
  laterAdjustments: Adjustment[];
  closing: {
    sequence: number;
    hasDifference: boolean;
    differenceReason: string | null;
    suggestedLockDate: string;
    lines: {
      currency: string;
      method: string;
      expected: number;
      counted: number;
      difference: number;
    }[];
  } | null;
  closings: { sequence: number }[];
  reopenings: { reason: string }[];
  can: { close: boolean; reopen: boolean; adjust: boolean };
}

/** `expect.objectContaining` tipado (anidado, sin `any`). */
const containing = (shape: object): unknown => expect.objectContaining(shape);
const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;
const detailOf = (res: { body: unknown }): Detail => res.body as Detail;
const lineOf = (detail: Detail, currency: string, method: string) =>
  detail.expected?.find((l) => l.currency === currency && l.method === method);

describe('Caja por turno (e2e, DX-027)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let receptionToken: string;
  let receptionId: string;
  let dentistToken: string;
  let sedePrincipal: string;
  let sedeNorte: string;
  let planId: string;
  let sessionId: string;

  const server = () => app.getHttpServer();
  const api = (
    clinic: Clinic,
    verb: 'get' | 'post' | 'put' | 'delete',
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

  const pay = (
    token: string,
    body: { amount: number; method: string; paidAt?: string },
    locationId = sedePrincipal,
  ) =>
    api(
      clinicA,
      'post',
      `/treatment-plans/${planId}/payments`,
      token,
      locationId,
    ).send({
      currency: 'COP',
      paidAt: today(),
      ...body,
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'caja-turno-a');
    clinicB = await registerClinic(app, 'caja-turno-b');
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionId = reception.userId;
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinicA.host, dentist.email);

    sedePrincipal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        select: { id: true },
      })
    ).id;
    const norte = await api(clinicA, 'post', '/locations')
      .send({ name: 'Sede Norte' })
      .expect(201);
    sedeNorte = (norte.body as { id: string }).id;

    const patient = await raw.patient.create({
      data: {
        tenantId: clinicA.tenantId,
        firstName: 'Ana',
        lastName: 'Caja',
        docNumber: '1027',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: clinicA.tenantId,
          patientId: patient.id,
          currency: 'COP',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('los ajustes de caja nacen con el comportamiento de hoy y solo ADMIN los cambia', async () => {
    const res = await api(
      clinicA,
      'get',
      '/cash-sessions/settings',
      receptionToken,
    ).expect(200);
    expect(res.body).toEqual({ requireOpenSession: false, blindClose: false });
    await api(clinicA, 'put', '/cash-sessions/settings', receptionToken)
      .send({ requireOpenSession: true, blindClose: false })
      .expect(403);
    await api(clinicA, 'get', '/cash-sessions', dentistToken).expect(403);
  });

  it('sin caja abierta y sin «exigir caja», el abono en efectivo se registra como hoy (sin caja)', async () => {
    const res = await pay(receptionToken, {
      amount: 1_000,
      method: 'CASH',
    }).expect(201);
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: (res.body as { id: string }).id },
      select: { cashSessionId: true },
    });
    expect(row.cashSessionId).toBeNull();
  });

  it('RECEPTION abre su caja con fondo; otra en la misma sede es 409', async () => {
    const opened = await api(
      clinicA,
      'post',
      '/cash-sessions/open',
      receptionToken,
      sedePrincipal,
    )
      .send({
        floats: [{ currency: 'cop', amount: 50_000 }],
        notes: 'Turno mañana',
      })
      .expect(201);
    const detail = detailOf(opened);
    sessionId = detail.id;
    expect(detail).toMatchObject({
      status: 'OPEN',
      openedBy: { id: receptionId },
      location: { id: sedePrincipal },
      floats: [{ currency: 'COP', amount: 50_000 }],
      can: { close: true, reopen: false, adjust: false },
    });
    await api(
      clinicA,
      'post',
      '/cash-sessions/open',
      receptionToken,
      sedePrincipal,
    )
      .send({ floats: [] })
      .expect(409);
    const current = await api(
      clinicA,
      'get',
      '/cash-sessions/current',
      receptionToken,
      sedePrincipal,
    ).expect(200);
    expect((current.body as { session: { id: string } }).session.id).toBe(
      sessionId,
    );
  });

  let cashId: string;
  let cardId: string;
  let voidedId: string;

  it('los abonos de RECEPTION entran en su caja; anular uno lo saca del esperado y lo lista aparte', async () => {
    cashId = idOf(
      await pay(receptionToken, { amount: 30_000, method: 'CASH' }).expect(201),
    );
    cardId = idOf(
      await pay(receptionToken, { amount: 80_000, method: 'CARD' }).expect(201),
    );
    voidedId = idOf(
      await pay(receptionToken, { amount: 5_000, method: 'CASH' }).expect(201),
    );
    // Un abono del ADMIN (sin caja abierta) no entra en la de recepción.
    await pay(clinicA.adminToken, { amount: 7_000, method: 'CASH' }).expect(
      201,
    );
    await api(clinicA, 'delete', `/payments/${voidedId}`, receptionToken)
      .send({ reason: 'Cobro duplicado' })
      .expect(200);

    const detail = detailOf(
      await api(
        clinicA,
        'get',
        `/cash-sessions/${sessionId}`,
        receptionToken,
      ).expect(200),
    );
    expect(lineOf(detail, 'COP', 'CASH')).toMatchObject({
      opening: 50_000,
      payments: 30_000,
      adjustments: 0,
      expected: 80_000,
    });
    expect(lineOf(detail, 'COP', 'CARD')).toMatchObject({ expected: 80_000 });
    expect(detail.payments?.map((p) => p.id).sort()).toEqual(
      [cashId, cardId].sort(),
    );
    expect(detail.voidedPayments).toEqual([
      expect.objectContaining({ id: voidedId, bookedAsAdjustment: false }),
    ]);
  });

  it('RECEPTION solo ve y cierra las suyas; ADMIN ve todas', async () => {
    const adminSession = detailOf(
      await api(
        clinicA,
        'post',
        '/cash-sessions/open',
        clinicA.adminToken,
        sedeNorte,
      )
        .send({ floats: [] })
        .expect(201),
    );
    await api(
      clinicA,
      'get',
      `/cash-sessions/${adminSession.id}`,
      receptionToken,
    ).expect(404);
    await api(
      clinicA,
      'post',
      `/cash-sessions/${adminSession.id}/close`,
      receptionToken,
    )
      .send({ counts: [] })
      .expect(404);
    const mine = await api(
      clinicA,
      'get',
      '/cash-sessions',
      receptionToken,
    ).expect(200);
    expect(
      (mine.body as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual([sessionId]);
    const all = await api(
      clinicA,
      'get',
      '/cash-sessions',
      clinicA.adminToken,
    ).expect(200);
    expect((all.body as { total: number }).total).toBe(2);
    const norteOnly = await api(
      clinicA,
      'get',
      `/cash-sessions?locationId=${sedeNorte}&from=${today()}&to=${today()}`,
      clinicA.adminToken,
    ).expect(200);
    expect(
      (norteOnly.body as { items: { id: string }[] }).items.map((i) => i.id),
    ).toEqual([adminSession.id]);
    // El ADMIN cierra la suya (vacía, cuadrada) para no interferir.
    await api(clinicA, 'post', `/cash-sessions/${adminSession.id}/close`)
      .send({ counts: [] })
      .expect(201);
  });

  it('cerrar: una diferencia sin motivo es 400; con motivo guarda esperado, contado y diferencia y la fecha de bloqueo', async () => {
    const counts = [
      { currency: 'COP', method: 'CASH', counted: 79_000 },
      { currency: 'COP', method: 'CARD', counted: 80_000 },
    ];
    await api(
      clinicA,
      'post',
      `/cash-sessions/${sessionId}/close`,
      receptionToken,
    )
      .send({ counts })
      .expect(400);
    const closed = detailOf(
      await api(
        clinicA,
        'post',
        `/cash-sessions/${sessionId}/close`,
        receptionToken,
      )
        .send({ counts, differenceReason: 'Faltó cambio en monedas' })
        .expect(201),
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.closing).toMatchObject({
      sequence: 1,
      hasDifference: true,
      differenceReason: 'Faltó cambio en monedas',
      suggestedLockDate: today(),
    });
    expect(closed.closing?.lines).toEqual([
      {
        currency: 'COP',
        method: 'CASH',
        opening: 50_000,
        expected: 80_000,
        counted: 79_000,
        difference: -1_000,
      },
      {
        currency: 'COP',
        method: 'CARD',
        opening: 0,
        expected: 80_000,
        counted: 80_000,
        difference: 0,
      },
    ]);
    expect(closed.differences).toEqual([{ currency: 'COP', amount: -1_000 }]);

    const audit = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'CASH_SESSION',
        resourceId: sessionId,
      },
      select: { action: true, actorUserId: true, metadata: true },
    });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'UPDATE',
          actorUserId: receptionId,
          metadata: containing({ reason: 'CASH_SESSION_CLOSED' }),
        }),
      ]),
    );
  });

  it('un cierre no se edita: cerrar otra vez es 409 y la caja ya no recibe abonos', async () => {
    await api(
      clinicA,
      'post',
      `/cash-sessions/${sessionId}/close`,
      receptionToken,
    )
      .send({ counts: [], differenceReason: 'Otra vez' })
      .expect(409);
    const late = await pay(receptionToken, {
      amount: 2_000,
      method: 'CASH',
    }).expect(201);
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: (late.body as { id: string }).id },
      select: { cashSessionId: true },
    });
    expect(row.cashSessionId).toBeNull();
  });

  let nextSessionId: string;

  it('anular un abono de una caja cerrada no la cambia: es un ajuste (pendiente) que entra en la siguiente caja de la sede', async () => {
    // El ADMIN anula sin caja abierta en la sede principal: queda pendiente.
    await api(clinicA, 'delete', `/payments/${cashId}`)
      .send({ reason: 'Devuelto al paciente' })
      .expect(200);
    const original = detailOf(
      await api(clinicA, 'get', `/cash-sessions/${sessionId}`).expect(200),
    );
    expect(lineOf(original, 'COP', 'CASH')?.expected).toBe(80_000);
    expect(original.closing?.lines[0].counted).toBe(79_000);
    expect(original.voidedPayments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: cashId, bookedAsAdjustment: true }),
      ]),
    );
    expect(original.laterAdjustments).toEqual([
      expect.objectContaining({
        kind: 'VOID',
        amount: -30_000,
        sessionId: null,
        payment: containing({ id: cashId }),
      }),
    ]);

    nextSessionId = detailOf(
      await api(
        clinicA,
        'post',
        '/cash-sessions/open',
        receptionToken,
        sedePrincipal,
      )
        .send({ floats: [{ currency: 'COP', amount: 40_000 }] })
        .expect(201),
    ).id;
    const next = detailOf(
      await api(
        clinicA,
        'get',
        `/cash-sessions/${nextSessionId}`,
        receptionToken,
      ).expect(200),
    );
    expect(next.adjustments).toEqual([
      expect.objectContaining({
        kind: 'VOID',
        amount: -30_000,
        sessionId: nextSessionId,
        originalSession: containing({ id: sessionId }),
      }),
    ]);
    expect(lineOf(next, 'COP', 'CASH')).toMatchObject({
      opening: 40_000,
      adjustments: -30_000,
      expected: 10_000,
    });
  });

  it('un abono con fecha de un día cuya caja ya cerró es un ajuste de la caja abierta, con enlace a la cerrada', async () => {
    const yesterday = addCivilDays(today(), -1);
    const start = zonedStartOfDay(yesterday, BOGOTA).getTime();
    const hour = 60 * 60 * 1000;
    const closedYesterday = await raw.$transaction(async (tx) => {
      // Siembra de una caja de AYER: los triggers ponen la hora del servidor.
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      return tx.cashSession.create({
        data: {
          tenantId: clinicA.tenantId,
          locationId: sedeNorte,
          openedById: clinicA.adminUserId,
          openedAt: new Date(start + 8 * hour),
          status: 'CLOSED',
          closedAt: new Date(start + 18 * hour),
          closedById: clinicA.adminUserId,
        },
      });
    });
    const norteSession = detailOf(
      await api(
        clinicA,
        'post',
        '/cash-sessions/open',
        receptionToken,
        sedeNorte,
      )
        .send({ floats: [] })
        .expect(201),
    ).id;
    const late = (
      await pay(
        receptionToken,
        { amount: 12_000, method: 'TRANSFER', paidAt: yesterday },
        sedeNorte,
      ).expect(201)
    ).body as { id: string };

    const detail = detailOf(
      await api(
        clinicA,
        'get',
        `/cash-sessions/${norteSession}`,
        receptionToken,
      ).expect(200),
    );
    expect(detail.payments).toEqual([]);
    expect(detail.adjustments).toEqual([
      expect.objectContaining({
        kind: 'LATE_PAYMENT',
        amount: 12_000,
        payment: containing({ id: late.id }),
        originalSession: containing({ id: closedYesterday.id }),
      }),
    ]);
    expect(lineOf(detail, 'COP', 'TRANSFER')?.expected).toBe(12_000);

    // Anulado mientras su caja está abierta: se compensa en la misma caja.
    await api(clinicA, 'delete', `/payments/${late.id}`, receptionToken)
      .send({ reason: 'Transferencia rechazada' })
      .expect(200);
    const after = detailOf(
      await api(
        clinicA,
        'get',
        `/cash-sessions/${norteSession}`,
        receptionToken,
      ).expect(200),
    );
    expect(lineOf(after, 'COP', 'TRANSFER')?.expected).toBe(0);
    await api(
      clinicA,
      'post',
      `/cash-sessions/${norteSession}/close`,
      receptionToken,
    )
      .send({ counts: [] })
      .expect(201);
  });

  it('reabrir: solo ADMIN, con motivo y auditoría; el cierre anterior se conserva y el siguiente es la vuelta 2', async () => {
    await api(
      clinicA,
      'post',
      `/cash-sessions/${sessionId}/reopen`,
      receptionToken,
    )
      .send({ reason: 'Quiero reabrir' })
      .expect(403);
    await api(clinicA, 'post', `/cash-sessions/${sessionId}/reopen`)
      .send({ reason: 'x' })
      .expect(400);
    // Recepción tiene otra caja abierta en la sede: no se puede reabrir esta.
    await api(clinicA, 'post', `/cash-sessions/${sessionId}/reopen`)
      .send({ reason: 'Faltó un abono con tarjeta' })
      .expect(409);
    await api(
      clinicA,
      'post',
      `/cash-sessions/${nextSessionId}/close`,
      receptionToken,
    )
      .send({ counts: [{ currency: 'COP', method: 'CASH', counted: 10_000 }] })
      .expect(201);

    const reopened = detailOf(
      await api(clinicA, 'post', `/cash-sessions/${sessionId}/reopen`)
        .send({ reason: 'Faltó un abono con tarjeta' })
        .expect(201),
    );
    expect(reopened).toMatchObject({
      status: 'OPEN',
      closing: null,
      closings: [{ sequence: 1 }],
      reopenings: [{ reason: 'Faltó un abono con tarjeta' }],
    });
    await api(clinicA, 'post', `/cash-sessions/${sessionId}/reopen`)
      .send({ reason: 'Otra vez' })
      .expect(409);
    // El abono anulado tras el primer cierre sigue contando aquí (su
    // anulación es el ajuste de la caja siguiente): no se descuenta dos veces.
    expect(lineOf(reopened, 'COP', 'CASH')?.expected).toBe(80_000);
    const reclosed = detailOf(
      await api(
        clinicA,
        'post',
        `/cash-sessions/${sessionId}/close`,
        receptionToken,
      )
        .send({
          counts: [
            { currency: 'COP', method: 'CASH', counted: 80_000 },
            { currency: 'COP', method: 'CARD', counted: 80_000 },
          ],
        })
        .expect(201),
    );
    expect(reclosed.closings.map((c) => c.sequence)).toEqual([2, 1]);
    expect(reclosed.closing?.hasDifference).toBe(false);
    const audit = await raw.auditEvent.count({
      where: {
        tenantId: clinicA.tenantId,
        resourceId: sessionId,
        action: 'UPDATE',
        metadata: { path: ['reason'], equals: 'CASH_SESSION_REOPENED' },
      },
    });
    expect(audit).toBe(1);
  });

  it('corregir un cierre: solo ADMIN, un ajuste con motivo y autor (el cierre no cambia)', async () => {
    const body = {
      currency: 'COP',
      method: 'CASH',
      amount: -500,
      reason: 'Billete falso detectado',
    };
    await api(
      clinicA,
      'post',
      `/cash-sessions/${sessionId}/adjustments`,
      receptionToken,
    )
      .send(body)
      .expect(403);
    const created = await api(
      clinicA,
      'post',
      `/cash-sessions/${sessionId}/adjustments`,
    )
      .send(body)
      .expect(201);
    expect(created.body).toMatchObject({
      kind: 'CORRECTION',
      amount: -500,
      reason: 'Billete falso detectado',
      createdBy: { id: clinicA.adminUserId },
      originalSession: { id: sessionId },
    });
    await api(clinicA, 'post', `/cash-sessions/${sessionId}/adjustments`)
      .send({ ...body, amount: 0 })
      .expect(400);
    const original = detailOf(
      await api(clinicA, 'get', `/cash-sessions/${sessionId}`).expect(200),
    );
    expect(original.closing?.hasDifference).toBe(false);
  });

  it('«exigir caja abierta»: sin caja no se cobra en efectivo (409); con tarjeta sí', async () => {
    await api(clinicA, 'put', '/cash-sessions/settings')
      .send({ requireOpenSession: true, blindClose: false })
      .expect(200);
    const refused = await pay(clinicA.adminToken, {
      amount: 1_000,
      method: 'CASH',
    }).expect(409);
    expect((refused.body as { message: string }).message).toMatch(
      /caja abierta/,
    );
    await pay(clinicA.adminToken, { amount: 1_000, method: 'CARD' }).expect(
      201,
    );
  });

  it('«arqueo ciego»: recepción no ve el esperado ni los abonos de su caja abierta; ADMIN sí', async () => {
    await api(clinicA, 'put', '/cash-sessions/settings')
      .send({ requireOpenSession: true, blindClose: true })
      .expect(200);
    const blind = detailOf(
      await api(
        clinicA,
        'post',
        '/cash-sessions/open',
        receptionToken,
        sedePrincipal,
      )
        .send({ floats: [{ currency: 'COP', amount: 10_000 }] })
        .expect(201),
    );
    await pay(receptionToken, { amount: 3_000, method: 'CASH' }).expect(201);
    const reception = detailOf(
      await api(
        clinicA,
        'get',
        `/cash-sessions/${blind.id}`,
        receptionToken,
      ).expect(200),
    );
    expect(reception).toMatchObject({
      blindHidden: true,
      expected: null,
      payments: null,
    });
    const admin = detailOf(
      await api(clinicA, 'get', `/cash-sessions/${blind.id}`).expect(200),
    );
    // Fondo + abono − la corrección pendiente del ADMIN, que entró al abrir.
    expect(lineOf(admin, 'COP', 'CASH')).toMatchObject({
      expected: 12_500,
      adjustments: -500,
    });

    const closed = detailOf(
      await api(
        clinicA,
        'post',
        `/cash-sessions/${blind.id}/close`,
        receptionToken,
      )
        .send({
          counts: [{ currency: 'COP', method: 'CASH', counted: 12_500 }],
        })
        .expect(201),
    );
    expect(closed).toMatchObject({
      blindHidden: false,
      closing: {
        hasDifference: false,
        lines: [expect.objectContaining({ expected: 12_500 })],
      },
    });
  });

  it('otra clínica no ve ni toca las cajas de A', async () => {
    await api(clinicB, 'get', `/cash-sessions/${sessionId}`).expect(404);
    await api(clinicB, 'post', `/cash-sessions/${sessionId}/reopen`)
      .send({ reason: 'Intrusa' })
      .expect(404);
    const list = await api(clinicB, 'get', '/cash-sessions').expect(200);
    expect((list.body as { total: number }).total).toBe(0);
  });
});
