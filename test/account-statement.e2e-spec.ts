import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros con rol y para
// limpiar entre tenants — mismo criterio que payment-plans.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const PLAN_NOTE = 'Nota clínica que no debe salir en el estado de cuenta';

interface Session {
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}

interface StatementBody {
  issuedAt: string;
  clinic: { name: string; logoUrl: string | null };
  patient: { id: string; firstName: string; docNumber: string | null };
  range: { from: string | null; to: string | null };
  summary: {
    currency: string;
    budgeted: number;
    paid: number;
    balance: number;
    overdueCount: number;
    overdueAmount: number;
    nextInstallment: {
      dueDate: string;
      amount: number;
      sequence: number | null;
    } | null;
  }[];
  plans: {
    id: string;
    status: string;
    currency: string;
    budgeted: number;
    countsTowardsBalance: boolean;
    paid: number;
    balance: number;
  }[];
  movements: {
    id: string;
    amount: number;
    currency: string;
    voided: boolean;
    voidedBy: { id: string; fullName: string | null } | null;
    voidReason: string | null;
    location: { id: string; name: string };
    treatmentPlanId: string;
  }[];
  installments: {
    treatmentPlanId: string;
    sequence: number | null;
    status: string;
    outstanding: number;
  }[];
}

async function cleanup(): Promise<void> {
  await raw.toothRecord.deleteMany();
  await raw.appointment.deleteMany();
  await raw.payment.deleteMany();
  await raw.installment.deleteMany();
  await raw.paymentPlan.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.patient.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Estado de cuenta — GET /patients/:patientId/account-statement (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let patientId: string;
  let emptyPatientId: string;
  let catalogItemId: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    return {
      get: (path: string) =>
        request(server())
          .get(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`),
      post: (path: string, body: object) =>
        request(server())
          .post(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      patch: (path: string, body: object) =>
        request(server())
          .patch(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`)
          .send(body),
      delete: (path: string, body: object = {}) =>
        request(server())
          .delete(`/api/v1${path}`)
          .set('X-Tenant-Host', hostFor(session.subdomain))
          .set('Authorization', `Bearer ${token}`)
          .send(body),
    };
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await request(server())
      .post('/api/v1/auth/register')
      .send({
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dr. Owner',
      })
      .expect(201);
    const accessToken = await login(subdomain, email);
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      userId: (reg.body as { userId: string }).userId,
      accessToken,
      subdomain,
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
        firstName: 'Ana',
        lastName: 'Saldo',
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
        toothNumber: '11',
        catalogItemId,
        price,
      })
      .expect(201);
    if (accept) {
      await as(clinicA)
        .patch(
          `/treatment-plans/${planId}/items/${(item.body as { id: string }).id}`,
          {
            status: 'ACCEPTED',
          },
        )
        .expect(200);
    }
    return planId;
  }

  async function pay(
    planId: string,
    amount: number,
    currency: string,
    paidAt: string,
  ): Promise<string> {
    const res = await as(clinicA)
      .post(`/treatment-plans/${planId}/payments`, {
        amount,
        currency,
        paidAt,
        method: 'CASH',
        notes: PLAN_NOTE,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  // Planes del paciente (ver los totales esperados en cada test):
  //   usdPlan       USD 1000 ACCEPTED · abonos 300 + 100 (anulado) · cuotas 3
  //                 mensuales desde 2026-01-10 (todas vencidas)
  //   futurePlan    USD 200 · cuotas 2 desde 2099-01-01 (próxima cuota)
  //   copPlan       COP 500000 · abono 200000
  //   cancelledPlan USD 500 · abono 50 · luego CANCELLED
  //   draftPlan     USD 999 PROPOSED (no facturable)
  let usdPlan: string;
  let futurePlan: string;
  let copPlan: string;
  let cancelledPlan: string;
  let voidedPaymentId: string;

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

    clinicA = await register('estado-cuenta-a');
    clinicB = await register('estado-cuenta-b');
    patientId = await createPatient(clinicA, 'EC-A-001');
    emptyPatientId = await createPatient(clinicA, 'EC-A-002');

    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'EC-RESINA',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    usdPlan = await createPlan('USD', 1000);
    await pay(usdPlan, 300, 'USD', '2026-07-01T00:00:00.000Z');
    voidedPaymentId = await pay(
      usdPlan,
      100,
      'USD',
      '2026-07-02T00:00:00.000Z',
    );
    await as(clinicA)
      .delete(`/payments/${voidedPaymentId}`, { reason: 'Cobro duplicado' })
      .expect(200);
    await as(clinicA)
      .post(`/treatment-plans/${usdPlan}/payment-plan`, {
        installmentsCount: 3,
        periodicity: 'MONTHLY',
        startDate: '2026-01-10T00:00:00.000Z',
        totalToFinance: 700,
      })
      .expect(201);

    futurePlan = await createPlan('USD', 200);
    await as(clinicA)
      .post(`/treatment-plans/${futurePlan}/payment-plan`, {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: '2099-01-01T00:00:00.000Z',
      })
      .expect(201);

    copPlan = await createPlan('COP', 500000);
    await pay(copPlan, 200000, 'COP', '2026-08-01T00:00:00.000Z');

    cancelledPlan = await createPlan('USD', 500);
    await pay(cancelledPlan, 50, 'USD', '2026-06-01T00:00:00.000Z');
    await as(clinicA)
      .patch(`/treatment-plans/${cancelledPlan}`, { status: 'CANCELLED' })
      .expect(200);

    await createPlan('USD', 999, false);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('cuadra presupuestado, abonado, saldo y cuotas por moneda', async () => {
    const res = await as(clinicA)
      .get(`/patients/${patientId}/account-statement`)
      .expect(200);
    const body = res.body as StatementBody;

    expect(body.clinic.name).toBe('Clinica estado-cuenta-a');
    expect(body.patient).toMatchObject({
      id: patientId,
      docNumber: 'EC-A-001',
    });
    expect(body.range).toEqual({ from: null, to: null });

    expect(body.summary).toEqual([
      {
        currency: 'COP',
        budgeted: 500000,
        paid: 200000,
        balance: 300000,
        overdueCount: 0,
        overdueAmount: 0,
        nextInstallment: null,
      },
      {
        currency: 'USD',
        // 1000 + 200; el cancelado (500) y el borrador (PROPOSED) no suman.
        budgeted: 1200,
        // 300 + 50 del cancelado; el anulado (100) no suma.
        paid: 350,
        balance: 850,
        // 700 en 3 cuotas (233.33/233.33/233.34) con 300 abonados: la 1 pagada,
        // la 2 con 166.66 pendiente y la 3 entera.
        overdueCount: 2,
        overdueAmount: 400,
        nextInstallment: {
          treatmentPlanId: futurePlan,
          sequence: 1,
          dueDate: '2099-01-01T00:00:00.000Z',
          amount: 100,
        },
      },
    ]);

    // Cada plan cuadra con sus propios abonos.
    const byId = new Map(body.plans.map((p) => [p.id, p]));
    expect(body.plans).toHaveLength(5);
    expect(byId.get(usdPlan)).toMatchObject({
      budgeted: 1000,
      paid: 300,
      balance: 700,
    });
    expect(byId.get(copPlan)).toMatchObject({
      budgeted: 500000,
      paid: 200000,
      balance: 300000,
    });
    expect(byId.get(cancelledPlan)).toMatchObject({
      status: 'CANCELLED',
      countsTowardsBalance: false,
      paid: 50,
      balance: -50,
    });

    // La suma de los saldos por plan es el saldo de la moneda.
    const usdBalance = body.plans
      .filter((p) => p.currency === 'USD')
      .reduce((s, p) => s + p.balance, 0);
    expect(Math.round(usdBalance * 100) / 100).toBe(850);

    // Movimientos: los 4 abonos, el anulado marcado, con su sede.
    expect(body.movements).toHaveLength(4);
    const voided = body.movements.find((m) => m.id === voidedPaymentId);
    expect(voided).toMatchObject({
      voided: true,
      amount: 100,
      voidedBy: { id: clinicA.userId, fullName: 'Dr. Owner' },
      voidReason: 'Cobro duplicado',
    });
    const active = body.movements.filter((m) => !m.voided);
    expect(
      active.every((m) => m.voidedBy === null && m.voidReason === null),
    ).toBe(true);
    expect(body.movements.every((m) => m.location.name.length > 0)).toBe(true);

    // Cuotas: 3 vencidas/pagada del plan USD + 2 pendientes del futuro.
    expect(
      body.installments
        .filter((i) => i.treatmentPlanId === usdPlan)
        .map((i) => [i.sequence, i.status, i.outstanding]),
    ).toEqual([
      [1, 'PAID', 0],
      [2, 'OVERDUE', 166.66],
      [3, 'OVERDUE', 233.34],
    ]);
    expect(
      body.installments
        .filter((i) => i.treatmentPlanId === futurePlan)
        .map((i) => i.status),
    ).toEqual(['PENDING', 'PENDING']);

    // Sin datos clínicos: ni notas, ni dientes, ni ítems.
    const text = JSON.stringify(body);
    expect(text).not.toContain(PLAN_NOTE);
    expect(text).not.toContain('toothNumber');
    expect(text).not.toContain('catalogItemId');
  });

  it('filtra solo los movimientos por rango, sin tocar los totales', async () => {
    const res = await as(clinicA)
      .get(
        `/patients/${patientId}/account-statement?from=2026-07-01&to=2026-07-31`,
      )
      .expect(200);
    const body = res.body as StatementBody;
    expect(body.range).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(body.movements.map((m) => m.amount).sort((a, b) => a - b)).toEqual([
      100, 300,
    ]);
    expect(body.summary.find((s) => s.currency === 'USD')?.paid).toBe(350);
  });

  it('devuelve un estado vacío para un paciente sin planes ni abonos', async () => {
    const res = await as(clinicA)
      .get(`/patients/${emptyPatientId}/account-statement`)
      .expect(200);
    const body = res.body as StatementBody;
    expect(body.summary).toEqual([]);
    expect(body.plans).toEqual([]);
    expect(body.movements).toEqual([]);
    expect(body.installments).toEqual([]);
  });

  it('aísla por clínica: otra clínica recibe 404, igual que un UUID inexistente', async () => {
    await as(clinicB)
      .get(`/patients/${patientId}/account-statement`)
      .expect(404);
    await as(clinicA)
      .get('/patients/00000000-0000-4000-8000-000000000000/account-statement')
      .expect(404);
  });

  it('aplica PAYMENT_ROLES: recepción lee, dentista y asistente reciben 403', async () => {
    const reception = await memberToken(clinicA, ClinicRole.RECEPTION);
    const dentist = await memberToken(clinicA, ClinicRole.DENTIST);
    const assistant = await memberToken(clinicA, ClinicRole.ASSISTANT);

    await as(clinicA, reception)
      .get(`/patients/${patientId}/account-statement`)
      .expect(200);
    await as(clinicA, dentist)
      .get(`/patients/${patientId}/account-statement`)
      .expect(403);
    await as(clinicA, assistant)
      .get(`/patients/${patientId}/account-statement`)
      .expect(403);
    await request(server())
      .get(`/api/v1/patients/${patientId}/account-statement`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(401);
  });

  it('valida el UUID y el rango', async () => {
    await as(clinicA).get('/patients/no-es-uuid/account-statement').expect(400);
    await as(clinicA)
      .get(`/patients/${patientId}/account-statement?from=2026-02-30`)
      .expect(400);
    await as(clinicA)
      .get(
        `/patients/${patientId}/account-statement?from=2026-03-02&to=2026-03-01`,
      )
      .expect(400);
    await as(clinicA)
      .get(`/patients/${patientId}/account-statement?from=ayer`)
      .expect(400);
  });
});
