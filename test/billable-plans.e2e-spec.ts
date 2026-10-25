import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';

// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros con rol y para
// limpiar entre tenants — mismo criterio que account-statement.e2e-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
// Textos clínicos sembrados a propósito: no pueden aparecer en la respuesta.
const PLAN_NOTE = 'Nota clínica del plan: paciente con bruxismo';
const ITEM_NOTE = 'Sensibilidad tras la endodoncia';
const PROCEDURE_LABEL = 'Endodoncia molar DX067';

// Contrato EXACTO de cada plan cobrable: ni una clave más (DX-067).
const BILLABLE_PLAN_KEYS = [
  'balance',
  'createdAt',
  'currency',
  'hasActivePaymentPlan',
  'id',
  'paid',
  'paidOtherCurrencies',
  'status',
  'total',
];

interface Session {
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}

interface BillablePlanBody {
  id: string;
  status: string;
  currency: string;
  createdAt: string;
  total: number;
  paid: number;
  paidOtherCurrencies: { currency: string; amount: number }[];
  balance: number;
  hasActivePaymentPlan: boolean;
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Planes cobrables — GET /patients/:patientId/billable-plans (e2e, DX-067)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let patientId: string;
  let emptyPatientId: string;
  let otherClinicPatientId: string;
  let catalogItemId: string;
  let reception: string;
  let dentist: string;
  let assistant: string;

  // usdPlan       USD 1000 (DRAFT, ítem ACCEPTED) · abonos 300 USD + 100 USD (anulado) + 50000 COP
  //               · plan de cuotas activo
  // copPlan       COP 500000 COMPLETED · sin abonos
  // cancelledPlan USD 500 · luego CANCELLED (fuera)
  // proposedPlan  USD 999 solo PROPOSED (nada facturable: fuera)
  let usdPlan: string;
  let copPlan: string;
  let cancelledPlan: string;
  let proposedPlan: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const host = hostFor(session.subdomain);
    return {
      get: (path: string) =>
        request(server())
          .get(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`),
      post: (path: string, body: object) =>
        request(server())
          .post(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      patch: (path: string, body: object) =>
        request(server())
          .patch(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      delete: (path: string, body: object = {}) =>
        request(server())
          .delete(`/api/v1${path}`)
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${token}`)
          .send(body),
    };
  }

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await registerVerified(app, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    });
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      userId: (reg.body as { userId: string }).userId,
      accessToken: await login(subdomain, email),
      subdomain,
    };
  }

  async function memberToken(
    session: Session,
    role: ClinicRole,
  ): Promise<string> {
    const email = `${role.toLowerCase()}@${session.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: `Staff ${role}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: session.tenantId, userId: user.id, role },
    });
    return login(session.subdomain, email);
  }

  async function createPatient(
    session: Session,
    docNumber: string,
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName: 'Bea',
        lastName: 'Cobro',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Plan con un ítem al precio dado; `accept` lo pasa a ACCEPTED. */
  async function createPlan(
    currency: string,
    price: number,
    accept = true,
  ): Promise<string> {
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, {
        currency,
        notes: PLAN_NOTE,
      })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const item = await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '36',
        catalogItemId,
        price,
        notes: ITEM_NOTE,
      })
      .expect(201);
    if (accept) {
      await as(clinicA)
        .patch(
          `/treatment-plans/${planId}/items/${(item.body as { id: string }).id}`,
          { status: 'ACCEPTED' },
        )
        .expect(200);
    }
    return planId;
  }

  async function pay(
    planId: string,
    amount: number,
    currency: string,
  ): Promise<string> {
    const res = await as(clinicA)
      .post(`/treatment-plans/${planId}/payments`, {
        amount,
        currency,
        paidAt: '2026-07-01T00:00:00.000Z',
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
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

    clinicA = await register('planes-cobrables-a');
    clinicB = await register('planes-cobrables-b');
    patientId = await createPatient(clinicA, 'PC-A-001');
    emptyPatientId = await createPatient(clinicA, 'PC-A-002');
    otherClinicPatientId = await createPatient(clinicB, 'PC-B-001');
    reception = await memberToken(clinicA, ClinicRole.RECEPTION);
    dentist = await memberToken(clinicA, ClinicRole.DENTIST);
    assistant = await memberToken(clinicA, ClinicRole.ASSISTANT);

    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'PC-ENDO',
        kind: CatalogKind.PROCEDURE,
        labelEs: PROCEDURE_LABEL,
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    usdPlan = await createPlan('USD', 1000);
    await pay(usdPlan, 300, 'USD');
    const voided = await pay(usdPlan, 100, 'USD');
    await as(clinicA)
      .delete(`/payments/${voided}`, { reason: 'Cobro duplicado' })
      .expect(200);
    await as(clinicA)
      .post(`/treatment-plans/${usdPlan}/payment-plan`, {
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: '2099-01-10T00:00:00.000Z',
        totalToFinance: 700,
      })
      .expect(201);
    // Después del plan de cuotas: su respuesta convierte cada abono a la
    // moneda del plan, y en test no hay proveedor de tasas.
    await pay(usdPlan, 50000, 'COP');

    copPlan = await createPlan('COP', 500000);
    // Máquina de estados (DX-040): un plan se completa después de aceptarse.
    await as(clinicA)
      .patch(`/treatment-plans/${copPlan}`, { status: 'ACCEPTED' })
      .expect(200);
    await as(clinicA)
      .patch(`/treatment-plans/${copPlan}`, { status: 'COMPLETED' })
      .expect(200);

    cancelledPlan = await createPlan('USD', 500);
    await as(clinicA)
      .patch(`/treatment-plans/${cancelledPlan}`, { status: 'CANCELLED' })
      .expect(200);

    proposedPlan = await createPlan('USD', 999, false);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('recepción lista los planes cobrables con total, abonado y saldo', async () => {
    const res = await as(clinicA, reception)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(200);
    const body = res.body as BillablePlanBody[];

    const ids = body.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([usdPlan, copPlan]));
    expect(ids).not.toContain(cancelledPlan);
    expect(ids).not.toContain(proposedPlan);
    expect(body).toHaveLength(2);

    const byId = new Map(body.map((p) => [p.id, p]));
    expect(byId.get(usdPlan)).toEqual({
      id: usdPlan,
      // El plan sigue en borrador: lo facturable son sus ítems aceptados.
      status: 'DRAFT',
      currency: 'USD',
      createdAt: expect.any(String) as string,
      total: 1000,
      // El anulado no suma; el abono en COP va aparte, sin convertir.
      paid: 300,
      paidOtherCurrencies: [{ currency: 'COP', amount: 50000 }],
      balance: 700,
      hasActivePaymentPlan: true,
    });
    expect(byId.get(copPlan)).toMatchObject({
      status: 'COMPLETED',
      currency: 'COP',
      total: 500000,
      paid: 0,
      balance: 500000,
      hasActivePaymentPlan: false,
    });
  });

  it('contrato: sin datos clínicos (ni notas, ni dientes, ni ítems, ni procedimientos)', async () => {
    const res = await as(clinicA, reception)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(200);
    const body = res.body as Record<string, unknown>[];

    for (const plan of body) {
      expect(Object.keys(plan).sort()).toEqual(BILLABLE_PLAN_KEYS);
    }
    const text = JSON.stringify(body);
    for (const forbidden of [
      PLAN_NOTE,
      ITEM_NOTE,
      PROCEDURE_LABEL,
      'toothNumber',
      'surfaces',
      'catalogItemId',
      'notes',
      'items',
      'diagnos',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('paciente sin planes cobrables -> lista vacía', async () => {
    await as(clinicA, reception)
      .get(`/patients/${emptyPatientId}/billable-plans`)
      .expect(200)
      .expect([]);
  });

  it('aísla por clínica: paciente de otro tenant -> 404, igual que un UUID inexistente', async () => {
    await as(clinicB).get(`/patients/${patientId}/billable-plans`).expect(404);
    await as(clinicA, reception)
      .get(`/patients/${otherClinicPatientId}/billable-plans`)
      .expect(404);
    await as(clinicA)
      .get('/patients/00000000-0000-4000-8000-000000000000/billable-plans')
      .expect(404);
    await as(clinicA).get('/patients/no-es-uuid/billable-plans').expect(400);
  });

  it('aplica PAYMENT_ROLES: ADMIN y recepción sí; dentista y asistente 403; sin token 401', async () => {
    await as(clinicA).get(`/patients/${patientId}/billable-plans`).expect(200);
    await as(clinicA, dentist)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(403);
    await as(clinicA, assistant)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(403);
    await request(server())
      .get(`/api/v1/patients/${patientId}/billable-plans`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(401);
  });

  it('recepción registra un abono con Idempotency-Key en un plan listado y el saldo baja una sola vez', async () => {
    const key = '6f1d8f9e-3c1a-4b8e-9f2d-0a1b2c3d4e5f';
    const send = () =>
      as(clinicA, reception)
        .post(`/treatment-plans/${copPlan}/payments`, {
          amount: 100000,
          currency: 'COP',
          paidAt: '2026-10-01T00:00:00.000Z',
          method: 'TRANSFER',
        })
        .set('Idempotency-Key', key)
        .expect(201);
    const first = await send();
    const replay = await send();
    expect((replay.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );

    const res = await as(clinicA, reception)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(200);
    const cop = (res.body as BillablePlanBody[]).find((p) => p.id === copPlan);
    expect(cop).toMatchObject({ paid: 100000, balance: 400000 });
  });

  it('recepción crea el plan de cuotas de un plan listado y queda marcado', async () => {
    await as(clinicA, reception)
      .post(`/treatment-plans/${copPlan}/payment-plan`, {
        installmentsCount: 4,
        periodicity: 'MONTHLY',
        startDate: '2099-02-01T00:00:00.000Z',
        totalToFinance: 400000,
      })
      .expect(201);
    const res = await as(clinicA, reception)
      .get(`/patients/${patientId}/billable-plans`)
      .expect(200);
    const cop = (res.body as BillablePlanBody[]).find((p) => p.id === copPlan);
    expect(cop?.hasActivePaymentPlan).toBe(true);
  });
});
