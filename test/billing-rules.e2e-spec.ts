import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CatalogKind, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { registerVerified } from './support/register-verified';
import { hostFor } from './support/tenant-host';
import { resetDatabase } from './support/e2e-fixtures';

// DX-109 · reglas de cobro por HTTP: un solo «aceptar», nada cobrable en
// planes cerrados, saldo coherente con el estado de cuenta, idempotencia con
// huella. Ninguna respuesta de estas rutas puede ser 5xx.
// DIRECT_URL (superusuario, sin RLS) solo para inspeccionar y limpiar.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';
const SUBDOMAIN = 'reglas-cobro-dx109';

interface Session {
  accessToken: string;
  subdomain: string;
}

interface BalanceBody {
  planCurrency: string;
  billable: number;
  paid: number;
  balance: number;
  paymentsCount: number;
}

interface StatementBody {
  summary: {
    currency: string;
    budgeted: number;
    paid: number;
    balance: number;
  }[];
  plans: {
    id: string;
    currency: string;
    budgeted: number;
    countsTowardsBalance: boolean;
    paid: number;
    balance: number;
  }[];
}

interface ErrorBody {
  statusCode: number;
  message: string;
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Reglas de cobro (e2e, DX-109)', () => {
  let app: INestApplication<App>;
  let clinic: Session;
  let patientId: string;
  let catalogItemId: string;
  const statuses: number[] = [];

  const server = () => app.getHttpServer();

  function as(session: Session) {
    const send = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect((res) => statuses.push(res.status));
    return {
      get: (path: string) => send(request(server()).get(`/api/v1${path}`)),
      post: (
        path: string,
        body: object,
        headers: Record<string, string> = {},
      ) =>
        send(request(server()).post(`/api/v1${path}`).set(headers)).send(body),
      patch: (path: string, body: object) =>
        send(request(server()).patch(`/api/v1${path}`)).send(body),
      delete: (path: string) =>
        send(request(server()).delete(`/api/v1${path}`)),
    };
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    await registerVerified(app, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dra. Owner',
    });
    const login = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return {
      accessToken: (login.body as { accessToken: string }).accessToken,
      subdomain,
    };
  }

  /** Plan USD con dos ítems PROPOSED: 100 − 10 y 50 (facturable aceptado 140). */
  async function createPlan(): Promise<{ planId: string; itemId: string }> {
    const plan = await as(clinic)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const first = await as(clinic)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '11',
        catalogItemId,
        price: 100,
        discount: 10,
      })
      .expect(201);
    await as(clinic)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '21',
        catalogItemId,
        price: 50,
      })
      .expect(201);
    return { planId, itemId: (first.body as { id: string }).id };
  }

  const accept = (planId: string) =>
    as(clinic)
      .patch(`/treatment-plans/${planId}`, { status: 'ACCEPTED' })
      .expect(200);

  const pay = (planId: string, amount: number, key?: string) =>
    as(clinic).post(
      `/treatment-plans/${planId}/payments`,
      { amount, currency: 'USD', paidAt: '2026-10-16', method: 'CASH' },
      key ? { 'Idempotency-Key': key } : {},
    );

  const balanceOf = async (planId: string) =>
    (await as(clinic).get(`/treatment-plans/${planId}/balance`).expect(200))
      .body as BalanceBody;

  async function rejectedPlan(): Promise<string> {
    const { planId } = await createPlan();
    await as(clinic).post(`/treatment-plans/${planId}/present`, {}).expect(200);
    await as(clinic)
      .post(`/treatment-plans/${planId}/reject`, { reason: 'PRICE' })
      .expect(200);
    return planId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await cleanup();

    clinic = await register(SUBDOMAIN);
    const patient = await as(clinic)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Cobro',
        docType: DocType.CC,
        docNumber: 'DX109-1',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(clinic)
      .post('/catalog/items', {
        code: 'DX109-RES',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  afterEach(() => {
    // Ninguna ruta de cobro responde 5xx, ni siquiera al rechazar.
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it('criterio 3: PATCH ACCEPTED deja los ítems ACCEPTED y el facturable completo', async () => {
    const { planId } = await createPlan();
    await accept(planId);
    const detail = await as(clinic)
      .get(`/treatment-plans/${planId}`)
      .expect(200);
    expect(
      (detail.body as { items: { status: string }[] }).items.map(
        (i) => i.status,
      ),
    ).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect((await balanceOf(planId)).billable).toBe(140);
  });

  it('criterio 1: abono sobre plan rechazado o cancelado → 409 en español; COMPLETED sí cobra', async () => {
    const rejected = await rejectedPlan();
    const res = await pay(rejected, 10).expect(409);
    expect((res.body as ErrorBody).message).toBe(
      'El plan está «Rechazado»: no admite abonos ni planes de cuotas.',
    );

    const { planId: cancelled } = await createPlan();
    await as(clinic)
      .patch(`/treatment-plans/${cancelled}`, { status: 'CANCELLED' })
      .expect(200);
    await pay(cancelled, 10).expect(409);

    const { planId: completed } = await createPlan();
    await accept(completed);
    await as(clinic)
      .patch(`/treatment-plans/${completed}`, { status: 'COMPLETED' })
      .expect(200);
    await pay(completed, 10).expect(201);
  });

  it('criterio 2: plan de cuotas sobre plan no cobrable → 409; cancelar el plan cancela su plan de cuotas', async () => {
    const rejected = await rejectedPlan();
    const refused = await as(clinic)
      .post(`/treatment-plans/${rejected}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2099-01-10',
      })
      .expect(409);
    expect((refused.body as ErrorBody).message).toMatch(/no admite abonos/);

    const { planId } = await createPlan();
    await accept(planId);
    await as(clinic)
      .post(`/treatment-plans/${planId}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2099-01-10',
      })
      .expect(201);
    await as(clinic)
      .patch(`/treatment-plans/${planId}`, { status: 'CANCELLED' })
      .expect(200);
    await as(clinic).get(`/treatment-plans/${planId}/payment-plan`).expect(404);
    const stored = await raw.paymentPlan.findFirstOrThrow({
      where: { treatmentPlanId: planId },
    });
    expect(stored).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Se canceló el plan de tratamiento.',
    });
    expect(stored.cancelledById).not.toBeNull();
    expect(stored.cancelledAt).not.toBeNull();
  });

  it('criterio 4: la moneda no cambia con abonos vivos, plan de cuotas activo o plan cerrado', async () => {
    const { planId } = await createPlan();
    await accept(planId);
    await pay(planId, 10).expect(201);
    const withPayments = await as(clinic)
      .patch(`/treatment-plans/${planId}`, { currency: 'COP' })
      .expect(409);
    expect((withPayments.body as ErrorBody).message).toMatch(
      /abonos registrados/,
    );

    const { planId: financed } = await createPlan();
    await accept(financed);
    await as(clinic)
      .post(`/treatment-plans/${financed}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2099-01-10',
      })
      .expect(201);
    await as(clinic)
      .patch(`/treatment-plans/${financed}`, { currency: 'COP' })
      .expect(409);

    const { planId: cancelled } = await createPlan();
    await as(clinic)
      .patch(`/treatment-plans/${cancelled}`, { status: 'CANCELLED' })
      .expect(200);
    await as(clinic)
      .patch(`/treatment-plans/${cancelled}`, { currency: 'COP' })
      .expect(409);

    // Sin abonos ni cuotas, un borrador sí cambia de moneda.
    const { planId: draft } = await createPlan();
    await as(clinic)
      .patch(`/treatment-plans/${draft}`, { currency: 'COP' })
      .expect(200);
  });

  it('criterio 5: no se añaden, editan ni quitan ítems en planes cancelados, rechazados o completados', async () => {
    const rejected = await rejectedPlan();
    const { planId: completed, itemId } = await createPlan();
    await accept(completed);
    await as(clinic)
      .patch(`/treatment-plans/${completed}`, { status: 'COMPLETED' })
      .expect(200);
    for (const planId of [rejected, completed]) {
      const res = await as(clinic)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '31',
          catalogItemId,
          price: 1,
        })
        .expect(409);
      expect((res.body as ErrorBody).message).toMatch(
        /sus ítems ya no se pueden añadir, cambiar ni quitar/,
      );
    }
    await as(clinic)
      .patch(`/treatment-plans/${completed}/items/${itemId}`, { price: 5 })
      .expect(409);
    await as(clinic)
      .delete(`/treatment-plans/${completed}/items/${itemId}`)
      .expect(409);

    // Revisión DX-109: lo único que admite un plan completado es marcar como
    // realizado lo que quedó aceptado (llega al odontograma); volver atrás no.
    const done = await as(clinic)
      .patch(`/treatment-plans/${completed}/items/${itemId}`, {
        status: 'DONE',
      })
      .expect(200);
    expect((done.body as { status: string }).status).toBe('DONE');
    expect(
      await raw.toothRecord.count({ where: { sourcePlanItemId: itemId } }),
    ).toBe(1);
    const back = await as(clinic)
      .patch(`/treatment-plans/${completed}/items/${itemId}`, {
        status: 'ACCEPTED',
      })
      .expect(409);
    expect((back.body as ErrorBody).message).toMatch(
      /Solo se puede marcar como realizado/,
    );
    const rejectedItem = await raw.treatmentPlanItem.findFirstOrThrow({
      where: { planId: rejected },
    });
    await as(clinic)
      .patch(`/treatment-plans/${rejected}/items/${rejectedItem.id}`, {
        status: 'DONE',
      })
      .expect(409);
  });

  it('revisión DX-109: rechazar un plan con plan de cuotas activo (sin abonos) lo cancela con autor y motivo', async () => {
    const { planId, itemId } = await createPlan();
    await as(clinic)
      .patch(`/treatment-plans/${planId}/items/${itemId}`, {
        status: 'ACCEPTED',
      })
      .expect(200);
    await as(clinic).post(`/treatment-plans/${planId}/present`, {}).expect(200);
    await as(clinic)
      .post(`/treatment-plans/${planId}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2099-01-10',
      })
      .expect(201);
    await as(clinic)
      .post(`/treatment-plans/${planId}/reject`, { reason: 'PRICE' })
      .expect(200);
    await as(clinic).get(`/treatment-plans/${planId}/payment-plan`).expect(404);
    const stored = await raw.paymentPlan.findFirstOrThrow({
      where: { treatmentPlanId: planId },
    });
    expect(stored).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Se rechazó el plan de tratamiento.',
    });
    expect(stored.cancelledById).not.toBeNull();
  });

  it('criterio 6: balance de un plan no cobrable = 0 facturable con sus abonos en paid, y cuadra con el estado de cuenta (USD)', async () => {
    const { planId: open } = await createPlan();
    await accept(open);
    await pay(open, 40).expect(201);
    const { planId: cancelled } = await createPlan();
    await accept(cancelled);
    await pay(cancelled, 25).expect(201);
    await as(clinic)
      .patch(`/treatment-plans/${cancelled}`, { status: 'CANCELLED' })
      .expect(200);

    const cancelledBalance = await balanceOf(cancelled);
    expect(cancelledBalance).toMatchObject({
      billable: 0,
      paid: 25,
      balance: -25,
    });

    const statement = (
      await as(clinic)
        .get(`/patients/${patientId}/account-statement`)
        .expect(200)
    ).body as StatementBody;
    const usdPlans = statement.plans.filter((p) => p.currency === 'USD');
    let balanceSum = 0;
    for (const plan of usdPlans) {
      const b = await balanceOf(plan.id);
      expect(b.paid).toBe(plan.paid);
      expect(b.billable).toBe(plan.countsTowardsBalance ? plan.budgeted : 0);
      balanceSum += b.balance;
    }
    const usd = statement.summary.find((s) => s.currency === 'USD');
    expect(usd?.balance).toBeCloseTo(balanceSum, 2);
  });

  it('criterio 7: Idempotency-Key idéntica → el original; otro cuerpo u otro plan → 422', async () => {
    const { planId: a } = await createPlan();
    const { planId: b } = await createPlan();
    await accept(a);
    await accept(b);
    const key = '3f2e1d0c-4b5a-4968-8776-655443322110';

    const first = await pay(a, 30, key).expect(201);
    const again = await pay(a, 30, key).expect(201);
    expect((again.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    const otherBody = await pay(a, 31, key).expect(422);
    expect((otherBody.body as ErrorBody).message).toMatch(
      /clave de idempotencia ya se usó/,
    );
    await pay(b, 30, key).expect(422);
    expect(await raw.payment.count({ where: { idempotencyKey: key } })).toBe(1);
  });
});
