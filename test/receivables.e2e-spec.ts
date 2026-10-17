import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
  CatalogKind,
  ClinicRole,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
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
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';

// DX-145 · Cartera por antigüedad. Siembra CONTROLADA por DIRECT_URL (owner,
// sin RLS) para fijar fechas pasadas que la API no deja escribir (vencimientos,
// fecha del plan, citas atendidas); las lecturas, siempre por la API.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const BOGOTA = 'America/Bogota';
const today = (): string => civilDateIn(new Date(), BOGOTA);
/** Medianoche UTC del día civil de hace `n` días (como guarda las cuotas la API). */
const dueDaysAgo = (n: number): Date =>
  new Date(`${addCivilDays(today(), -n)}T00:00:00.000Z`);
/** Mediodía de Bogotá de hace `n` días. */
const noonDaysAgo = (n: number): Date =>
  new Date(`${addCivilDays(today(), -n)}T17:00:00.000Z`);

interface AgingCurrency {
  currency: string;
  balance: number;
  debt: number;
  credit: number;
  buckets: Record<
    'current' | 'days0to30' | 'days31to60' | 'days61to90' | 'over90',
    number
  >;
  oldestAgeDays: number | null;
  ageApproximate: boolean;
}

interface AgingRow {
  patient: {
    id: string;
    fullName: string;
    phone: string | null;
    whatsApp: string | null;
  };
  locationId: string | null;
  oldestAgeDays: number | null;
  ageApproximate: boolean;
  currencies: AgingCurrency[];
  lastPayment: { paidOn: string; amount: number; currency: string } | null;
  nextInstallment: { dueDate: string; amount: number; currency: string } | null;
}

interface AgingPage {
  asOf: string;
  scope: { location: { id: string; name: string } | null };
  items: AgingRow[];
  total: number;
  page: number;
  pageSize: number;
  totals: (AgingCurrency & { patients: number })[];
}

interface StatementBody {
  summary: { currency: string; balance: number }[];
}

describe('Cartera por antigüedad — GET /receivables/aging (e2e, DX-145)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let sedePrincipal: string;
  let sedeNorte: string;
  let catalogItemId: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;

  // Pacientes de A:
  //   cuotas    COP 300.000 en 3 cuotas: vencida hace 75, hace 10 y una futura
  //   sinCuotas COP 500.000 sin calendario, plan creado hace 120 días
  //   aFavor    COP 80.000 de deuda (hace 40) + 20.000 a favor (plan cancelado)
  //   alDia     pagado entero: no sale
  //   norte     COP 90.000 hace 5 días, atendido en Sede Norte
  let cuotas: string;
  let sinCuotas: string;
  let aFavor: string;
  let alDia: string;
  let norte: string;
  let patientOfB: string;

  const server = () => app.getHttpServer();

  function get(clinic: Clinic, path: string, token = clinic.adminToken) {
    return request(server())
      .get(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  async function patient(
    clinic: Clinic,
    firstName: string,
    doc: string,
    phone: string | null = '300 555 0101',
  ): Promise<string> {
    const row = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName,
        lastName: 'Cartera',
        docNumber: doc,
        phone,
        countryCode: 'CO',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function plan(
    clinic: Clinic,
    patientId: string,
    price: number,
    options: {
      createdDaysAgo?: number;
      status?: TreatmentPlanStatus;
      catalog?: string;
    } = {},
  ): Promise<string> {
    const row = await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        currency: 'COP',
        status: options.status ?? TreatmentPlanStatus.ACCEPTED,
        createdAt: noonDaysAgo(options.createdDaysAgo ?? 0),
        items: {
          create: {
            toothNumber: '11',
            catalogItemId: options.catalog ?? catalogItemId,
            price,
            status: TreatmentPlanItemStatus.ACCEPTED,
          },
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function pay(
    clinic: Clinic,
    planId: string,
    patientId: string,
    amount: number,
    locationId: string,
    daysAgo = 1,
  ): Promise<void> {
    await raw.payment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        treatmentPlanId: planId,
        patientId,
        amount,
        currency: 'COP',
        paidAt: noonDaysAgo(daysAgo),
        method: 'CASH',
      },
    });
  }

  async function attended(
    clinic: Clinic,
    patientId: string,
    locationId: string,
    daysAgo: number,
  ): Promise<void> {
    const start = noonDaysAgo(daysAgo);
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: clinic.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: AppointmentStatus.COMPLETED,
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'cartera-a');
    clinicB = await registerClinic(app, 'cartera-b');

    const sedes = await get(clinicA, '/locations').expect(200);
    sedePrincipal = (sedes.body as { id: string }[])[0].id;
    const created = await request(server())
      .post('/api/v1/locations')
      .set('X-Tenant-Host', clinicA.host)
      .set('Authorization', `Bearer ${clinicA.adminToken}`)
      .send({ name: 'Sede Norte' })
      .expect(201);
    sedeNorte = (created.body as { id: string }).id;

    const catalog = await request(server())
      .post('/api/v1/catalog/items')
      .set('X-Tenant-Host', clinicA.host)
      .set('Authorization', `Bearer ${clinicA.adminToken}`)
      .send({
        code: 'CARTERA',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const { email } = await seedMember(raw, clinicA, role);
      const token = await loginAs(app, clinicA.host, email);
      if (role === ClinicRole.RECEPTION) receptionToken = token;
      if (role === ClinicRole.DENTIST) dentistToken = token;
      if (role === ClinicRole.ASSISTANT) assistantToken = token;
    }

    // --- cuotas: calendario con vencimientos controlados ------------------
    cuotas = await patient(clinicA, 'Cuotas', 'CAR-1');
    const planCuotas = await plan(clinicA, cuotas, 300000);
    await raw.paymentPlan.create({
      data: {
        tenantId: clinicA.tenantId,
        treatmentPlanId: planCuotas,
        patientId: cuotas,
        currency: 'COP',
        totalToFinance: 300000,
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: dueDaysAgo(75),
        installments: {
          create: [
            [1, 75],
            [2, 10],
            [3, -20],
          ].map(([sequence, ago]) => ({
            sequence,
            dueDate: dueDaysAgo(ago),
            amount: 100000,
          })),
        },
      },
    });
    await attended(clinicA, cuotas, sedePrincipal, 3);

    // --- sinCuotas: el saldo envejece desde la fecha del plan -------------
    sinCuotas = await patient(clinicA, 'Sincuotas', 'CAR-2');
    await plan(clinicA, sinCuotas, 500000, { createdDaysAgo: 120 });
    await attended(clinicA, sinCuotas, sedePrincipal, 100);

    // --- aFavor: deuda y saldo a favor a la vez ---------------------------
    aFavor = await patient(clinicA, 'Afavor', 'CAR-3');
    await plan(clinicA, aFavor, 80000, { createdDaysAgo: 40 });
    const cancelado = await plan(clinicA, aFavor, 50000, {
      createdDaysAgo: 60,
      status: TreatmentPlanStatus.CANCELLED,
    });
    await pay(clinicA, cancelado, aFavor, 20000, sedePrincipal, 50);
    // Sin citas atendidas: su sede es la del último abono.

    // --- alDia ------------------------------------------------------------
    alDia = await patient(clinicA, 'Aldia', 'CAR-4');
    const planAlDia = await plan(clinicA, alDia, 70000, {
      createdDaysAgo: 200,
    });
    await pay(clinicA, planAlDia, alDia, 70000, sedePrincipal, 150);
    await attended(clinicA, alDia, sedePrincipal, 150);

    // --- norte: atendido en Sede Norte (antes, en la principal) -----------
    norte = await patient(clinicA, 'Norteño', 'CAR-5', null);
    await plan(clinicA, norte, 90000, { createdDaysAgo: 5 });
    await attended(clinicA, norte, sedePrincipal, 30);
    await attended(clinicA, norte, sedeNorte, 2);

    // --- Clínica B: un deudor propio, que A nunca ve -----------------------
    const sedesB = await get(clinicB, '/locations').expect(200);
    const sedeB = (sedesB.body as { id: string }[])[0].id;
    const catalogB = await raw.dentalCatalogItem.create({
      data: {
        tenantId: clinicB.tenantId,
        code: 'CARTERA-B',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      },
      select: { id: true },
    });
    patientOfB = await patient(clinicB, 'Ajeno', 'CAR-B1');
    await plan(clinicB, patientOfB, 999000, {
      createdDaysAgo: 200,
      catalog: catalogB.id,
    });
    await attended(clinicB, patientOfB, sedeB, 10);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('lista los deudores de la sede activa por antigüedad, con los tramos del criterio de aceptación', async () => {
    const res = await get(clinicA, '/receivables/aging', receptionToken)
      .set('X-Location-Id', sedePrincipal)
      .expect(200);
    const body = res.body as AgingPage;

    expect(body.scope.location).toEqual({
      id: sedePrincipal,
      name: expect.any(String) as unknown,
    });
    expect(body.asOf).toBe(today());
    expect(body.items.map((r) => r.patient.id)).toEqual([
      sinCuotas,
      cuotas,
      aFavor,
    ]);

    const [rowSin, rowCuotas, rowFavor] = body.items;
    expect(rowSin).toMatchObject({
      oldestAgeDays: 120,
      ageApproximate: true,
      locationId: sedePrincipal,
      patient: { fullName: 'Sincuotas Cartera', whatsApp: '573005550101' },
    });
    expect(rowSin.currencies[0].buckets.over90).toBe(500000);

    expect(rowCuotas.currencies[0]).toMatchObject({
      currency: 'COP',
      debt: 300000,
      credit: 0,
      oldestAgeDays: 75,
      ageApproximate: false,
      buckets: {
        current: 100000,
        days0to30: 100000,
        days31to60: 0,
        days61to90: 100000,
        over90: 0,
      },
    });
    expect(rowCuotas.nextInstallment).toMatchObject({
      currency: 'COP',
      amount: 100000,
      dueDate: dueDaysAgo(-20).toISOString(),
    });

    // Saldo a favor aparte; los tramos solo llevan lo que se debe.
    expect(rowFavor.currencies[0]).toMatchObject({
      debt: 80000,
      credit: 20000,
      balance: 60000,
      buckets: { days31to60: 80000 },
    });
    expect(rowFavor.lastPayment).toEqual({
      paidOn: addCivilDays(today(), -50),
      amount: 20000,
      currency: 'COP',
    });

    expect(body.totals).toEqual([
      {
        currency: 'COP',
        patients: 3,
        balance: 860000,
        debt: 880000,
        credit: 20000,
        buckets: {
          current: 100000,
          days0to30: 100000,
          days31to60: 80000,
          days61to90: 100000,
          over90: 500000,
        },
      },
    ]);
  });

  it('el total de cada paciente coincide con su estado de cuenta', async () => {
    const res = await get(clinicA, '/receivables/aging').expect(200);
    const rows = (res.body as AgingPage).items;
    // Sin sede: toda la clínica, también el de la Sede Norte.
    expect(rows.map((r) => r.patient.id).sort()).toEqual(
      [sinCuotas, cuotas, aFavor, norte].sort(),
    );
    for (const row of rows) {
      const statement = await get(
        clinicA,
        `/patients/${row.patient.id}/account-statement`,
      ).expect(200);
      const summary = (statement.body as StatementBody).summary;
      expect(row.currencies.map((c) => [c.currency, c.balance])).toEqual(
        summary.map((s) => [s.currency, s.balance]),
      );
    }
  });

  it('cuadra con el estado de cuenta con abonos en otra moneda y anulados, y omite pacientes retirados', async () => {
    const clinicC = await registerClinic(app, 'cartera-c');
    const sedesC = await get(clinicC, '/locations').expect(200);
    const sedeC = (sedesC.body as { id: string }[])[0].id;
    const catalogC = await raw.dentalCatalogItem.create({
      data: {
        tenantId: clinicC.tenantId,
        code: 'CARTERA-C',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      },
      select: { id: true },
    });
    const payment = (
      planId: string,
      patientId: string,
      amount: number,
      currency: string,
      deletedAt: Date | null = null,
    ) =>
      raw.payment.create({
        data: {
          tenantId: clinicC.tenantId,
          locationId: sedeC,
          treatmentPlanId: planId,
          patientId,
          amount,
          currency,
          paidAt: noonDaysAgo(3),
          method: 'CASH',
          deletedAt,
        },
      });

    // mixto: COP 100.000, abona 30.000 COP y 10 USD; un abono de 50.000 COP
    // anulado no cuenta. Debe 70.000 COP y tiene 10 USD a favor.
    const mixto = await patient(clinicC, 'Mixto', 'CAR-C1');
    const planMixto = await plan(clinicC, mixto, 100000, {
      createdDaysAgo: 45,
      catalog: catalogC.id,
    });
    await payment(planMixto, mixto, 30000, 'COP');
    await payment(planMixto, mixto, 10, 'USD');
    await payment(planMixto, mixto, 50000, 'COP', new Date());
    await attended(clinicC, mixto, sedeC, 4);

    // sinSede: ni citas, ni abonos, ni presentación: solo en la consolidada.
    const sinSede = await patient(clinicC, 'Sinsede', 'CAR-C2');
    await plan(clinicC, sinSede, 60000, {
      createdDaysAgo: 10,
      catalog: catalogC.id,
    });

    // retirado: debe, pero el paciente está borrado: no es cartera.
    const retirado = await patient(clinicC, 'Retirado', 'CAR-C3');
    await plan(clinicC, retirado, 400000, {
      createdDaysAgo: 100,
      catalog: catalogC.id,
    });
    await attended(clinicC, retirado, sedeC, 50);
    await raw.patient.update({
      where: { id: retirado },
      data: { deletedAt: new Date() },
    });

    const all = (await get(clinicC, '/receivables/aging').expect(200))
      .body as AgingPage;
    expect(all.items.map((r) => r.patient.id).sort()).toEqual(
      [mixto, sinSede].sort(),
    );
    for (const row of all.items) {
      const statement = await get(
        clinicC,
        `/patients/${row.patient.id}/account-statement`,
      ).expect(200);
      expect(row.currencies.map((c) => [c.currency, c.balance])).toEqual(
        (statement.body as StatementBody).summary.map((s) => [
          s.currency,
          s.balance,
        ]),
      );
    }
    const mixtoRow = all.items.find((r) => r.patient.id === mixto);
    expect(mixtoRow?.locationId).toBe(sedeC);
    expect(
      mixtoRow?.currencies.map((c) => [c.currency, c.debt, c.credit]),
    ).toEqual([
      ['COP', 70000, 0],
      ['USD', 0, 10],
    ]);
    expect(all.items.find((r) => r.patient.id === sinSede)?.locationId).toBe(
      null,
    );

    const bySede = (
      await get(clinicC, `/receivables/aging?locationId=${sedeC}`).expect(200)
    ).body as AgingPage;
    expect(bySede.items.map((r) => r.patient.id)).toEqual([mixto]);
  });

  it('DX-155: sigue cuadrando con el estado de cuenta tras abonos, anulaciones y cambios del plan (por la API)', async () => {
    const clinicD = await registerClinic(app, 'cartera-d');
    const sedeD = (
      (await get(clinicD, '/locations').expect(200)).body as { id: string }[]
    )[0].id;
    const send = (
      method: 'post' | 'patch' | 'delete',
      path: string,
      body: object,
      status: number,
    ) =>
      request(server())
        [method](`/api/v1${path}`)
        .set('X-Tenant-Host', clinicD.host)
        .set('Authorization', `Bearer ${clinicD.adminToken}`)
        .set('X-Location-Id', sedeD)
        .send(body)
        .expect(status)
        .then((res) => res.body as { id: string });
    const catalogD = await send(
      'post',
      '/catalog/items',
      {
        code: 'CARTERA-D',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 100000,
      },
      201,
    );
    const ana = await patient(clinicD, 'Cuadre', 'CAR-D1');

    /**
     * La fila de Ana en la cartera (toda la clínica y su sede) frente a su
     * estado de cuenta: mismo saldo por moneda y la deuda esperada.
     */
    const expectSquares = async (debt: number | null): Promise<void> => {
      const statement = (
        await get(clinicD, `/patients/${ana}/account-statement`).expect(200)
      ).body as StatementBody;
      for (const path of [
        '/receivables/aging',
        `/receivables/aging?locationId=${sedeD}`,
      ]) {
        const page = (await get(clinicD, path).expect(200)).body as AgingPage;
        const row = page.items.find((r) => r.patient.id === ana);
        if (debt === null) {
          expect(row).toBeUndefined();
          expect(page.totals).toEqual([]);
          continue;
        }
        expect(row?.currencies.map((c) => [c.currency, c.balance])).toEqual(
          statement.summary.map((s) => [s.currency, s.balance]),
        );
        expect(row?.currencies[0].debt).toBe(debt);
        expect(page.totals[0]).toMatchObject({ patients: 1, debt });
      }
    };

    // Plan aceptado con dos ítems de 100.000 (uno con 20.000 de descuento).
    const plan = await send(
      'post',
      `/patients/${ana}/treatment-plans`,
      { currency: 'COP' },
      201,
    );
    const item1 = await send(
      'post',
      `/treatment-plans/${plan.id}/items`,
      { toothNumber: '11', catalogItemId: catalogD.id },
      201,
    );
    const item2 = await send(
      'post',
      `/treatment-plans/${plan.id}/items`,
      { toothNumber: '21', catalogItemId: catalogD.id },
      201,
    );
    await expectSquares(null); // PROPOSED: aún no se factura.
    for (const item of [item1, item2]) {
      await send(
        'patch',
        `/treatment-plans/${plan.id}/items/${item.id}`,
        { status: 'ACCEPTED' },
        200,
      );
    }
    await send(
      'patch',
      `/treatment-plans/${plan.id}/items/${item2.id}`,
      // DX-204: por encima del 10 % la API pide el motivo.
      { discount: 20000, discountReason: 'LOYALTY' },
      200,
    );
    await send(
      'patch',
      `/treatment-plans/${plan.id}`,
      { status: 'ACCEPTED' },
      200,
    );
    await attended(clinicD, ana, sedeD, 1);
    await expectSquares(180000);

    // Abono y anulación.
    const abono = await send(
      'post',
      `/treatment-plans/${plan.id}/payments`,
      {
        amount: 50000,
        currency: 'COP',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      },
      201,
    );
    await expectSquares(130000);
    await send(
      'delete',
      `/payments/${abono.id}`,
      { reason: 'Registrado por error' },
      200,
    );
    await expectSquares(180000);

    // Cambios del plan: un ítem más, realizado, otro retirado, y un plan de
    // cuotas sobre el saldo.
    const item3 = await send(
      'post',
      `/treatment-plans/${plan.id}/items`,
      { toothNumber: '31', catalogItemId: catalogD.id, price: 40000 },
      201,
    );
    await send(
      'patch',
      `/treatment-plans/${plan.id}/items/${item3.id}`,
      { status: 'DONE' },
      200,
    );
    await expectSquares(220000);
    await send(
      'delete',
      `/treatment-plans/${plan.id}/items/${item1.id}`,
      {},
      200,
    );
    await expectSquares(120000);
    await send(
      'post',
      `/treatment-plans/${plan.id}/payment-plan`,
      {
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
      201,
    );
    await expectSquares(120000);

    // Lo paga entero: sale de la cartera.
    await send(
      'post',
      `/treatment-plans/${plan.id}/payments`,
      {
        amount: 120000,
        currency: 'COP',
        paidAt: new Date().toISOString(),
        method: 'TRANSFER',
      },
      201,
    );
    await expectSquares(null);

    // Otro plan con un abono que luego se cancela: solo saldo a favor, no es
    // cartera; el estado de cuenta lo muestra como saldo negativo.
    const second = await send(
      'post',
      `/patients/${ana}/treatment-plans`,
      { currency: 'COP' },
      201,
    );
    const item4 = await send(
      'post',
      `/treatment-plans/${second.id}/items`,
      { toothNumber: '41', catalogItemId: catalogD.id },
      201,
    );
    await send(
      'patch',
      `/treatment-plans/${second.id}/items/${item4.id}`,
      { status: 'ACCEPTED' },
      200,
    );
    await send(
      'patch',
      `/treatment-plans/${second.id}`,
      { status: 'ACCEPTED' },
      200,
    );
    await send(
      'post',
      `/treatment-plans/${second.id}/payments`,
      {
        amount: 30000,
        currency: 'COP',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      },
      201,
    );
    await expectSquares(70000);
    await send(
      'patch',
      `/treatment-plans/${second.id}`,
      { status: 'CANCELLED' },
      200,
    );
    await expectSquares(null);
    const statement = (
      await get(clinicD, `/patients/${ana}/account-statement`).expect(200)
    ).body as StatementBody;
    expect(statement.summary).toMatchObject([
      { currency: 'COP', balance: -30000 },
    ]);
  });

  it('la sede de la deuda es la de la última cita atendida y se puede pedir por locationId', async () => {
    const res = await get(
      clinicA,
      `/receivables/aging?locationId=${sedeNorte}`,
    ).expect(200);
    const body = res.body as AgingPage;
    expect(body.items.map((r) => r.patient.id)).toEqual([norte]);
    expect(body.items[0].patient).toMatchObject({
      phone: null,
      whatsApp: null,
    });
    expect(body.scope.location?.name).toBe('Sede Norte');
  });

  it('filtra más de 90 días, saldo mínimo y moneda, y pagina con tope', async () => {
    const over90 = await get(
      clinicA,
      '/receivables/aging?minAgeDays=91',
      receptionToken,
    )
      .set('X-Location-Id', sedePrincipal)
      .expect(200);
    expect((over90.body as AgingPage).items.map((r) => r.patient.id)).toEqual([
      sinCuotas,
    ]);

    const big = await get(
      clinicA,
      '/receivables/aging?minBalance=250000',
    ).expect(200);
    expect((big.body as AgingPage).items.map((r) => r.patient.id)).toEqual([
      sinCuotas,
      cuotas,
    ]);

    const usd = await get(clinicA, '/receivables/aging?currency=USD').expect(
      200,
    );
    expect(usd.body).toMatchObject({ items: [], total: 0, totals: [] });

    const page = await get(
      clinicA,
      '/receivables/aging?pageSize=2&page=2',
    ).expect(200);
    expect(page.body).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect((page.body as AgingPage).items).toHaveLength(2);
  });

  it('rechaza filtros inválidos en español', async () => {
    const res = await get(clinicA, '/receivables/aging?minAgeDays=-1').expect(
      400,
    );
    expect(JSON.stringify(res.body)).toContain(
      'minAgeDays no puede ser negativo.',
    );
    const cur = await get(clinicA, '/receivables/aging?currency=pesos').expect(
      400,
    );
    expect(JSON.stringify(cur.body)).toContain('ISO 4217');
  });

  it('otra clínica no ve ninguna fila de A, ni puede pedir una sede de A', async () => {
    const res = await get(clinicB, '/receivables/aging').expect(200);
    const ids = (res.body as AgingPage).items.map((r) => r.patient.id);
    expect(ids).toEqual([patientOfB]);

    const foreign = await get(
      clinicB,
      `/receivables/aging?locationId=${sedePrincipal}`,
    ).expect(400);
    expect((foreign.body as { message: string }).message).toBe(
      'La sede no es de esta clínica.',
    );

    const csv = await get(clinicB, '/receivables/aging.csv').expect(200);
    expect(csv.text).toContain('Ajeno Cartera');
    for (const name of ['Cuotas', 'Sincuotas', 'Afavor', 'Norteño']) {
      expect(csv.text).not.toContain(name);
    }
  });

  it('DENTIST y ASSISTANT reciben 403 en español', async () => {
    for (const token of [dentistToken, assistantToken]) {
      const res = await get(clinicA, '/receivables/aging', token).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Tu rol no tiene acceso a la cartera: es para administración y recepción.',
      );
    }
  });

  it('el CSV es solo de ADMIN y cada descarga queda auditada, con «fecha aproximada»', async () => {
    const denied = await get(
      clinicA,
      '/receivables/aging.csv',
      receptionToken,
    ).expect(403);
    expect((denied.body as { message: string }).message).toBe(
      'Solo la administración puede exportar la cartera.',
    );

    const before = await raw.auditEvent.count({
      where: { tenantId: clinicA.tenantId, action: 'EXPORT' },
    });
    const res = await get(clinicA, '/receivables/aging.csv?minAgeDays=91')
      .set('X-Location-Id', sedePrincipal)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toContain('Fecha aproximada');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Sincuotas Cartera"');
    expect(lines[1]).toContain(',120,Sí,');

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinicA.tenantId, action: 'EXPORT' },
    });
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      resourceType: 'ACCOUNT_STATEMENT',
      locationId: sedePrincipal,
      metadata: { reason: 'RECEIVABLES_AGING' },
      patientId: null,
    });
    // La auditoría no guarda importes ni nombres.
    expect(JSON.stringify(events.at(-1))).not.toContain('Sincuotas');
  });

  it('la lista también queda auditada como lectura', async () => {
    await get(clinicA, '/receivables/aging', receptionToken).expect(200);
    const last = await raw.auditEvent.findFirst({
      where: {
        tenantId: clinicA.tenantId,
        action: 'VIEW',
        resourceType: 'ACCOUNT_STATEMENT',
      },
      orderBy: { occurredAt: 'desc' },
    });
    expect(last?.metadata).toMatchObject({ reason: 'RECEIVABLES_AGING' });
  });
});
