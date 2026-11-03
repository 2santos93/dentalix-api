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
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import { locationBody } from './support/location-fixtures';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';

// SEC-043 · El arqueo ciego no se puede eludir. Con «arqueo ciego», quien
// cuenta (y cualquier otro que no sea ADMIN) no puede conocer el esperado de
// una caja abierta por ninguna de las vías de la API: ni el detalle de la caja
// (esperado, abonos, anulados, ajustes, cierres anteriores), ni la lista y el
// CSV de abonos (filas y resumen), ni el cierre como oráculo de «¿cuadra?».
// ADMIN lo ve todo; sin arqueo ciego, nada cambia. Importes en USD.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-449: la API decide «hoy» con su reloj real y la zona de la sede; la sede
// del fixture usa Caracas salvo cerca de su medianoche.
const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const today = (): string => civilDateIn(new Date(), ZONE);

interface Line {
  currency: string;
  method: string;
  payments?: number | null;
  paymentsCount?: number | null;
  outflows?: number | null;
  expected: number | null;
  amountHidden?: boolean;
}

interface Detail {
  id: string;
  status: string;
  blindHidden: boolean;
  floats: { currency: string; amount: number }[];
  expected: Line[] | null;
  payments: { id: string; amount: number }[] | null;
  voidedPayments:
    { id: string; amount: number | null; amountHidden: boolean }[] | null;
  adjustments: { kind: string; amount: number | null }[] | null;
  laterAdjustments: {
    kind: string;
    amount: number | null;
    amountHidden: boolean;
    payment: { id: string } | null;
  }[];
  closing: {
    hasDifference: boolean;
    differenceReason: string | null;
    unjustifiedDifference: boolean;
    lines: {
      currency?: string;
      method?: string;
      expected: number | null;
      counted: number;
      difference: number | null;
      amountHidden?: boolean;
    }[];
  } | null;
  closings: { lines: unknown[] }[];
  differences?: {
    currency: string;
    amount: number | null;
    amountHidden: boolean;
  }[];
  voidedOutflows?: {
    id: string;
    amount: number | null;
    amountHidden: boolean;
  }[];
}

interface CashList {
  items: {
    id: string;
    amount: number | null;
    currency: string | null;
    collectedAmount: number | null;
    notes: string | null;
    reference: string | null;
    adjustments: unknown[];
    amountHidden: boolean;
    canVoid: boolean;
  }[];
  total: number;
  blindHidden: boolean;
  summary: {
    count: number;
    byCurrency: { currency: string; total: number }[];
    byMethod: { method: string | null; currency: string; total: number }[];
  };
}

const detailOf = (res: { body: unknown }): Detail => res.body as Detail;
const listOf = (res: { body: unknown }): CashList => res.body as CashList;
const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;
const usdTotal = (list: CashList): number =>
  list.summary.byCurrency.find((c) => c.currency === 'USD')?.total ?? 0;

describe('Arqueo ciego sin fugas (e2e, SEC-043)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let recepcion: string;
  let recepcionDos: string;
  let dentista: string;
  let asistente: string;
  let sedePrincipal: string;
  let sedeNorte: string;
  let planId: string;
  let caja: string;
  let late: string;
  const enCaja: string[] = [];
  let fuera: string;

  const server = () => app.getHttpServer();
  const api = (
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
    api('post', `/treatment-plans/${planId}/payments`, token, locationId).send({
      currency: 'USD',
      paidAt: today(),
      ...body,
    });
  const settings = (blindClose: boolean) =>
    api('put', '/cash-sessions/settings')
      .send({ requireOpenSession: false, blindClose })
      .expect(200);
  const dayList = (token: string, locationId?: string, extra = '') =>
    api(
      'get',
      `/payments?from=${today()}&to=${today()}${extra}`,
      token,
      locationId,
    ).expect(200);

  /** Una segunda recepcionista (seedMember usa un correo por rol). */
  async function secondReception(): Promise<string> {
    const email = `recepcion2@${clinic.subdomain}.test`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
        fullName: 'Recepción Dos',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: user.id,
        role: ClinicRole.RECEPTION,
      },
    });
    return loginAs(app, clinic.host, email);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'arqueo-ciego', FIXTURE);
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    recepcion = await loginAs(app, clinic.host, r.email);
    recepcionDos = await secondReception();
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentista = await loginAs(app, clinic.host, d.email);
    const a = await seedMember(raw, clinic, ClinicRole.ASSISTANT);
    asistente = await loginAs(app, clinic.host, a.email);

    sedePrincipal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    sedeNorte = idOf(
      await api('post', '/locations')
        .send(locationBody(FIXTURE, { name: 'Sede Norte' }))
        .expect(201),
    );
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Luis',
        lastName: 'Arqueo',
        docNumber: 'V-12345678',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient.id,
          currency: 'USD',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;

    // Una caja de AYER ya cerrada en la sede principal: un abono con fecha de
    // ayer entra como ajuste LATE_PAYMENT en la caja abierta de quien cobra.
    const yesterday = addCivilDays(today(), -1);
    const start = zonedStartOfDay(yesterday, ZONE).getTime();
    const hour = 60 * 60 * 1000;
    await raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.cashSession.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: sedePrincipal,
          openedById: clinic.adminUserId,
          openedAt: new Date(start + 8 * hour),
          status: 'CLOSED',
          closedAt: new Date(start + 18 * hour),
          closedById: clinic.adminUserId,
        },
      });
    });

    await settings(true);
    // Recepción abre su caja con USD 100 y cobra 30 y 20 en efectivo, 15 con
    // tarjeta, uno de 5 que anula y uno de ayer (12, LATE_PAYMENT).
    caja = idOf(
      await api('post', '/cash-sessions/open', recepcion, sedePrincipal)
        .send({ floats: [{ currency: 'USD', amount: 100 }] })
        .expect(201),
    );
    for (const [amount, method] of [
      [30, 'CASH'],
      [20, 'CASH'],
      [15, 'CARD'],
    ] as const) {
      enCaja.push(idOf(await pay(recepcion, { amount, method }).expect(201)));
    }
    const anulado = idOf(
      await pay(recepcion, { amount: 5, method: 'CASH' }).expect(201),
    );
    await api('delete', `/payments/${anulado}`, recepcion)
      .send({ reason: 'Cobro duplicado' })
      .expect(200);
    late = idOf(
      await pay(recepcion, {
        amount: 12,
        method: 'CASH',
        paidAt: yesterday,
      }).expect(201),
    );
    // Un abono fuera de toda caja (ADMIN sin caja abierta): no se arquea.
    fuera = idOf(
      await pay(clinic.adminToken, { amount: 7, method: 'CARD' }).expect(201),
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN ve el esperado completo: fondo + abonos + ajuste del abono tardío', async () => {
    const admin = detailOf(
      await api('get', `/cash-sessions/${caja}`).expect(200),
    );
    expect(admin.blindHidden).toBe(false);
    expect(
      admin.expected?.find((l) => l.currency === 'USD' && l.method === 'CASH')
        ?.expected,
    ).toBe(162);
    expect(admin.payments?.map((p) => p.id).sort()).toEqual([...enCaja].sort());
    expect(admin.voidedPayments).toEqual([
      expect.objectContaining({ amount: 5 }),
    ]);
    expect(admin.adjustments).toEqual([
      expect.objectContaining({ kind: 'LATE_PAYMENT', amount: 12 }),
    ]);
  });

  describe('vía 1 · detalle de la caja', () => {
    it.each([
      [
        'GET /cash-sessions/:id',
        () => api('get', `/cash-sessions/${caja}`, recepcion),
      ],
      [
        'GET /cash-sessions/current',
        () =>
          api('get', '/cash-sessions/current', recepcion, sedePrincipal).then(
            (res) => ({
              ...res,
              body: (res.body as { session: Detail }).session,
            }),
          ),
      ],
    ])(
      '%s: recepción no recibe esperado, abonos, anulados ni ajustes',
      async (_via, fetch) => {
        const res = await fetch();
        expect(res.status).toBe(200);
        const view = detailOf(res);
        expect(view).toMatchObject({
          blindHidden: true,
          expected: null,
          payments: null,
          voidedPayments: null,
          adjustments: null,
        });
        expect(view.floats).toEqual([{ currency: 'USD', amount: 100 }]);
      },
    );

    it('la otra recepcionista ni la ve (404); dentista y asistente, 403', async () => {
      await api('get', `/cash-sessions/${caja}`, recepcionDos).expect(404);
      await api('get', `/cash-sessions/${caja}`, dentista).expect(403);
      await api('get', `/cash-sessions/${caja}`, asistente).expect(403);
    });
  });

  describe('vía 2 · lista y resumen de abonos (GET /payments)', () => {
    /** Las filas de la caja abierta: están, pero sin ninguna cifra. */
    function expectHidden(list: CashList, ids: readonly string[]): void {
      for (const id of ids) {
        const item = list.items.find((i) => i.id === id);
        expect(item).toMatchObject({
          amountHidden: true,
          amount: null,
          currency: null,
          collectedAmount: null,
          notes: null,
          adjustments: [],
        });
        // Ningún otro número de la fila puede llevar el importe.
        const numeric = Object.entries(item ?? {})
          .filter(([, v]) => typeof v === 'number')
          .map(([k]) => k);
        expect(numeric).toEqual([]);
      }
    }

    it.each([
      ['la recepcionista que cuenta', () => recepcion],
      ['otra recepcionista (podría pasarle la cifra)', () => recepcionDos],
    ])(
      '%s: las filas de la caja abierta salen sin importe y el resumen no las suma, en ninguna sede ni filtro',
      async (_who, token) => {
        for (const [locationId, extra] of [
          [sedePrincipal, ''],
          [sedePrincipal, '&method=CASH'],
          [undefined, ''],
          [undefined, '&method=CASH'],
          [sedeNorte, ''],
        ] as const) {
          const list = listOf(await dayList(token(), locationId, extra));
          expect(list.blindHidden).toBe(true);
          const inScope = locationId !== sedeNorte;
          const expectedIds = !inScope
            ? []
            : extra
              ? enCaja.slice(0, 2)
              : enCaja;
          expect(list.items.map((i) => i.id)).toEqual(
            expect.arrayContaining(expectedIds),
          );
          expectHidden(list, expectedIds);
          // El resumen no suma nada de esa caja: solo el abono fuera de caja.
          expect(usdTotal(list)).toBe(inScope && !extra ? 7 : 0);
          for (const line of list.summary.byMethod) {
            expect(line.total).toBe(line.method === 'CARD' ? 7 : 0);
          }
        }
        // El abono tardío (ajuste de la caja abierta) tampoco, en su día.
        const yesterday = addCivilDays(today(), -1);
        const prev = listOf(
          await api(
            'get',
            `/payments?from=${yesterday}&to=${yesterday}`,
            token(),
          ).expect(200),
        );
        expectHidden(prev, [late]);
        expect(usdTotal(prev)).toBe(0);
      },
    );

    it('el abono fuera de toda caja sale con su importe', async () => {
      const list = listOf(await dayList(recepcion, sedePrincipal));
      expect(list.items.find((i) => i.id === fuera)).toMatchObject({
        amountHidden: false,
        amount: 7,
        currency: 'USD',
      });
    });

    it('ADMIN lo ve completo y sin marca', async () => {
      const list = listOf(await dayList(clinic.adminToken, sedePrincipal));
      expect(list.blindHidden).toBe(false);
      expect(list.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([...enCaja, fuera]),
      );
      for (const item of list.items) expect(item.amountHidden).toBe(false);
      expect(usdTotal(list)).toBe(30 + 20 + 15 + 7);
    });

    it('dentista y asistente: 403', async () => {
      for (const token of [dentista, asistente]) {
        await api(
          'get',
          `/payments?from=${today()}&to=${today()}`,
          token,
        ).expect(403);
      }
    });

    it('desde la lista, recepción imprime el recibo (con su importe) y anula un abono de la caja abierta', async () => {
      const extra = idOf(
        await pay(recepcion, { amount: 9, method: 'CASH' }).expect(201),
      );
      const before = listOf(await dayList(recepcion, sedePrincipal));
      const row = before.items.find((i) => i.id === extra);
      expect(row).toMatchObject({ amountHidden: true, canVoid: true });
      // El recibo es del paciente: lleva su importe.
      const receipt = (
        await api('get', `/payments/${extra}/receipt`, recepcion).expect(200)
      ).body as {
        snapshot: { payment: { amount: number; currency: string } };
      };
      expect(receipt.snapshot.payment).toMatchObject({
        amount: 9,
        currency: 'USD',
      });
      await api('delete', `/payments/${extra}`, recepcion)
        .send({ reason: 'Cobrado por error' })
        .expect(200);
      const after = listOf(await dayList(recepcion, sedePrincipal));
      expect(after.items.map((i) => i.id)).not.toContain(extra);
      // Anulado con la caja abierta: el esperado no cambia.
      const admin = detailOf(
        await api('get', `/cash-sessions/${caja}`).expect(200),
      );
      expect(
        admin.expected?.find((l) => l.currency === 'USD' && l.method === 'CASH')
          ?.expected,
      ).toBe(162);
    });
  });

  describe('vía 3 · exportación CSV (GET /payments.csv)', () => {
    it('recepción recibe las filas de la caja abierta sin moneda y con «Oculto durante el arqueo»; ADMIN, las cifras; dentista y asistente, 403', async () => {
      const csv = (token: string) =>
        api('get', `/payments.csv?from=${today()}&to=${today()}`, token)
          .buffer(true)
          .parse((res, done) => {
            let text = '';
            res.on('data', (chunk: Buffer) => (text += chunk.toString()));
            res.on('end', () => done(null, text));
          });
      const reception = (await csv(recepcion).expect(200)).body as string;
      const rows = reception.trim().split(/\r?\n/).slice(1);
      expect(rows).toHaveLength(4);
      const hidden = rows.filter((r) => r.includes('Oculto durante el arqueo'));
      expect(hidden).toHaveLength(3);
      for (const r of hidden) expect(r).not.toMatch(/USD/);
      expect(rows.filter((r) => !hidden.includes(r))[0]).toMatch(/7[.,]00/);
      const admin = (await csv(clinic.adminToken).expect(200)).body as string;
      const adminRows = admin.trim().split(/\r?\n/).slice(1);
      expect(adminRows).toHaveLength(4);
      expect(admin).not.toMatch(/Oculto durante el arqueo/);
      await csv(dentista).expect(403);
      await csv(asistente).expect(403);
    });
  });

  describe('vía 4 · informes y totales de cabecera', () => {
    it.each([
      '/dashboard',
      `/reports/locations-comparison?from=${today()}&to=${today()}`,
      `/expenses/summary?month=${today().slice(0, 7)}`,
      `/payments/rate-backlog`,
    ])(
      '%s: solo ADMIN (403 a recepción, dentista y asistente)',
      async (path) => {
        for (const token of [recepcion, recepcionDos, dentista, asistente]) {
          await api('get', path, token).expect(403);
        }
      },
    );
  });

  describe('vía 5 · el cierre como oráculo', () => {
    it('ADMIN con arqueo ciego sigue necesitando motivo si no cuadra (400): ve el esperado', async () => {
      const own = idOf(
        await api('post', '/cash-sessions/open', clinic.adminToken, sedeNorte)
          .send({ floats: [{ currency: 'USD', amount: 10 }] })
          .expect(201),
      );
      await api('post', `/cash-sessions/${own}/close`)
        .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 9 }] })
        .expect(400);
      await api('post', `/cash-sessions/${own}/close`)
        .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 10 }] })
        .expect(201);
    });

    it('recepción cierra sin motivo y no cuadra: 201 igual que si cuadrara, marcado «diferencia sin justificar»; no hay segundo intento', async () => {
      const res = await api('post', `/cash-sessions/${caja}/close`, recepcion)
        .send({
          counts: [
            { currency: 'USD', method: 'CASH', counted: 150 },
            { currency: 'USD', method: 'CARD', counted: 15 },
          ],
        })
        .expect(201);
      const closed = detailOf(res);
      expect(closed.status).toBe('CLOSED');
      expect(closed.closing).toMatchObject({
        hasDifference: true,
        differenceReason: null,
        unjustifiedDifference: true,
      });
      // Probar otro conteo: la caja ya está cerrada (409) y solo ADMIN reabre.
      await api('post', `/cash-sessions/${caja}/close`, recepcion)
        .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 162 }] })
        .expect(409);
      await api('post', `/cash-sessions/${caja}/reopen`, recepcion)
        .send({ reason: 'Quiero contar otra vez' })
        .expect(403);
    });

    it('ADMIN ve la marca en el detalle y en la lista de turnos', async () => {
      const admin = detailOf(
        await api('get', `/cash-sessions/${caja}`).expect(200),
      );
      expect(admin.closing?.unjustifiedDifference).toBe(true);
      expect(admin.closing?.lines).toContainEqual(
        expect.objectContaining({
          expected: 162,
          counted: 150,
          difference: -12,
        }),
      );
      const list = (
        await api('get', '/cash-sessions?status=CLOSED').expect(200)
      ).body as { items: { id: string; unjustifiedDifference: boolean }[] };
      expect(list.items.find((s) => s.id === caja)?.unjustifiedDifference).toBe(
        true,
      );
    });

    it('cerrada la caja, sus abonos vuelven con su importe a la lista de recepción', async () => {
      const list = listOf(await dayList(recepcion, sedePrincipal));
      for (const id of enCaja) {
        expect(list.items.find((i) => i.id === id)?.amountHidden).toBe(false);
      }
      expect(usdTotal(list)).toBe(30 + 20 + 15 + 7);
    });

    it('reabierta por ADMIN, recepción no ve las líneas del cierre anterior mientras recuenta', async () => {
      await api('post', `/cash-sessions/${caja}/reopen`)
        .send({ reason: 'Revisar el faltante con recepción' })
        .expect(201);
      const view = detailOf(
        await api('get', `/cash-sessions/${caja}`, recepcion).expect(200),
      );
      expect(view.blindHidden).toBe(true);
      expect(view.closings.map((c) => c.lines)).toEqual([[]]);
      expect(view.closing).toBeNull();
      // Y sus abonos vuelven a ir sin importe mientras está abierta.
      const list = listOf(await dayList(recepcion, sedePrincipal));
      for (const id of enCaja) {
        expect(list.items.find((i) => i.id === id)?.amountHidden).toBe(true);
      }
    });
  });

  // Revisión (ronda 3): lo que, nacido de una caja ya cerrada, cuenta en otra
  // abierta o está pendiente de la próxima; dos sedes; cobro dividido; la
  // cartera auditada. Sede Norte: la segunda recepcionista.
  describe('revisión · ajustes de otras cajas, pendientes, dos sedes, cobro dividido y cartera', () => {
    let cajaA: string;
    let cajaB: string;
    let anuladoA: string;
    let tarjetaA: string;
    let tardio: string;
    let salida: { expenseId: string; paymentId: string };
    const yesterday = () => addCivilDays(today(), -1);

    beforeAll(async () => {
      // Una caja de AYER ya cerrada en la Sede Norte (para el abono tardío).
      const start = zonedStartOfDay(yesterday(), ZONE).getTime();
      const hour = 60 * 60 * 1000;
      await raw.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL session_replication_role = replica`,
        );
        await tx.cashSession.create({
          data: {
            tenantId: clinic.tenantId,
            locationId: sedeNorte,
            openedById: clinic.adminUserId,
            openedAt: new Date(start + 8 * hour),
            status: 'CLOSED',
            closedAt: new Date(start + 18 * hour),
            closedById: clinic.adminUserId,
          },
        });
      });
    });

    const detailFor = async (id: string, token: string) =>
      detailOf(await api('get', `/cash-sessions/${id}`, token).expect(200));
    const listFor = async (token: string, day: string, locationId?: string) =>
      listOf(
        await api(
          'get',
          `/payments?from=${day}&to=${day}`,
          token,
          locationId,
        ).expect(200),
      );

    /**
     * Ronda 4: el grupo USD·CASH de A (con anulaciones posteriores abiertas o
     * pendientes) va sin esperado, desglose, recuentos ni diferencia; USD·CARD
     * conserva sus cifras. La diferencia por moneda de USD, también oculta.
     */
    function expectGroupHidden(view: Detail, hidden: boolean): void {
      const cash = view.expected?.find((l) => l.method === 'CASH');
      const card = view.expected?.find((l) => l.method === 'CARD');
      expect(cash).toMatchObject(
        hidden
          ? {
              payments: null,
              paymentsCount: null,
              outflows: null,
              expected: null,
              amountHidden: true,
            }
          : { payments: 40, outflows: 5, expected: 35, amountHidden: false },
      );
      expect(card).toMatchObject({
        payments: 25,
        expected: 25,
        amountHidden: false,
      });
      const cashLine = view.closing?.lines.find((l) => l.method === 'CASH');
      const cardLine = view.closing?.lines.find((l) => l.method === 'CARD');
      expect(cashLine).toMatchObject(
        hidden
          ? {
              expected: null,
              difference: null,
              counted: 35,
              amountHidden: true,
            }
          : { expected: 35, difference: 0, counted: 35, amountHidden: false },
      );
      expect(cardLine).toMatchObject({
        expected: 25,
        difference: 0,
        amountHidden: false,
      });
      expect(view.differences).toEqual([
        hidden
          ? { currency: 'USD', amount: null, amountHidden: true }
          : { currency: 'USD', amount: 0, amountHidden: false },
      ]);
    }

    it('la caja A cerrada a ciegas y cuadrada guarda el motivo que escribió quien contó (B4)', async () => {
      cajaA = idOf(
        await api('post', '/cash-sessions/open', recepcionDos, sedeNorte)
          .send({ floats: [] })
          .expect(201),
      );
      anuladoA = idOf(
        await pay(
          recepcionDos,
          { amount: 40, method: 'CASH' },
          sedeNorte,
        ).expect(201),
      );
      tarjetaA = idOf(
        await pay(
          recepcionDos,
          { amount: 25, method: 'CARD' },
          sedeNorte,
        ).expect(201),
      );
      // Una salida de caja menor de 5 desde A (la anula después un ADMIN).
      const expense = (
        await api(
          'post',
          '/cash-sessions/current/outflows',
          recepcionDos,
          sedeNorte,
        )
          .send({ category: 'Mensajería', currency: 'USD', amount: 5 })
          .expect(201)
      ).body as { id: string; payments: { id: string }[] };
      salida = { expenseId: expense.id, paymentId: expense.payments[0].id };
      const closed = detailOf(
        await api('post', `/cash-sessions/${cajaA}/close`, recepcionDos)
          .send({
            counts: [
              { currency: 'USD', method: 'CASH', counted: 35 },
              { currency: 'USD', method: 'CARD', counted: 25 },
            ],
            differenceReason: 'Conté dos veces el cajón',
          })
          .expect(201),
      );
      expect(closed.closing).toMatchObject({
        hasDifference: false,
        differenceReason: 'Conté dos veces el cajón',
        unjustifiedDifference: false,
      });
    });

    it('M1: un ADMIN sin caja anula un abono de A y cobra uno tardío: los ajustes quedan pendientes y A no deja ver su importe', async () => {
      await api('delete', `/payments/${anuladoA}`)
        .send({ reason: 'Abono duplicado' })
        .expect(200);
      await api(
        'post',
        `/expenses/${salida.expenseId}/payments/${salida.paymentId}/void`,
      )
        .send({ reason: 'La mensajería se pagó dos veces' })
        .expect(200);
      tardio = idOf(
        await pay(
          clinic.adminToken,
          { amount: 12, method: 'CASH', paidAt: yesterday() },
          sedeNorte,
        ).expect(201),
      );
      const pending = await raw.cashSessionAdjustment.findMany({
        where: { tenantId: clinic.tenantId, locationId: sedeNorte },
        select: { kind: true, sessionId: true, paymentId: true },
      });
      expect(pending).toEqual(
        expect.arrayContaining([
          { kind: 'VOID', sessionId: null, paymentId: anuladoA },
          { kind: 'LATE_PAYMENT', sessionId: null, paymentId: tardio },
          { kind: 'OUTFLOW_VOID', sessionId: null, paymentId: null },
        ]),
      );

      const a = await detailFor(cajaA, recepcionDos);
      expectGroupHidden(a, true);
      expect(
        a.laterAdjustments.find((x) => x.kind === 'OUTFLOW_VOID'),
      ).toMatchObject({ amount: null, amountHidden: true });
      expect(a.voidedOutflows).toEqual([
        expect.objectContaining({
          id: salida.paymentId,
          amount: null,
          amountHidden: true,
        }),
      ]);
      const voidAdj = a.laterAdjustments.find((x) => x.kind === 'VOID');
      expect(voidAdj).toMatchObject({ amount: null, amountHidden: true });
      expect(a.voidedPayments).toEqual([
        expect.objectContaining({
          id: anuladoA,
          amount: null,
          amountHidden: true,
        }),
      ]);
      // ADMIN lo ve.
      const admin = await detailFor(cajaA, clinic.adminToken);
      expectGroupHidden(admin, false);
      expect(
        admin.laterAdjustments.find((x) => x.kind === 'VOID'),
      ).toMatchObject({ amount: -40, amountHidden: false });
      // El tardío pendiente va sin importe en la lista de su día.
      const prev = await listFor(recepcionDos, yesterday(), sedeNorte);
      expect(prev.items.find((i) => i.id === tardio)).toMatchObject({
        amountHidden: true,
        amount: null,
      });
      expect(usdTotal(prev)).toBe(0);
    });

    it('dos sedes: el resumen consolidado solo deja fuera lo de la caja abierta (Sede principal), no lo de la cerrada (Norte)', async () => {
      const all = await listFor(recepcionDos, today());
      expect(all.items.find((i) => i.id === tarjetaA)).toMatchObject({
        amountHidden: false,
        amount: 25,
      });
      for (const id of enCaja) {
        expect(all.items.find((i) => i.id === id)?.amountHidden).toBe(true);
      }
      expect(usdTotal(all)).toBe(25 + 7);
      expect(usdTotal(await listFor(recepcionDos, today(), sedeNorte))).toBe(
        25,
      );
      expect(
        usdTotal(await listFor(recepcionDos, today(), sedePrincipal)),
      ).toBe(7);
    });

    it('M1: la caja B recoge los pendientes; siguen ocultos mientras B está abierta y se ven al cerrarla', async () => {
      cajaB = idOf(
        await api('post', '/cash-sessions/open', recepcionDos, sedeNorte)
          .send({ floats: [] })
          .expect(201),
      );
      const collected = await raw.cashSessionAdjustment.findMany({
        where: { paymentId: { in: [anuladoA, tardio] } },
        select: { sessionId: true },
      });
      expect(collected.map((c) => c.sessionId)).toEqual([cajaB, cajaB]);

      const a = await detailFor(cajaA, recepcionDos);
      expectGroupHidden(a, true);
      expect(a.laterAdjustments.find((x) => x.kind === 'VOID')).toMatchObject({
        amount: null,
        amountHidden: true,
      });
      // La lista de turnos tampoco da la diferencia de USD de A.
      const shifts = (
        await api('get', '/cash-sessions?status=CLOSED', recepcionDos).expect(
          200,
        )
      ).body as { items: { id: string; differences: unknown[] }[] };
      expect(shifts.items.find((x) => x.id === cajaA)?.differences).toEqual([
        { currency: 'USD', amount: null, amountHidden: true },
      ]);
      expect(a.voidedPayments?.[0]).toMatchObject({ amount: null });
      const b = await detailFor(cajaB, recepcionDos);
      expect(b).toMatchObject({ blindHidden: true, adjustments: null });
      const prev = await listFor(recepcionDos, yesterday(), sedeNorte);
      expect(prev.items.find((i) => i.id === tardio)?.amountHidden).toBe(true);

      // B se cierra (no cuadra: esperado −40 + 12 + 5 en efectivo).
      await api('post', `/cash-sessions/${cajaB}/close`, recepcionDos)
        .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 0 }] })
        .expect(201);
      const after = await detailFor(cajaA, recepcionDos);
      expectGroupHidden(after, false);
      expect(
        after.laterAdjustments.find((x) => x.kind === 'VOID'),
      ).toMatchObject({ amount: -40, amountHidden: false });
      expect(after.voidedPayments?.[0]).toMatchObject({
        amount: 40,
        amountHidden: false,
      });
      const prevAfter = await listFor(recepcionDos, yesterday(), sedeNorte);
      expect(prevAfter.items.find((i) => i.id === tardio)).toMatchObject({
        amountHidden: false,
        amount: 12,
      });
    });

    it('un cobro dividido en USD y VES de la caja abierta va sin importe, moneda ni referencia en la lista y en el CSV', async () => {
      await raw.exchangeRateSnapshot.deleteMany({
        where: { date: today(), currency: 'VES' },
      });
      await raw.exchangeRateSnapshot.create({
        data: { date: today(), currency: 'VES', rate: 4000 },
      });
      try {
        const methods = (await api('get', '/payment-methods').expect(200))
          .body as { id: string; legacyMethod: string | null }[];
        const cash = methods.find((m) => m.legacyMethod === 'CASH')!.id;
        const transfer = methods.find((m) => m.legacyMethod === 'TRANSFER')!.id;
        const split = (
          await api(
            'post',
            `/treatment-plans/${planId}/split-payments`,
            recepcion,
            sedePrincipal,
          )
            .send({
              paidAt: today(),
              // El plan de la prueba no tiene ítems: el cobro queda a favor.
              confirmCreditBalance: true,
              lines: [
                { amount: 10, currency: 'USD', paymentMethodId: cash },
                {
                  amount: 40_000,
                  currency: 'VES',
                  paymentMethodId: transfer,
                  reference: 'TR-VES-40000',
                },
              ],
            })
            .expect(201)
        ).body as { payments: { id: string }[] };
        const ids = split.payments.map((p) => p.id);
        expect(ids).toHaveLength(2);

        const list = await listFor(recepcion, today(), sedePrincipal);
        for (const id of ids) {
          expect(list.items.find((i) => i.id === id)).toMatchObject({
            amountHidden: true,
            amount: null,
            currency: null,
            reference: null,
          });
        }
        expect(list.summary.byCurrency.map((c) => c.currency)).not.toContain(
          'VES',
        );
        const csv = (
          await api(
            'get',
            `/payments.csv?from=${today()}&to=${today()}`,
            recepcion,
            sedePrincipal,
          )
            .buffer(true)
            .parse((res, done) => {
              let text = '';
              res.on('data', (chunk: Buffer) => (text += chunk.toString()));
              res.on('end', () => done(null, text));
            })
            .expect(200)
        ).body as string;
        expect(csv).not.toMatch(/VES|TR-VES-40000/);
        const adminCsv = (
          await api(
            'get',
            `/payments.csv?from=${today()}&to=${today()}`,
            clinic.adminToken,
            sedePrincipal,
          )
            .buffer(true)
            .parse((res, done) => {
              let text = '';
              res.on('data', (chunk: Buffer) => (text += chunk.toString()));
              res.on('end', () => done(null, text));
            })
            .expect(200)
        ).body as string;
        expect(adminCsv).toMatch(/VES/);
        expect(adminCsv).toMatch(/TR-VES-40000/);
      } finally {
        await raw.exchangeRateSnapshot.deleteMany({
          where: { date: today(), currency: 'VES' },
        });
      }
    });

    it('M2: los totales de la cartera dejan su evento de auditoría (quién y cuándo, sin importes)', async () => {
      await api(
        'get',
        '/receivables/aging/summary',
        recepcion,
        sedePrincipal,
      ).expect(200);
      const event = await raw.auditEvent.findFirst({
        where: { tenantId: clinic.tenantId, action: 'VIEW' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(event).toMatchObject({
        resourceType: 'ACCOUNT_STATEMENT',
        actorRole: 'RECEPTION',
        locationId: sedePrincipal,
        patientId: null,
        metadata: { reason: 'RECEIVABLES_AGING_SUMMARY' },
      });
    });
  });

  describe('sin arqueo ciego, nada cambia', () => {
    it('recepción ve el esperado, la lista completa, y la diferencia sin motivo es 400', async () => {
      await settings(false);
      const view = detailOf(
        await api('get', `/cash-sessions/${caja}`, recepcion).expect(200),
      );
      expect(view.blindHidden).toBe(false);
      expect(view.expected).not.toBeNull();
      expect(view.voidedPayments).not.toBeNull();
      expect(view.adjustments).not.toBeNull();
      const list = listOf(await dayList(recepcion, sedePrincipal));
      expect(list.blindHidden).toBe(false);
      expect(list.items.map((i) => i.id)).toEqual(
        expect.arrayContaining(enCaja),
      );
      await api('post', `/cash-sessions/${caja}/close`, recepcion)
        .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 150 }] })
        .expect(400);
    });
  });
});
