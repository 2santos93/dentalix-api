import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import { PERIOD_LOCKED_MESSAGES } from '../src/modules/financial-lock/domain/financial-lock';
import {
  INSTALLMENT_SIMULATION_STALE,
  INSTALLMENT_SIMULATION_STALE_MESSAGE,
  INSTALLMENTS_WITH_PARTIAL_MESSAGE,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { toCents } from '../src/shared/money/money';

// DX-041: «Financiar» del presupuesto. Simular (sin escribir), aceptar con un
// escenario (el plan de cuotas en la MISMA transacción) y la igualdad
// simulación = plan de cuotas guardado, contra Postgres.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SIGNATURE = `data:image/png;base64,${PNG}`;

interface Installment {
  sequence: number;
  dueDate: string;
  amount: number;
}
interface Scenario {
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: string;
  startDate: string;
  installments: Installment[];
}
interface Simulation {
  treatmentPlanId: string;
  currency: string;
  totalToFinance: number;
  scenarios: Scenario[];
}
interface PaymentPlanBody {
  id: string;
  currency: string;
  totalToFinance: number;
  downPayment: number;
  installments: Installment[];
}

const idOf = (res: request.Response): string => (res.body as { id: string }).id;

describe('Opciones de pago en cuotas del presupuesto (DX-041, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let dentist: string;
  let assistant: string;
  let reception: string;
  let patient: string;
  let catalog: string;
  // El día de la sede al cargar el spec: las fechas van a ±10 días o más de
  // él, lejos de cualquier medianoche.
  const today = fixedSedeDay(0).day;
  const start = addCivilDays(today, 30);

  const call = (
    token: string,
    verb: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  /** Un plan en VES con dos procedimientos (sin tasas de por medio). */
  async function plan(prices: [number, number] = [1250.5, 999.99]) {
    const id = idOf(
      await call(dentist, 'post', `/patients/${patient}/treatment-plans`, {
        currency: 'VES',
      }).expect(201),
    );
    for (const [i, price] of prices.entries()) {
      await call(dentist, 'post', `/treatment-plans/${id}/items`, {
        toothNumber: i === 0 ? '36' : '46',
        catalogItemId: catalog,
        price,
        discountReason: 'PROMOTION',
      }).expect(201);
    }
    await call(dentist, 'post', `/treatment-plans/${id}/present`, {}).expect(
      200,
    );
    return id;
  }

  const simulate = (token: string, planId: string, scenarios: object[]) =>
    call(token, 'post', `/treatment-plans/${planId}/installment-simulation`, {
      scenarios,
    });

  async function contentHash(planId: string): Promise<string> {
    const res = await call(
      dentist,
      'get',
      `/patients/${patient}/treatment-plans/${planId}/quote`,
    ).expect(200);
    return (res.body as { contentHash: string }).contentHash;
  }

  /** Firma el presupuesto (con `extra`) y comprueba el estado. */
  async function accept(
    planId: string,
    extra: object,
    status: number,
  ): Promise<request.Response> {
    const hash = await contentHash(planId);
    return call(
      dentist,
      'post',
      `/patients/${patient}/treatment-plans/${planId}/acceptance`,
      {
        signerName: 'Valentina Ortodoncia',
        signature: SIGNATURE,
        contentHash: hash,
        ...extra,
      },
    ).expect(status);
  }

  /** Lo que importa de un plan de cuotas: importes y días, en orden. */
  const shape = (installments: Installment[]) =>
    installments.map((i) => ({
      sequence: i.sequence,
      day: i.dueDate.slice(0, 10),
      amount: i.amount,
    }));

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'cuotas-presupuesto-a');
    dentist = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    patient = idOf(
      await call(a.adminToken, 'post', '/patients', {
        firstName: 'Valentina',
        lastName: 'Cuotas',
        docType: 'NATIONAL_ID',
        docNumber: '41000001',
        sex: 'F',
      }).expect(201),
    );
    catalog = idOf(
      await call(a.adminToken, 'post', '/catalog/items', {
        code: 'CUOTAS-IMP',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Implante',
        color: '#336699',
        defaultPrice: 1000,
      }).expect(201),
    );
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('POST /treatment-plans/:id/installment-simulation', () => {
    it('hasta 3 escenarios en la moneda del plan; la inicial más las cuotas suman el saldo y el redondeo va en la última', async () => {
      const planId = await plan();
      const res = await simulate(dentist, planId, [
        {
          downPayment: 250.49,
          installmentsCount: 3,
          periodicity: 'MONTHLY',
          startDate: start,
        },
        { installmentsCount: 6, periodicity: 'BIWEEKLY', startDate: start },
        { installmentsCount: 12, periodicity: 'WEEKLY', startDate: start },
      ]).expect(200);
      const body = res.body as Simulation;
      expect(body).toMatchObject({
        treatmentPlanId: planId,
        currency: 'VES',
        totalToFinance: 2250.49,
      });
      expect(body.scenarios).toHaveLength(3);
      for (const s of body.scenarios) {
        const cents =
          s.installments.reduce((sum, i) => sum + toCents(i.amount), 0) +
          toCents(s.downPayment);
        expect(cents).toBe(toCents(2250.49));
        const first = s.installments[0].amount;
        expect(
          s.installments.slice(0, -1).every((i) => i.amount === first),
        ).toBe(true);
      }
      expect(shape(body.scenarios[0].installments)).toEqual([
        { sequence: 1, day: start, amount: 666.66 },
        {
          sequence: 2,
          day: expect.any(String) as string,
          amount: 666.66,
        },
        {
          sequence: 3,
          day: expect.any(String) as string,
          amount: 666.68,
        },
      ]);
    });

    it('simular no escribe en la base: ni planes de cuotas ni cambios en el plan (solo el evento VIEW de la auditoría)', async () => {
      const planId = await plan();
      const before = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        include: { items: true },
      });
      const counts = async () => ({
        plans: await raw.paymentPlan.count(),
        installments: await raw.installment.count(),
        acceptances: await raw.treatmentPlanAcceptance.count(),
        items: await raw.treatmentPlanItem.count(),
        treatmentPlans: await raw.treatmentPlan.count(),
        audit: await raw.auditEvent.count({
          where: { tenantId: a.tenantId, NOT: { action: 'VIEW' } },
        }),
      });
      const countsBefore = await counts();
      for (const token of [dentist, assistant, reception, a.adminToken]) {
        await simulate(token, planId, [
          { installmentsCount: 4, periodicity: 'MONTHLY', startDate: start },
        ]).expect(200);
      }
      expect(await counts()).toEqual(countsBefore);
      expect(
        await raw.treatmentPlan.findUniqueOrThrow({
          where: { id: planId },
          include: { items: true },
        }),
      ).toEqual(before);
      const views = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: planId,
          action: 'VIEW',
          resourceType: 'TREATMENT_PLAN',
        },
        select: { metadata: true },
      });
      expect(
        views.filter(
          (v) =>
            (v.metadata as { reason?: string } | null)?.reason ===
            'INSTALLMENT_SIMULATION',
        ),
      ).toHaveLength(4);
    });

    it('400 en español: más de 3 escenarios, cuotas fuera de rango, inicial mayor que el saldo, id que no es UUID', async () => {
      const planId = await plan();
      const one = {
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: start,
      };
      const four = await simulate(dentist, planId, [one, one, one, one]).expect(
        400,
      );
      expect(JSON.stringify(four.body)).toContain(
        'Simula como mucho 3 escenarios.',
      );
      const zero = await simulate(dentist, planId, [
        { ...one, installmentsCount: 0 },
      ]).expect(400);
      expect(JSON.stringify(zero.body)).toContain(
        'El número de cuotas debe estar entre 1 y 600.',
      );
      await simulate(dentist, planId, [{ ...one, downPayment: 2250.5 }]).expect(
        400,
      );
      await simulate(dentist, 'no-es-uuid', [one]).expect(400);
    });
  });

  describe('POST …/acceptance con installmentPlan', () => {
    it('crea el plan de cuotas en la aceptación con exactamente las cuotas y fechas simuladas (igualdad contra la base)', async () => {
      const planId = await plan();
      const terms = {
        downPayment: 400,
        installmentsCount: 7,
        periodicity: 'MONTHLY',
        startDate: addCivilDays(today, 45),
      };
      const sim = (await simulate(dentist, planId, [terms]).expect(200))
        .body as Simulation;
      const res = await accept(
        planId,
        {
          installmentPlan: { ...terms, totalToFinance: sim.totalToFinance },
        },
        201,
      );
      const { paymentPlanId, planStatus } = res.body as {
        paymentPlanId: string;
        planStatus: string;
      };
      expect(planStatus).toBe('ACCEPTED');
      expect(paymentPlanId).toEqual(expect.any(String));

      const stored = (
        await call(
          reception,
          'get',
          `/treatment-plans/${planId}/payment-plan`,
        ).expect(200)
      ).body as PaymentPlanBody;
      expect(stored.id).toBe(paymentPlanId);
      expect(stored).toMatchObject({
        currency: 'VES',
        totalToFinance: sim.scenarios[0].totalToFinance,
        downPayment: 400,
      });
      expect(shape(stored.installments)).toEqual(
        shape(sim.scenarios[0].installments),
      );
      // Las filas, tal cual.
      const rows = await raw.installment.findMany({
        where: { paymentPlanId },
        orderBy: { sequence: 'asc' },
      });
      expect(
        rows.map((r) => ({
          sequence: r.sequence,
          dueDate: r.dueDate.toISOString(),
          amount: r.amount.toNumber(),
        })),
      ).toEqual(sim.scenarios[0].installments);

      // La auditoría: SIGN con el plan de cuotas y su propio CREATE.
      const sign = await raw.auditEvent.findFirstOrThrow({
        where: { tenantId: a.tenantId, resourceId: planId, action: 'SIGN' },
      });
      expect(sign.metadata).toMatchObject({
        reason: 'PLAN_ACCEPTED_WITH_INSTALLMENTS',
        params: { paymentPlanId },
      });
      const created = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceId: paymentPlanId,
          action: 'CREATE',
          resourceType: 'PAYMENT_PLAN',
        },
      });
      expect(created.metadata).toMatchObject({
        reason: 'PLAN_ACCEPTED_WITH_INSTALLMENTS',
        params: { treatmentPlanId: planId },
      });
      // Ya financiado: simular otra vez es 409.
      await simulate(dentist, planId, [terms]).expect(409);
    });

    it('la simulación de un plan aceptado coincide con POST …/payment-plan con los mismos datos', async () => {
      const planId = await plan([1000, 1333.33]);
      await accept(planId, {}, 201);
      const terms = {
        downPayment: 0.01,
        installmentsCount: 9,
        periodicity: 'BIWEEKLY',
        startDate: addCivilDays(today, 10),
      };
      const sim = (await simulate(reception, planId, [terms]).expect(200))
        .body as Simulation;
      const created = (
        await call(
          reception,
          'post',
          `/treatment-plans/${planId}/payment-plan`,
          terms,
        ).expect(201)
      ).body as PaymentPlanBody;
      expect(created.totalToFinance).toBe(sim.totalToFinance);
      expect(shape(created.installments)).toEqual(
        shape(sim.scenarios[0].installments),
      );
    });

    it('saldo distinto del simulado: 409 INSTALLMENT_SIMULATION_STALE y no se acepta nada', async () => {
      const planId = await plan();
      const res = await accept(
        planId,
        {
          installmentPlan: {
            installmentsCount: 3,
            periodicity: 'MONTHLY',
            startDate: start,
            totalToFinance: 2250.48,
          },
        },
        409,
      );
      expect(res.body).toMatchObject({
        code: INSTALLMENT_SIMULATION_STALE,
        message: INSTALLMENT_SIMULATION_STALE_MESSAGE,
      });
      const after = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { status: true },
      });
      expect(after.status).toBe('PRESENTED');
      expect(
        await raw.treatmentPlanAcceptance.count({ where: { planId } }),
      ).toBe(0);
      expect(
        await raw.paymentPlan.count({ where: { treatmentPlanId: planId } }),
      ).toBe(0);
    });

    it('con partial: 400; recepción no acepta (403)', async () => {
      const planId = await plan();
      const items = await raw.treatmentPlanItem.findMany({
        where: { planId },
        select: { id: true },
      });
      const res = await accept(
        planId,
        {
          partial: { itemIds: [items[0].id] },
          installmentPlan: {
            installmentsCount: 3,
            periodicity: 'MONTHLY',
            startDate: start,
            totalToFinance: 2250.49,
          },
        },
        400,
      );
      expect((res.body as { message: string }).message).toBe(
        INSTALLMENTS_WITH_PARTIAL_MESSAGE,
      );
      await call(
        reception,
        'post',
        `/patients/${patient}/treatment-plans/${planId}/acceptance`,
        {
          signerName: 'X',
          signature: SIGNATURE,
          contentHash: await contentHash(planId),
          installmentPlan: {
            installmentsCount: 3,
            periodicity: 'MONTHLY',
            startDate: start,
            totalToFinance: 2250.49,
          },
        },
      ).expect(403);
    });

    it('DX-091: una cuota en un período cerrado da 409 PERIOD_LOCKED y deshace también la aceptación', async () => {
      const planId = await plan();
      const lockDate = addCivilDays(today, -10);
      await call(a.adminToken, 'patch', '/clinic/settings/financial-lock', {
        lockDate,
      }).expect(200);
      try {
        const res = await accept(
          planId,
          {
            installmentPlan: {
              installmentsCount: 3,
              periodicity: 'MONTHLY',
              startDate: addCivilDays(today, -40),
              totalToFinance: 2250.49,
            },
          },
          409,
        );
        expect(res.body).toMatchObject({
          code: 'PERIOD_LOCKED',
          message: PERIOD_LOCKED_MESSAGES.PAYMENT_PLAN_CREATE,
        });
        // Misma transacción: ni firma, ni plan aceptado, ni plan de cuotas.
        expect(
          await raw.treatmentPlanAcceptance.count({ where: { planId } }),
        ).toBe(0);
        expect(
          (
            await raw.treatmentPlan.findUniqueOrThrow({
              where: { id: planId },
              select: { status: true },
            })
          ).status,
        ).toBe('PRESENTED');
        expect(
          await raw.treatmentPlanItem.count({
            where: { planId, status: 'ACCEPTED' },
          }),
        ).toBe(0);
        expect(
          await raw.paymentPlan.count({ where: { treatmentPlanId: planId } }),
        ).toBe(0);
        // Con las cuotas después del cierre, sí.
        await accept(
          planId,
          {
            installmentPlan: {
              installmentsCount: 3,
              periodicity: 'MONTHLY',
              startDate: start,
              totalToFinance: 2250.49,
            },
          },
          201,
        );
      } finally {
        await call(a.adminToken, 'patch', '/clinic/settings/financial-lock', {
          lockDate: null,
        }).expect(200);
      }
    });

    it('DX-285: un caso de ortodoncia ligado al plan aceptado con cuotas solo las informa (sin cargos)', async () => {
      await call(a.adminToken, 'put', '/ortho/settings', {
        enabled: true,
      }).expect(200);
      const planId = await plan();
      const caseId = idOf(
        await call(dentist, 'post', `/patients/${patient}/ortho-cases`, {
          technique: 'ALIGNERS',
          startDate: today,
          estimatedMonths: 12,
          plannedVisits: 12,
          treatmentPlanId: planId,
        }).expect(201),
      );
      await call(
        dentist,
        'put',
        `/patients/${patient}/ortho-cases/${caseId}/fee`,
        {
          total: 2250.49,
          initial: 450.49,
          perVisit: 150,
          visitCount: 12,
          retention: 0,
        },
      ).expect(200);
      const accepted = await accept(
        planId,
        {
          installmentPlan: {
            installmentsCount: 12,
            periodicity: 'MONTHLY',
            startDate: start,
            totalToFinance: 2250.49,
          },
        },
        201,
      );
      const { paymentPlanId } = accepted.body as { paymentPlanId: string };
      const itemsBefore = await raw.treatmentPlanItem.count({
        where: { planId },
      });
      const fee = await call(
        dentist,
        'post',
        `/patients/${patient}/ortho-cases/${caseId}/fee/accept`,
      ).expect(200);
      expect(fee.body).toMatchObject({ treatmentPlanId: planId });
      expect(await raw.treatmentPlanItem.count({ where: { planId } })).toBe(
        itemsBefore,
      );
      expect(await raw.orthoCaseCharge.count({ where: { caseId } })).toBe(0);
      const stored = await raw.orthoCase.findUniqueOrThrow({
        where: { id: caseId },
        select: { feePaymentPlanId: true },
      });
      expect(stored.feePaymentPlanId).toBe(paymentPlanId);
    });
  });
});
