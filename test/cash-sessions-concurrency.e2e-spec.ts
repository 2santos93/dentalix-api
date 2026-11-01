import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import { civilDateIn } from '../src/shared/time/civil-day';
import { locationBody } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

// DX-027 · Caja por turno bajo concurrencia y con varias monedas y sedes:
// dos aperturas o dos cierres a la vez (uno gana, el otro 409), abonos y
// anulaciones que se cruzan con el cierre (el arqueo guardado casa siempre
// con los abonos que quedaron en la caja), abonos en otra moneda (su propia
// línea) y abonos de otra sede (no entran). Contra Postgres real.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-495 (TST-062): la clínica usa la zona segura de DX-449 (Bogotá lejos de
// su medianoche; si no, una zona en la que ahora es cerca del mediodía): el
// «hoy» de la caja y el de la API no se separan si la corrida cruza la
// medianoche de Bogotá.
const SEDE = sedeTodayFixture();
const today = (): string => civilDateIn(new Date(), SEDE.timeZone);
const ROUNDS = 6;

interface ClosingLine {
  currency: string;
  method: string;
  expected: number;
}

interface Detail {
  id: string;
  status: string;
  expected:
    | { currency: string; method: string; payments: number; expected: number }[]
    | null;
  payments: { id: string }[] | null;
  closing: { lines: ClosingLine[] } | null;
}

const detailOf = (res: { body: unknown }): Detail => res.body as Detail;

describe('Caja por turno: concurrencia, monedas y sedes (e2e, DX-027)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let receptionToken: string;
  let sedePrincipal: string;
  let sedeNorte: string;
  let planId: string;

  const server = () => app.getHttpServer();
  const api = (
    verb: 'get' | 'post' | 'delete',
    path: string,
    token = clinic.adminToken,
    locationId = sedePrincipal,
  ) =>
    request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Location-Id', locationId);

  const open = (floats: { currency: string; amount: number }[] = []) =>
    api('post', '/cash-sessions/open', receptionToken).send({ floats });
  const close = (id: string, counted = 0) =>
    api('post', `/cash-sessions/${id}/close`, receptionToken).send({
      counts: [{ currency: 'COP', method: 'CASH', counted }],
      differenceReason: 'Prueba de concurrencia',
    });
  const pay = (
    amount: number,
    extra: { currency?: string; method?: string } = {},
    locationId = sedePrincipal,
  ) =>
    api(
      'post',
      `/treatment-plans/${planId}/payments`,
      receptionToken,
      locationId,
    ).send({
      currency: 'COP',
      method: 'CASH',
      paidAt: today(),
      amount,
      ...extra,
    });

  /** Σ de los ajustes en efectivo COP que entraron en la caja. */
  const adjustmentsIn = async (sessionId: string): Promise<number> => {
    const rows = await raw.cashSessionAdjustment.findMany({
      where: { sessionId, currency: 'COP', method: 'CASH' },
      select: { amount: true },
    });
    return rows.reduce((sum, row) => sum + row.amount.toNumber(), 0);
  };

  /** Lo esperado en efectivo COP según el cierre guardado. */
  const closedCashExpected = (detail: Detail): number =>
    detail.closing?.lines.find(
      (l) => l.currency === 'COP' && l.method === 'CASH',
    )?.expected ?? 0;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'caja-concurrencia', SEDE);
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinic.host, reception.email);
    sedePrincipal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    sedeNorte = (
      (
        await api('post', '/locations')
          .send(locationBody(SEDE, { name: 'Norte' }))
          .expect(201)
      ).body as { id: string }
    ).id;
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Ana',
        lastName: 'Concurrente',
        docNumber: '2027',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: clinic.tenantId,
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

  it('dos aperturas a la vez en la misma sede: una 201 y la otra 409', async () => {
    const results = await Promise.all([open(), open(), open()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(
      await raw.cashSession.count({
        where: { tenantId: clinic.tenantId, status: 'OPEN' },
      }),
    ).toBe(1);
    const id = (results.find((r) => r.status === 201)!.body as { id: string })
      .id;
    await close(id).expect(201);
  });

  it('dos cierres a la vez: uno 201 y el otro 409, con un solo cierre guardado', async () => {
    const id = detailOf(await open().expect(201)).id;
    const results = await Promise.all([close(id), close(id), close(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(
      await raw.cashSessionClosing.count({ where: { sessionId: id } }),
    ).toBe(1);
  });

  it('un abono que se cruza con el cierre: o entra en el arqueo guardado o queda sin caja, nunca en una caja cerrada sin contar', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = detailOf(
        await open([{ currency: 'COP', amount: 10_000 }]).expect(201),
      ).id;
      await pay(1_000).expect(201);
      const [, closed] = await Promise.all([
        pay(2_000).expect(201),
        close(id).expect(201),
      ]);
      const inSession = await raw.payment.findMany({
        where: { cashSessionId: id, deletedAt: null },
        select: { amount: true },
      });
      const sum = inSession.reduce((s, p) => s + p.amount.toNumber(), 0);
      expect(closedCashExpected(detailOf(closed))).toBe(10_000 + sum);
    }
  });

  it('una anulación que se cruza con el cierre: o el arqueo no la cuenta o es un ajuste VOID aparte, nunca las dos ni ninguna', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = detailOf(await open().expect(201)).id;
      const paymentId = (
        (await pay(4_000).expect(201)).body as {
          id: string;
        }
      ).id;
      const [, closed] = await Promise.all([
        api('delete', `/payments/${paymentId}`, receptionToken)
          .send({ reason: 'Cobro duplicado' })
          .expect(200),
        close(id).expect(201),
      ]);
      const voidAdjustments = await raw.cashSessionAdjustment.count({
        where: { paymentId, kind: 'VOID', originalSessionId: id },
      });
      // Contado en el cierre ⇔ su anulación llegó tarde (ajuste VOID). Los
      // ajustes pendientes de la vuelta anterior entran al abrir esta caja.
      expect(closedCashExpected(detailOf(closed))).toBe(
        (voidAdjustments === 1 ? 4_000 : 0) + (await adjustmentsIn(id)),
      );
      // Y la ficha (recalculada) dice lo mismo que el cierre guardado.
      const detail = detailOf(
        await api('get', `/cash-sessions/${id}`).expect(200),
      );
      expect(
        detail.expected?.find(
          (l) => l.currency === 'COP' && l.method === 'CASH',
        )?.expected ?? 0,
      ).toBe(closedCashExpected(detail));
    }
  });

  it('un abono en otra moneda va en su propia línea y uno de otra sede no entra en la caja', async () => {
    const id = detailOf(
      await open([{ currency: 'COP', amount: 20_000 }]).expect(201),
    ).id;
    await pay(5_000).expect(201);
    await pay(30, { currency: 'USD' }).expect(201);
    await pay(15, { currency: 'USD', method: 'CARD' }).expect(201);
    // Misma recepcionista cobrando en la sede Norte, donde no tiene caja.
    const norte = (
      (await pay(9_000, {}, sedeNorte).expect(201)).body as { id: string }
    ).id;
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: norte },
      select: { cashSessionId: true },
    });
    expect(row.cashSessionId).toBeNull();

    const detail = detailOf(
      await api('get', `/cash-sessions/${id}`, receptionToken).expect(200),
    );
    expect(
      detail.expected?.map((l) => [l.currency, l.method, l.expected]),
    ).toEqual([
      ['COP', 'CASH', 25_000 + (await adjustmentsIn(id))],
      ['USD', 'CASH', 30],
      ['USD', 'CARD', 15],
    ]);
    expect(detail.payments).toHaveLength(3);
  });
});
