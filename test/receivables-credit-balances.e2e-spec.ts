import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
  AppointmentStatus,
} from '@prisma/client';
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
import { civilDateIn } from '../src/shared/time/civil-day';
import { RECEIVABLES_CLOCK } from '../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';
import {
  locationBody,
  REGIONAL_TOKYO_FIXTURE,
} from './support/location-fixtures';

// DX-430 · Cartera › Saldo a favor. Siembra por DIRECT_URL (owner, sin RLS)
// para fijar fechas pasadas; los traspasos y devoluciones, por la API real;
// las lecturas, siempre por la API. La regla de oro: cada fila de la lista
// coincide con el estado de cuenta del mismo paciente.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOW = new Date('2026-11-04T12:00:00.000Z');

interface Row {
  patient: { id: string; fullName: string };
  location: { id: string; name: string } | null;
  currency: string;
  amount: number;
  since: string | null;
  ageDays: number | null;
}
interface Page {
  asOf: string;
  scope: { location: { id: string; name: string } | null };
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  totals: { currency: string; patients: number; amount: number }[];
  paymentsWithoutRateCount: number;
}
interface Statement {
  plans: { currency: string; balance: number }[];
}

describe('Cartera › Saldo a favor — GET /receivables/credit-balances (e2e, DX-430)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let principalZone: string;
  let catalogA: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let norteOnlyToken: string;
  let principalOnlyToken: string;
  const names = new Map<string, string>();
  const patients: Record<string, string> = {};
  let appointmentSeq = 0;

  const server = () => app.getHttpServer();
  const get = (clinic: Clinic, path: string, token = clinic.adminToken) =>
    request(server())
      .get(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const post = (clinic: Clinic, path: string, token = clinic.adminToken) =>
    request(server())
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function patient(
    clinic: Clinic,
    key: string,
    attendedAt?: { locationId: string },
  ): Promise<string> {
    const row = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: key,
        lastName: 'Favor',
        docNumber: `DX430-${clinic.subdomain}-${key}`,
        countryCode: 'VE',
      },
      select: { id: true },
    });
    names.set(row.id, `${key} Favor`);
    if (attendedAt) {
      await raw.appointment.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: attendedAt.locationId,
          patientId: row.id,
          providerId: clinic.adminUserId,
          // Una cita por paciente, sin solaparse (el profesional es el mismo).
          start: new Date(
            Date.UTC(2026, 9, 30, 15, 0) + appointmentSeq * 3_600_000,
          ),
          end: new Date(
            Date.UTC(2026, 9, 30, 15, 30) + appointmentSeq++ * 3_600_000,
          ),
          status: AppointmentStatus.COMPLETED,
        },
      });
    }
    return row.id;
  }

  async function plan(
    clinic: Clinic,
    patientId: string,
    price: number,
    status: TreatmentPlanStatus,
    currency = 'VES',
    catalog = catalogA,
  ): Promise<string> {
    const row = await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        currency,
        status,
        createdAt: new Date('2026-06-01T15:00:00.000Z'),
        ...(status === TreatmentPlanStatus.REJECTED
          ? {
              rejectedAt: new Date('2026-06-02T15:00:00.000Z'),
              rejectionReason: 'PRICE',
            }
          : {}),
        items: {
          create: {
            toothNumber: '11',
            catalogItemId: catalog,
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
    paidAt: string,
    locationId = principal,
    currency = 'VES',
    extra: Partial<Prisma.PaymentUncheckedCreateInput> = {},
  ): Promise<string> {
    const at = new Date(paidAt);
    return (
      await raw.payment.create({
        data: {
          tenantId: clinic.tenantId,
          locationId,
          treatmentPlanId: planId,
          patientId,
          amount,
          currency,
          paidAt: at,
          method: 'CASH',
          ...extra,
        },
        select: { id: true },
      })
    ).id;
  }

  const transfer = (
    sourcePlanId: string,
    targetPlanId: string,
    amount: number,
  ) =>
    post(a, `/treatment-plans/${sourcePlanId}/credit-transfers`)
      .set('X-Location-Id', principal)
      .send({ targetPlanId, amount, currency: 'VES' })
      .expect(201);
  const refund = (planId: string, paymentIds: string[], amount: number) =>
    post(a, `/treatment-plans/${planId}/credit-refunds`)
      .set('X-Location-Id', principal)
      .send({
        amount,
        currency: 'VES',
        method: 'TRANSFER',
        reason: 'El paciente se muda de ciudad',
        paymentIds,
      })
      .expect(201);

  const list = async (
    clinic: Clinic,
    token = clinic.adminToken,
    query = '',
    headers: Record<string, string> = {},
  ): Promise<Page> => {
    let req = get(clinic, `/receivables/credit-balances${query}`, token);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return (await req.expect(200)).body as Page;
  };
  const allRows = async (
    clinic: Clinic,
    token = clinic.adminToken,
    headers: Record<string, string> = {},
  ): Promise<Row[]> =>
    (await list(clinic, token, '?pageSize=100', headers)).items;
  const keyOf = (r: Row) =>
    `${r.patient.id}:${r.currency}:${r.location?.id ?? ''}`;

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(RECEIVABLES_CLOCK).useValue(() => NOW),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx430-a');
    b = await registerClinic(app, 'dx430-b');

    const sedes = (await get(a, '/locations').expect(200)).body as {
      id: string;
      timeZone: string;
    }[];
    principal = sedes[0].id;
    principalZone = sedes[0].timeZone;
    norte = (
      (
        await post(a, '/locations')
          .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Sede Norte' }))
          .expect(201)
      ).body as { id: string }
    ).id;

    catalogA = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: a.tenantId,
          code: 'DX430',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 1,
        },
        select: { id: true },
      })
    ).id;

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
    // DX-089: dos recepcionistas, cada una restringida a UNA sede.
    const restrictedTo = async (email: string, locationId: string) => {
      const user = await raw.user.create({
        data: {
          email,
          passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
          fullName: email,
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      await raw.clinicMembership.create({
        data: {
          tenantId: a.tenantId,
          userId: user.id,
          role: ClinicRole.RECEPTION,
        },
      });
      await request(server())
        .put(`/api/v1/staff/${user.id}/locations`)
        .set('X-Tenant-Host', a.host)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ locationIds: [locationId] })
        .expect(200);
      return loginAs(app, a.host, email);
    };
    norteOnlyToken = await restrictedTo('norte@dx430-a.test', norte);
    principalOnlyToken = await restrictedTo(
      'principal@dx430-a.test',
      principal,
    );

    // 1. Plan vivo pagado de más: VES 30 a favor.
    patients.viva = await patient(a, 'Viva', { locationId: principal });
    const viva = await plan(
      a,
      patients.viva,
      100,
      TreatmentPlanStatus.ACCEPTED,
    );
    await pay(a, viva, patients.viva, 130, '2026-09-25T15:00:00.000Z');

    // 2. Plan cancelado con dos abonos: VES 300, el más antiguo del 3 de agosto.
    patients.cancelada = await patient(a, 'Cancelada', {
      locationId: principal,
    });
    const cancelada = await plan(
      a,
      patients.cancelada,
      300,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(
      a,
      cancelada,
      patients.cancelada,
      200,
      '2026-10-15T15:00:00.000Z',
    );
    await pay(
      a,
      cancelada,
      patients.cancelada,
      100,
      '2026-08-03T15:00:00.000Z',
    );

    // 3. Plan rechazado con un abono: VES 25.
    patients.rechazada = await patient(a, 'Rechazada', {
      locationId: principal,
    });
    const rechazada = await plan(
      a,
      patients.rechazada,
      80,
      TreatmentPlanStatus.REJECTED,
    );
    await pay(a, rechazada, patients.rechazada, 25, '2026-10-01T15:00:00.000Z');

    // 4. Traspaso parcial (200 de 300): al origen le quedan VES 100; el destino debe 300.
    patients.traspasoParcial = await patient(a, 'TraspasoParcial', {
      locationId: principal,
    });
    const tpOrigen = await plan(
      a,
      patients.traspasoParcial,
      300,
      TreatmentPlanStatus.CANCELLED,
    );
    const tpDestino = await plan(
      a,
      patients.traspasoParcial,
      500,
      TreatmentPlanStatus.ACCEPTED,
    );
    await pay(
      a,
      tpOrigen,
      patients.traspasoParcial,
      300,
      '2026-10-10T15:00:00.000Z',
    );
    await transfer(tpOrigen, tpDestino, 200);

    // 5. Traspaso total: no aparece.
    patients.traspasoTotal = await patient(a, 'TraspasoTotal', {
      locationId: principal,
    });
    const ttOrigen = await plan(
      a,
      patients.traspasoTotal,
      300,
      TreatmentPlanStatus.CANCELLED,
    );
    const ttDestino = await plan(
      a,
      patients.traspasoTotal,
      500,
      TreatmentPlanStatus.ACCEPTED,
    );
    await pay(
      a,
      ttOrigen,
      patients.traspasoTotal,
      300,
      '2026-10-10T15:00:00.000Z',
    );
    await transfer(ttOrigen, ttDestino, 300);

    // 6. Devolución parcial (20 de 120): VES 100 a favor.
    patients.devolucionParcial = await patient(a, 'DevolucionParcial', {
      locationId: principal,
    });
    const dpPlan = await plan(
      a,
      patients.devolucionParcial,
      200,
      TreatmentPlanStatus.CANCELLED,
    );
    const dpPago = await pay(
      a,
      dpPlan,
      patients.devolucionParcial,
      120,
      '2026-10-12T15:00:00.000Z',
    );
    await refund(dpPlan, [dpPago], 20);

    // 7. Dos monedas: USD 10 (plan vivo) y VES 360 (plan cancelado).
    patients.monedas = await patient(a, 'Monedas', { locationId: principal });
    const usd = await plan(
      a,
      patients.monedas,
      100,
      TreatmentPlanStatus.ACCEPTED,
      'USD',
    );
    await pay(
      a,
      usd,
      patients.monedas,
      110,
      '2026-10-20T15:00:00.000Z',
      principal,
      'USD',
    );
    const ves = await plan(
      a,
      patients.monedas,
      500,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(a, ves, patients.monedas, 360, '2026-10-21T15:00:00.000Z');

    // 8. Solo deuda: no aparece.
    patients.deuda = await patient(a, 'Deuda', { locationId: principal });
    const deuda = await plan(
      a,
      patients.deuda,
      200,
      TreatmentPlanStatus.ACCEPTED,
    );
    await pay(a, deuda, patients.deuda, 50, '2026-10-20T15:00:00.000Z');

    // 9. A favor en un plan cancelado Y deuda en otro vivo: el saldo a favor sale entero.
    patients.favorYDeuda = await patient(a, 'FavorYDeuda', {
      locationId: principal,
    });
    const fyd1 = await plan(
      a,
      patients.favorYDeuda,
      50,
      TreatmentPlanStatus.CANCELLED,
    );
    await plan(a, patients.favorYDeuda, 100, TreatmentPlanStatus.ACCEPTED);
    await pay(a, fyd1, patients.favorYDeuda, 40, '2026-10-05T15:00:00.000Z');

    // 10. Sede Norte (Tokio): abono a las 20:00 UTC = 05:00 del día siguiente allí.
    patients.norte = await patient(a, 'Norteño', { locationId: norte });
    const nPlan = await plan(
      a,
      patients.norte,
      60,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(a, nPlan, patients.norte, 60, '2026-10-26T20:00:00.000Z', norte);

    // 12. Cobrado en la Sede A (principal) y última cita en la Sede B (Norte):
    // el saldo está donde se cobró.
    patients.cobradoEnA = await patient(a, 'CobradoEnA', { locationId: norte });
    const ceaPlan = await plan(
      a,
      patients.cobradoEnA,
      500,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(
      a,
      ceaPlan,
      patients.cobradoEnA,
      80,
      '2026-10-02T15:00:00.000Z',
      principal,
    );

    // 13. Dos planes cancelados en dos sedes: dos filas (principal 50, Norte 20).
    patients.dosSedes = await patient(a, 'DosSedes', { locationId: principal });
    const dsA = await plan(
      a,
      patients.dosSedes,
      100,
      TreatmentPlanStatus.CANCELLED,
    );
    const dsB = await plan(
      a,
      patients.dosSedes,
      100,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(
      a,
      dsA,
      patients.dosSedes,
      50,
      '2026-09-10T15:00:00.000Z',
      principal,
    );
    await pay(a, dsB, patients.dosSedes, 20, '2026-09-11T15:00:00.000Z', norte);

    // 14. Plan USD 100 pagado con VES 5.400 cuya BASE es USD 120 (DX-051): USD 20 a favor.
    patients.conBase = await patient(a, 'ConBase', { locationId: principal });
    const cbPlan = await plan(
      a,
      patients.conBase,
      100,
      TreatmentPlanStatus.ACCEPTED,
      'USD',
    );
    const cbPay = await pay(
      a,
      cbPlan,
      patients.conBase,
      5400,
      '2026-10-03T15:00:00.000Z',
      principal,
      'VES',
    );
    await raw.paymentPlanAmount.create({
      data: {
        tenantId: a.tenantId,
        paymentId: cbPay,
        treatmentPlanId: cbPlan,
        currency: 'USD',
        amount: 120,
        rateDate: new Date('2026-10-03'),
      },
    });

    // 15. Plan USD 100 pagado con VES 5.400 con la tasa CONGELADA (36 Bs por USD)
    // y sin base: 5.400 / 36 = USD 150, USD 50 a favor.
    patients.tasaCongelada = await patient(a, 'TasaCongelada', {
      locationId: principal,
    });
    const tcPlan = await plan(
      a,
      patients.tasaCongelada,
      100,
      TreatmentPlanStatus.ACCEPTED,
      'USD',
    );
    await pay(
      a,
      tcPlan,
      patients.tasaCongelada,
      5400,
      '2026-10-04T15:00:00.000Z',
      principal,
      'VES',
      {
        exchangeRateCurrency: 'USD',
        exchangeRateFrom: 36,
        exchangeRateTo: 1,
        exchangeRateSource: 'MANUAL',
        exchangeRateDate: new Date('2026-10-04'),
      },
    );

    // 16. Un abono en VES «sin tasa» (sin base ni tasa) NO cuenta, ni en la lista
    // ni en el estado de cuenta: USD 130 pagados en USD sobre USD 100 = USD 30.
    patients.sinTasa = await patient(a, 'SinTasa', { locationId: principal });
    const stPlan = await plan(
      a,
      patients.sinTasa,
      100,
      TreatmentPlanStatus.ACCEPTED,
      'USD',
    );
    await pay(
      a,
      stPlan,
      patients.sinTasa,
      130,
      '2026-10-05T15:00:00.000Z',
      principal,
      'USD',
    );
    await pay(
      a,
      stPlan,
      patients.sinTasa,
      5400,
      '2026-10-06T15:00:00.000Z',
      principal,
      'VES',
      {
        exchangeRateCurrency: 'USD',
      },
    );

    // 17. Traspaso que deja el DESTINO a favor: origen cancelado con 300 pagados,
    // destino de 50 que recibe 200 (150 a favor) y origen con 100: 250 en total.
    patients.traspasoDestino = await patient(a, 'TraspasoDestino', {
      locationId: principal,
    });
    const tdOrigen = await plan(
      a,
      patients.traspasoDestino,
      300,
      TreatmentPlanStatus.CANCELLED,
    );
    const tdDestino = await plan(
      a,
      patients.traspasoDestino,
      50,
      TreatmentPlanStatus.ACCEPTED,
    );
    await pay(
      a,
      tdOrigen,
      patients.traspasoDestino,
      300,
      '2026-09-15T15:00:00.000Z',
      principal,
    );
    await transfer(tdOrigen, tdDestino, 200);

    // 18. Un abono ANULADO no cuenta: 200 anulado + 30 vivo = 30 a favor.
    patients.anulado = await patient(a, 'Anulado', { locationId: principal });
    const anPlan = await plan(
      a,
      patients.anulado,
      100,
      TreatmentPlanStatus.CANCELLED,
    );
    await pay(
      a,
      anPlan,
      patients.anulado,
      200,
      '2026-09-20T15:00:00.000Z',
      principal,
      'VES',
      {
        deletedAt: new Date('2026-09-21T15:00:00.000Z'),
        voidedAt: new Date('2026-09-21T15:00:00.000Z'),
        voidedById: a.adminUserId,
        voidReason: 'Error de captura',
      },
    );
    await pay(a, anPlan, patients.anulado, 30, '2026-09-22T15:00:00.000Z');

    // 19. Plan vivo pagado en cuotas que acaba pagado de más: la antigüedad es la
    // del abono que supera lo facturable (el último), no la del primero.
    patients.cuotas = await patient(a, 'Cuotas', { locationId: principal });
    const cuPlan = await plan(
      a,
      patients.cuotas,
      100,
      TreatmentPlanStatus.ACCEPTED,
      'USD',
    );
    await pay(
      a,
      cuPlan,
      patients.cuotas,
      50,
      '2026-01-10T15:00:00.000Z',
      principal,
      'USD',
    );
    await pay(
      a,
      cuPlan,
      patients.cuotas,
      50,
      '2026-05-10T15:00:00.000Z',
      principal,
      'USD',
    );
    await pay(
      a,
      cuPlan,
      patients.cuotas,
      20,
      '2026-10-10T15:00:00.000Z',
      principal,
      'USD',
    );

    // 11. Clínica B: un paciente con saldo a favor que A nunca ve.
    const sedeB = (
      (await get(b, '/locations').expect(200)).body as { id: string }[]
    )[0].id;
    const catalogB = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: b.tenantId,
          code: 'DX430-B',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina',
          color: '#2A2B3C',
          defaultPrice: 1,
        },
        select: { id: true },
      })
    ).id;
    patients.ajeno = await patient(b, 'Ajeno', { locationId: sedeB });
    const ajeno = await plan(
      b,
      patients.ajeno,
      10,
      TreatmentPlanStatus.CANCELLED,
      'VES',
      catalogB,
    );
    await pay(b, ajeno, patients.ajeno, 777, '2026-10-01T15:00:00.000Z', sedeB);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  const label = (r: Row): string =>
    `${r.patient.fullName.replace(' Favor', '')}:${r.currency}:${r.amount}`;

  it('lista a quien tiene saldo a favor (planes vivos, cancelados, rechazados, traspasos y devoluciones parciales, varias monedas) y a nadie más', async () => {
    const rows = await allRows(a);
    expect(rows.map(label).sort()).toEqual(
      [
        'Viva:VES:30',
        'Cancelada:VES:300',
        'Rechazada:VES:25',
        'TraspasoParcial:VES:100',
        'DevolucionParcial:VES:100',
        'Monedas:USD:10',
        'Monedas:VES:360',
        'FavorYDeuda:VES:40',
        'Norteño:VES:60',
        'CobradoEnA:VES:80',
        'DosSedes:VES:50',
        'DosSedes:VES:20',
        'ConBase:USD:20',
        'TasaCongelada:USD:50',
        'SinTasa:USD:30',
        'TraspasoDestino:VES:250',
        'Anulado:VES:30',
        'Cuotas:USD:20',
      ].sort(),
    );
  });

  it('ordena por moneda (código ISO) y luego por importe descendente', async () => {
    const rows = await allRows(a);
    const sorted = [...rows].sort(
      (x, y) =>
        x.currency.localeCompare(y.currency) ||
        y.amount - x.amount ||
        x.patient.id.localeCompare(y.patient.id) ||
        (x.location?.id ?? '').localeCompare(y.location?.id ?? ''),
    );
    expect(rows.map(keyOf)).toEqual(sorted.map(keyOf));
    expect(rows[0]).toMatchObject({ currency: 'USD', amount: 50 });
    expect(rows.find((r) => r.currency === 'VES')).toMatchObject({
      amount: 360,
    });
  });

  it('REGLA DE ORO: cada fila coincide con el saldo a favor del estado de cuenta del mismo paciente', async () => {
    const rows = await allRows(a);
    // El total por paciente y moneda es la suma de sus filas (una por sede).
    const listed = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.patient.id}:${r.currency}`;
      listed.set(
        key,
        Math.round(((listed.get(key) ?? 0) + r.amount) * 100) / 100,
      );
    }
    for (const [key, id] of Object.entries(patients)) {
      if (key === 'ajeno') continue;
      const statement = (
        await get(a, `/patients/${id}/account-statement`).expect(200)
      ).body as Statement;
      const expected = new Map<string, number>();
      for (const planLine of statement.plans) {
        if (planLine.balance < 0) {
          expected.set(
            planLine.currency,
            Math.round(
              ((expected.get(planLine.currency) ?? 0) - planLine.balance) * 100,
            ) / 100,
          );
        }
      }
      const inList = new Map(
        [...listed]
          .filter(([k]) => k.startsWith(`${id}:`))
          .map(([k, amount]) => [k.split(':')[1], amount]),
      );
      expect([key, [...inList].sort()]).toEqual([key, [...expected].sort()]);
    }
  });

  it('un traspaso total o una devolución total sacan al paciente; un plan con deuda no lo mete', async () => {
    const rows = await allRows(a);
    const ids = new Set(rows.map((r) => r.patient.id));
    expect(ids.has(patients.traspasoTotal)).toBe(false);
    expect(ids.has(patients.deuda)).toBe(false);
    expect(ids.has(patients.traspasoParcial)).toBe(true);
  });

  it('fecha el abono más antiguo en el día civil de la sede, no en el de UTC', async () => {
    const rows = await allRows(a);
    const row = (name: string, currency = 'VES') =>
      rows.find(
        (r) => r.patient.id === patients[name] && r.currency === currency,
      )!;
    const dayIn = (zone: string) => civilDateIn(NOW, zone);
    const daysBetween = (from: string, to: string) =>
      Math.round(
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
          86_400_000,
      );

    const cancelada = row('cancelada');
    const expectedSince = civilDateIn(
      new Date('2026-08-03T15:00:00.000Z'),
      principalZone,
    );
    expect(cancelada.since).toBe(expectedSince);
    expect(cancelada.ageDays).toBe(
      daysBetween(expectedSince, dayIn(principalZone)),
    );

    // 2026-10-26T20:00Z es el 27 en Tokio (UTC+9), no el 26 de UTC.
    const north = row('norte');
    expect(north.location).toEqual({ id: norte, name: 'Sede Norte' });
    expect(north.since).toBe('2026-10-27');
    expect(north.ageDays).toBe(
      daysBetween('2026-10-27', dayIn(REGIONAL_TOKYO_FIXTURE.timeZone)),
    );
  });

  it('el traspaso parcial se fecha con el abono de su plan de origen', async () => {
    const rows = await allRows(a);
    const row = rows.find((r) => r.patient.id === patients.traspasoParcial)!;
    expect(row.since).toBe(
      civilDateIn(new Date('2026-10-10T15:00:00.000Z'), principalZone),
    );
  });

  it('la cartera del paciente no decide la sede: cobrado en A y última cita en B, el saldo es de A', async () => {
    const rows = await allRows(a);
    const row = rows.find((r) => r.patient.id === patients.cobradoEnA)!;
    expect(row.location).toEqual({
      id: principal,
      name: expect.any(String) as unknown,
    });
    // Una recepcionista solo de A lo ve; una solo de B, no.
    const inPrincipal = await allRows(a, principalOnlyToken);
    expect(inPrincipal.map((r) => r.patient.id)).toContain(patients.cobradoEnA);
    const inNorte = await allRows(a, norteOnlyToken);
    expect(inNorte.map((r) => r.patient.id)).not.toContain(patients.cobradoEnA);
  });

  it('un paciente con saldo en dos sedes sale en dos filas, una por sede, y el estado de cuenta suma las dos', async () => {
    const rows = (await allRows(a)).filter(
      (r) => r.patient.id === patients.dosSedes,
    );
    expect(rows.map((r) => [r.location?.id, r.amount]).sort()).toEqual(
      [
        [principal, 50],
        [norte, 20],
      ].sort(),
    );
    const mine = await allRows(a, norteOnlyToken);
    expect(
      mine
        .filter((r) => r.patient.id === patients.dosSedes)
        .map((r) => r.amount),
    ).toEqual([20]);
  });

  it('un traspaso que deja el destino a favor suma origen y destino (250), fechado con el abono del origen', async () => {
    const rows = (await allRows(a)).filter(
      (r) => r.patient.id === patients.traspasoDestino,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(250);
    expect(rows[0].since).toBe(
      civilDateIn(new Date('2026-09-15T15:00:00.000Z'), principalZone),
    );
  });

  it('un plan vivo pagado en cuotas se fecha con el abono que lo dejó a favor, no con el primero', async () => {
    const row = (await allRows(a)).find(
      (r) => r.patient.id === patients.cuotas,
    )!;
    expect(row.amount).toBe(20);
    expect(row.since).toBe(
      civilDateIn(new Date('2026-10-10T15:00:00.000Z'), principalZone),
    );
  });

  it('pagina como la cartera: páginas sin repetidos que suman la lista completa, y total', async () => {
    const full = await allRows(a);
    const seen: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const res = await list(a, a.adminToken, `?pageSize=4&page=${page}`);
      expect(res.total).toBe(full.length);
      expect(res.pageSize).toBe(4);
      seen.push(...res.items.map(keyOf));
    }
    expect(seen).toEqual(full.map(keyOf));
    const totals = (await list(a)).totals;
    expect(totals).toEqual([
      { currency: 'USD', patients: 5, amount: 130 },
      { currency: 'VES', patients: 12, amount: 1445 },
    ]);
  });

  it('filtra por moneda', async () => {
    const res = await list(a, a.adminToken, '?currency=USD');
    expect(res.items.map(label).sort()).toEqual(
      [
        'Monedas:USD:10',
        'ConBase:USD:20',
        'TasaCongelada:USD:50',
        'SinTasa:USD:30',
        'Cuotas:USD:20',
      ].sort(),
    );
    await get(a, '/receivables/credit-balances?currency=dólar').expect(400);
  });

  it('RECEPTION lo ve; DENTIST y ASSISTANT, 403 en español', async () => {
    expect((await list(a, receptionToken)).total).toBe(18);
    for (const token of [dentistToken, assistantToken]) {
      const res = await get(a, '/receivables/credit-balances', token).expect(
        403,
      );
      expect((res.body as { message: string }).message).toMatch(/cartera/);
    }
  });

  it('filtra por sede: cabecera X-Location-Id y parámetro locationId; una sede ajena es 400', async () => {
    const byHeader = await list(a, a.adminToken, '', {
      'X-Location-Id': norte,
    });
    expect(byHeader.items.map(label).sort()).toEqual(
      ['Norteño:VES:60', 'DosSedes:VES:20'].sort(),
    );
    expect(byHeader.scope.location).toEqual({ id: norte, name: 'Sede Norte' });

    const byParam = await list(a, a.adminToken, `?locationId=${principal}`);
    expect(byParam.items.map((r) => r.patient.id)).not.toContain(
      patients.norte,
    );
    expect(byParam.total).toBe(16);

    await get(
      a,
      '/receivables/credit-balances?locationId=11111111-1111-4111-8111-111111111111',
    ).expect(400);
  });

  it('DX-089: un miembro restringido a Sede Norte solo ve la suya y no puede pedir otra', async () => {
    const mine = await list(a, norteOnlyToken);
    // El aviso de «abonos sin tasa» cuenta solo lo de sus sedes: el abono sin
    // tasa de SinTasa es de la sede principal (la clínica entera lo cuenta).
    expect(mine.paymentsWithoutRateCount).toBe(0);
    expect((await list(a)).paymentsWithoutRateCount).toBe(1);
    expect((await list(a, principalOnlyToken)).paymentsWithoutRateCount).toBe(
      1,
    );
    expect(mine.items.map(label).sort()).toEqual(
      ['Norteño:VES:60', 'DosSedes:VES:20'].sort(),
    );
    const res = await get(
      a,
      `/receivables/credit-balances?locationId=${principal}`,
      norteOnlyToken,
    ).expect(403);
    expect(res.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
  });

  it('aislamiento: la clínica B solo ve el suyo y A nunca ve el de B', async () => {
    const listB = await list(b);
    expect(listB.items.map((r) => [r.patient.id, r.amount])).toEqual([
      [patients.ajeno, 777],
    ]);
    const listA = await allRows(a);
    expect(listA.map((r) => r.patient.id)).not.toContain(patients.ajeno);
  });

  it('sin datos clínicos ni de contacto en la respuesta', async () => {
    const [row] = await allRows(a);
    expect(Object.keys(row).sort()).toEqual([
      'ageDays',
      'amount',
      'currency',
      'location',
      'patient',
      'since',
    ]);
    expect(Object.keys(row.patient).sort()).toEqual(['fullName', 'id']);
  });

  it('A2: tras devolver el resto del saldo, el paciente deja de aparecer', async () => {
    const before = await allRows(a);
    expect(before.map((r) => r.patient.id)).toContain(
      patients.devolucionParcial,
    );
    const payments = await raw.payment.findMany({
      where: { patientId: patients.devolucionParcial },
      select: { id: true, treatmentPlanId: true },
    });
    await refund(payments[0].treatmentPlanId!, [payments[0].id], 100);
    const after = await allRows(a);
    expect(after.map((r) => r.patient.id)).not.toContain(
      patients.devolucionParcial,
    );
    expect(after.length).toBe(before.length - 1);
  });

  // DB-076: los traspasos de ida y vuelta (P→Q→P) y en ciclo de tres
  // (P→Q→R→P) son flujos admitidos; la lista responde enseguida y con los
  // importes del estado de cuenta.
  it('DB-076: con traspasos en ciclo responde enseguida y con los importes correctos', async () => {
    const statementOf = async (patientId: string) =>
      (
        (await get(a, `/patients/${patientId}/account-statement`).expect(200))
          .body as Statement
      ).plans.reduce((sum, p) => sum + Math.max(-p.balance, 0), 0);

    const dos = await patient(a, 'CicloDos', { locationId: principal });
    const p2 = await plan(a, dos, 10, TreatmentPlanStatus.ACCEPTED);
    await pay(a, p2, dos, 110, '2026-08-01T15:00:00.000Z');
    const q2 = await plan(a, dos, 10, TreatmentPlanStatus.ACCEPTED);
    await transfer(p2, q2, 100);
    await transfer(q2, p2, 40);

    const tres = await patient(a, 'CicloTres', { locationId: principal });
    const p3 = await plan(a, tres, 10, TreatmentPlanStatus.ACCEPTED);
    await pay(a, p3, tres, 110, '2026-08-02T15:00:00.000Z');
    const q3 = await plan(a, tres, 10, TreatmentPlanStatus.ACCEPTED);
    const r3 = await plan(a, tres, 10, TreatmentPlanStatus.ACCEPTED);
    await transfer(p3, q3, 100);
    await transfer(q3, r3, 60);
    await transfer(r3, p3, 20);

    const started = Date.now();
    const res = await get(a, '/receivables/credit-balances?pageSize=100')
      .timeout(4_000)
      .expect(200);
    expect(Date.now() - started).toBeLessThan(2_000);

    const rows = (res.body as Page).items.filter((r) =>
      [dos, tres].includes(r.patient.id),
    );
    expect(
      rows.map((r) => [r.patient.id, r.location?.id, r.amount, r.since]),
    ).toEqual(
      expect.arrayContaining([
        [
          dos,
          principal,
          90,
          civilDateIn(new Date('2026-08-01T15:00:00.000Z'), principalZone),
        ],
        [
          tres,
          principal,
          80,
          civilDateIn(new Date('2026-08-02T15:00:00.000Z'), principalZone),
        ],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await statementOf(dos)).toBe(90);
    expect(await statementOf(tres)).toBe(80);
  }, 15_000);
});
