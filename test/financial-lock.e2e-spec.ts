import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { sedeTodayFixture } from './support/sede-clock';
import { pinCatalogCurrency } from './support/catalog-currency';
import {
  LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE,
  PERIOD_LOCKED_MESSAGES,
} from '../src/modules/financial-lock/domain/financial-lock';
import { FINANCIAL_LOCK_MESSAGES } from '../src/modules/financial-lock/domain/financial-lock-settings';
import { FINANCIAL_LOCK_FORBIDDEN_MESSAGE } from '../src/modules/financial-lock/presentation/financial-lock.controller';

// «Hoy» de la sede lejos de su medianoche (DX-449).
const SEDE = sedeTodayFixture();

// DX-091 en HTTP real: con el cierre contable no se registra, anula ni cambia
// dinero de un día cerrado (409 PERIOD_LOCKED en español), tampoco RECEPTION
// desde Caja o Estado de cuenta (DX-057); el ADMIN con la exención lo hace con
// motivo y queda registrado quién, cuándo y por qué. Fechas en el pasado para
// cualquier reloj de la CI: cierre el 30/09/2026.
const LOCK = '2026-09-30';
const CLOSED_DAY = '2026-09-15';
const OPEN_DAY = '2026-10-01';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LockBody {
  lockDate: string | null;
  lockDays: number | null;
  adminExempt: boolean;
  lockedThrough: string | null;
  overrides: {
    operation: string;
    businessDate: string;
    lockedThrough: string;
    reason: string;
    actor: { userId: string; name: string | null };
    paymentId: string | null;
    paymentPlanId: string | null;
    createdAt: string;
  }[];
}

interface CashBody {
  items: { id: string; canVoid: boolean; periodLocked: boolean }[];
  summary: unknown;
  total: number;
}

interface StatementBody {
  movements: {
    id: string;
    canVoid: boolean;
    periodLocked: boolean;
    voidBlockedReason: string | null;
  }[];
}

describe('Cierre contable: abonos, anulaciones y planes de cuotas (e2e, DX-091)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let patientA: string;
  let planA: string;
  let today: string;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string, body: object = {}) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  const setLock = (body: object, clinic = a) =>
    as(clinic).patch('/clinic/settings/financial-lock', body);

  const pay = (paidAt: string, token = receptionA, extra: object = {}) =>
    as(a, token).post(`/treatment-plans/${planA}/payments`, {
      amount: 25,
      currency: 'USD',
      paidAt,
      method: 'CASH',
      ...extra,
    });

  const septemberCash = async (token: string) =>
    (
      await as(a, token)
        .get('/payments?from=2026-09-01&to=2026-09-30&pageSize=100')
        .expect(200)
    ).body as CashBody;

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx091-cierre-a', SEDE);
    b = await registerClinic(app, 'dx091-cierre-b');
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    today = civilDateIn(new Date(), SEDE.timeZone);

    patientA = (
      (
        await as(a)
          .post('/patients', {
            firstName: 'Carmen',
            lastName: 'Cierre',
            docType: 'NATIONAL_ID',
            docNumber: 'DX091-A',
            sex: 'F',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const item = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX091-A',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1_000,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(a)
          .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(a)
        .post(`/treatment-plans/${planA}/items`, {
          toothNumber: '11',
          catalogItemId: item.id,
        })
        .expect(201)
    ).body as { id: string };
    await request(server())
      .patch(`/api/v1/treatment-plans/${planA}/items/${planItem.id}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ status: 'DONE' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  let septemberPayment: string;

  it('sin cierre: se registra con cualquier fecha pasada y no hay nada cerrado', async () => {
    const lock = (
      await as(a).get('/clinic/settings/financial-lock').expect(200)
    ).body as LockBody;
    expect(lock).toEqual({
      lockDate: null,
      lockDays: null,
      adminExempt: false,
      lockedThrough: null,
      overrides: [],
    });
    expect(
      (await as(a, receptionA).get('/payments/period-lock').expect(200)).body,
    ).toEqual({ lockedThrough: null, canOverride: false });
    // RECEPTION registra HOY un abono con fecha de septiembre (antes del cierre).
    septemberPayment = (
      (await pay('2026-09-20').expect(201)).body as { id: string }
    ).id;
  });

  it('solo ADMIN configura el cierre (403 en español) y la fecha tiene que ser anterior a hoy (400)', async () => {
    const denied = await as(a, receptionA)
      .patch('/clinic/settings/financial-lock', { lockDate: LOCK })
      .expect(403);
    expect((denied.body as { message: string }).message).toBe(
      FINANCIAL_LOCK_FORBIDDEN_MESSAGE,
    );
    await as(a, receptionA).get('/clinic/settings/financial-lock').expect(403);

    const future = await setLock({ lockDate: today }).expect(400);
    expect((future.body as { message: string }).message).toBe(
      FINANCIAL_LOCK_MESSAGES.lockDateNotPast,
    );
    const days = await setLock({ lockDays: 366 }).expect(400);
    expect((days.body as { message: string }).message).toBe(
      FINANCIAL_LOCK_MESSAGES.lockDays,
    );
    await setLock({ lockDate: '30/09/2026' }).expect(400);
  });

  it('con lockDate = 2026-09-30, cierra el 30/09 y queda auditado con antes y después', async () => {
    const saved = (await setLock({ lockDate: LOCK }).expect(200))
      .body as LockBody;
    expect(saved).toMatchObject({
      lockDate: LOCK,
      lockDays: null,
      adminExempt: false,
      lockedThrough: LOCK,
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'CLINIC_SETTINGS',
        metadata: { path: ['reason'], equals: 'FINANCIAL_LOCK' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toEqual({
      reason: 'FINANCIAL_LOCK',
      changedFields: ['financialLockDate'],
      configChange: {
        before: { financialLockDate: null },
        after: { financialLockDate: LOCK },
      },
    });
    expect(
      (await as(a, receptionA).get('/payments/period-lock').expect(200)).body,
    ).toEqual({ lockedThrough: LOCK, canOverride: false });
  });

  it('crear un abono con fecha 2026-09-15 → 409 PERIOD_LOCKED; con 2026-10-01 → 201', async () => {
    const before = await septemberCash(a.adminToken);
    const locked = await pay(CLOSED_DAY).expect(409);
    expect(locked.body).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: PERIOD_LOCKED_MESSAGES.PAYMENT_CREATE,
      lockedThrough: LOCK,
    });
    // El último día cerrado también.
    await pay(LOCK).expect(409);
    // Un cobro dividido y el saldo inicial pasan por el mismo alta.
    await as(a, receptionA)
      .post(`/treatment-plans/${planA}/split-payments`, {
        paidAt: CLOSED_DAY,
        confirmCreditBalance: true,
        lines: [
          { amount: 5, currency: 'USD', paymentMethodId: await cashMethod() },
          {
            amount: 5,
            currency: 'USD',
            paymentMethodId: await transferMethod(),
            reference: 'DX091-1',
          },
        ],
      })
      .expect(409);
    await pay(OPEN_DAY).expect(201);
    // La caja de septiembre (DX-002) no cambió.
    expect(await septemberCash(a.adminToken)).toEqual(before);
  });

  async function cashMethod(): Promise<string> {
    return (
      await raw.clinicPaymentMethod.findFirstOrThrow({
        where: { tenantId: a.tenantId, legacyMethod: 'CASH' },
        select: { id: true },
      })
    ).id;
  }

  async function transferMethod(): Promise<string> {
    return (
      await raw.clinicPaymentMethod.findFirstOrThrow({
        where: { tenantId: a.tenantId, legacyMethod: 'TRANSFER' },
        select: { id: true },
      })
    ).id;
  }

  it('Caja y Estado de cuenta marcan el abono cerrado y no ofrecen «Anular» a RECEPTION', async () => {
    const cash = await septemberCash(receptionA);
    expect(cash.items.find((i) => i.id === septemberPayment)).toMatchObject({
      canVoid: false,
      periodLocked: true,
    });
    const statement = (
      await as(a, receptionA)
        .get(`/patients/${patientA}/account-statement`)
        .expect(200)
    ).body as StatementBody;
    expect(
      statement.movements.find((m) => m.id === septemberPayment),
    ).toMatchObject({
      canVoid: false,
      periodLocked: true,
      voidBlockedReason: PERIOD_LOCKED_MESSAGES.PAYMENT_VOID,
    });
  });

  it('anular un abono de un período cerrado → 409, también para RECEPTION (su abono de hoy)', async () => {
    const before = await septemberCash(a.adminToken);
    const reception = await as(a, receptionA)
      .delete(`/payments/${septemberPayment}`, {
        reason: 'Cobro duplicado por error',
        lockOverrideReason: 'Recepción no puede saltarlo',
      })
      .expect(409);
    expect(reception.body).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: PERIOD_LOCKED_MESSAGES.PAYMENT_VOID,
      lockedThrough: LOCK,
    });
    // ADMIN sin la exención de la clínica, ni con motivo.
    await as(a)
      .delete(`/payments/${septemberPayment}`, {
        reason: 'Cobro duplicado por error',
        lockOverrideReason: 'Ajuste con el extracto del banco',
      })
      .expect(409);
    expect(await septemberCash(a.adminToken)).toEqual(before);
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: septemberPayment },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).toBeNull();
  });

  it('con la exención, el ADMIN anula con motivo (sin él, 400) y queda quién, cuándo y por qué', async () => {
    await setLock({ adminExempt: true }).expect(200);
    expect((await as(a).get('/payments/period-lock').expect(200)).body).toEqual(
      { lockedThrough: LOCK, canOverride: true },
    );
    // RECEPTION sigue sin poder.
    expect(
      (await as(a, receptionA).get('/payments/period-lock').expect(200)).body,
    ).toEqual({ lockedThrough: LOCK, canOverride: false });
    // El ADMIN ve «Anular» con el abono marcado cerrado.
    const cash = await septemberCash(a.adminToken);
    expect(cash.items.find((i) => i.id === septemberPayment)).toMatchObject({
      canVoid: true,
      periodLocked: true,
    });

    const missing = await as(a)
      .delete(`/payments/${septemberPayment}`, {
        reason: 'Cobro duplicado por error',
      })
      .expect(400);
    expect((missing.body as { message: string }).message).toBe(
      LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE,
    );

    const startedAt = new Date();
    await as(a)
      .delete(`/payments/${septemberPayment}`, {
        reason: 'Cobro duplicado por error',
        lockOverrideReason: 'Duplicado confirmado con el extracto del banco',
      })
      .expect(200);

    const lock = (
      await as(a).get('/clinic/settings/financial-lock').expect(200)
    ).body as LockBody;
    expect(lock.overrides).toHaveLength(1);
    expect(lock.overrides[0]).toMatchObject({
      operation: 'PAYMENT_VOID',
      paymentId: septemberPayment,
      paymentPlanId: null,
      businessDate: '2026-09-20',
      lockedThrough: LOCK,
      reason: 'Duplicado confirmado con el extracto del banco',
      actor: { userId: a.adminUserId, name: 'Dr. Owner' },
    });
    expect(new Date(lock.overrides[0].createdAt).getTime()).toBeGreaterThan(
      startedAt.getTime() - 60_000,
    );
    const voided = await raw.payment.findUniqueOrThrow({
      where: { id: septemberPayment },
      select: { voidedAt: true, voidedById: true },
    });
    expect(voided.voidedById).toBe(a.adminUserId);
  });

  it('con la exención, el ADMIN registra con fecha cerrada indicando motivo', async () => {
    await pay(CLOSED_DAY, a.adminToken).expect(400);
    const created = (
      await pay(CLOSED_DAY, a.adminToken, {
        lockOverrideReason: 'Abono de septiembre que faltaba en el sistema',
      }).expect(201)
    ).body as { id: string };
    const rows = await raw.financialLockOverride.findMany({
      where: { tenantId: a.tenantId, paymentId: created.id },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        operation: 'PAYMENT_CREATE',
        actorUserId: a.adminUserId,
        reason: 'Abono de septiembre que faltaba en el sistema',
      }),
    ]);
    // RECEPTION, aun con motivo, sigue en 409.
    await pay(CLOSED_DAY, receptionA, {
      lockOverrideReason: 'Lo pidió administración',
    }).expect(409);
  });

  it('el registro de excepciones es append-only para la app', async () => {
    const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
    try {
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRaw`UPDATE "financial_lock_overrides" SET "reason" = 'otro motivo'`;
        }),
      ).rejects.toThrow();
    } finally {
      await appDb.$disconnect();
    }
  });

  it('planes de cuotas: no se crean con cuotas en días cerrados ni se cancelan si alguna venció en ellos', async () => {
    await setLock({ lockDate: null, adminExempt: false }).expect(200);
    // Sin cierre se crea uno que empezó en septiembre.
    await as(a, receptionA)
      .post(`/treatment-plans/${planA}/payment-plan`, {
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: '2026-09-01',
        totalToFinance: 300,
      })
      .expect(201);
    await setLock({ lockDate: LOCK, adminExempt: true }).expect(200);

    const cancel = await as(a, receptionA)
      .delete(`/treatment-plans/${planA}/payment-plan`)
      .expect(409);
    expect(cancel.body).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: PERIOD_LOCKED_MESSAGES.PAYMENT_PLAN_CANCEL,
    });
    await as(a)
      .delete(`/treatment-plans/${planA}/payment-plan`, {})
      .expect(400);
    await as(a)
      .delete(`/treatment-plans/${planA}/payment-plan`, {
        lockOverrideReason: 'El paciente abandonó el tratamiento en septiembre',
      })
      .expect(204);

    // Crear otro con la primera cuota en septiembre: 409 a RECEPTION.
    const create = await as(a, receptionA)
      .post(`/treatment-plans/${planA}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2026-09-15',
        totalToFinance: 200,
      })
      .expect(409);
    expect(create.body).toMatchObject({
      code: 'PERIOD_LOCKED',
      message: PERIOD_LOCKED_MESSAGES.PAYMENT_PLAN_CREATE,
    });
    // Empezando después del cierre, sí.
    await as(a, receptionA)
      .post(`/treatment-plans/${planA}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: OPEN_DAY,
        totalToFinance: 200,
      })
      .expect(201);

    const ops = (
      (await as(a).get('/clinic/settings/financial-lock').expect(200))
        .body as LockBody
    ).overrides.map((o) => o.operation);
    expect(ops[0]).toBe('PAYMENT_PLAN_CANCEL');
  });

  it('con lockDays = 7 y una fecha fija más antigua rige el cierre por días', async () => {
    const saved = (await setLock({ lockDate: LOCK, lockDays: 7 }).expect(200))
      .body as LockBody;
    expect(saved.lockedThrough).toBe(addCivilDays(today, -8));
    await pay(addCivilDays(today, -8)).expect(409);
    await pay(addCivilDays(today, -7)).expect(201);
  });

  it('otra clínica no ve el cierre ni las excepciones de A', async () => {
    const lockB = (
      await as(b).get('/clinic/settings/financial-lock').expect(200)
    ).body as LockBody;
    expect(lockB).toMatchObject({
      lockDate: null,
      lockDays: null,
      lockedThrough: null,
      overrides: [],
    });
    expect((await as(b).get('/payments/period-lock').expect(200)).body).toEqual(
      { lockedThrough: null, canOverride: false },
    );
  });
});
