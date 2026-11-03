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
  expected: number;
}

interface Detail {
  id: string;
  status: string;
  blindHidden: boolean;
  floats: { currency: string; amount: number }[];
  expected: Line[] | null;
  payments: { id: string; amount: number }[] | null;
  voidedPayments: { id: string; amount: number }[] | null;
  adjustments: { kind: string; amount: number }[] | null;
  closing: {
    hasDifference: boolean;
    differenceReason: string | null;
    unjustifiedDifference: boolean;
    lines: { expected: number; counted: number; difference: number }[];
  } | null;
  closings: { lines: unknown[] }[];
}

interface CashList {
  items: { id: string; amount: number }[];
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
    it.each([
      ['la recepcionista que cuenta', () => recepcion],
      ['otra recepcionista (podría pasarle la cifra)', () => recepcionDos],
    ])(
      '%s: sin los abonos de la caja abierta, en ninguna sede ni filtro',
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
          const ids = list.items.map((i) => i.id);
          for (const id of enCaja) expect(ids).not.toContain(id);
          // El resumen no suma nada de esa caja: solo el abono fuera de caja.
          expect(usdTotal(list)).toBe(
            locationId !== sedeNorte && !extra ? 7 : 0,
          );
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
        expect(prev.items.map((i) => i.id)).not.toContain(late);
        expect(usdTotal(prev)).toBe(0);
      },
    );

    it('ADMIN lo ve completo y sin marca', async () => {
      const list = listOf(await dayList(clinic.adminToken, sedePrincipal));
      expect(list.blindHidden).toBe(false);
      expect(list.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([...enCaja, fuera]),
      );
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
  });

  describe('vía 3 · exportación CSV (GET /payments.csv)', () => {
    it('recepción no recibe los abonos de la caja abierta; ADMIN sí; dentista y asistente, 403', async () => {
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
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/7[.,]00/);
      const admin = (await csv(clinic.adminToken).expect(200)).body as string;
      expect(admin.trim().split(/\r?\n/).slice(1)).toHaveLength(4);
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

    it('cerrada la caja, sus abonos vuelven a la lista de recepción', async () => {
      const list = listOf(await dayList(recepcion, sedePrincipal));
      expect(list.items.map((i) => i.id)).toEqual(
        expect.arrayContaining(enCaja),
      );
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
      // Y sus abonos vuelven a salir de la lista mientras está abierta.
      const list = listOf(await dayList(recepcion, sedePrincipal));
      for (const id of enCaja) {
        expect(list.items.map((i) => i.id)).not.toContain(id);
      }
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
