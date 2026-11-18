import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { sqlStateOf } from '../src/shared/prisma/prisma-exception.filter';
import { PrismaPaymentPlanRepository } from '../src/modules/payment-plans/infrastructure/repositories/prisma-payment-plan.repository';
import {
  acceptPlanInTx,
  cancelActivePaymentPlans,
  lockPlanGroup,
} from '../src/modules/treatment-plans/infrastructure/repositories/plan-option-group';
import { PERIOD_LOCKED_PLAN_STATUS_MESSAGE } from '../src/modules/financial-lock/domain/financial-lock';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-091 (revisión de seguridad): el cierre contable para los planes de
// cuotas. (1) El camino de los grupos de opciones / cambio de estado del plan
// de tratamiento (`cancelActivePaymentPlans`) ya no cancela un plan de cuotas
// con cuotas vencidas en un día cerrado (409 PERIOD_LOCKED). (2) La BD lo
// repite para `payment_plans` e `installments`, y la guarda de `payments` ya
// no deja cambiar el dinero de un abono cerrado ni borrarlo. Pasan la
// excepción registrada (GUC local), la fusión de pacientes y el superusuario.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const planRepo = new PrismaPaymentPlanRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx091-int-plans';
const CLOSED_DAY = '2026-09-15';
const OPEN_DAY = '2099-01-15';

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await owner.financialLockOverride.deleteMany({ where });
  await owner.installment.deleteMany({ where });
  await owner.paymentPlan.deleteMany({ where });
  await owner.paymentAllocation.deleteMany({ where });
  await owner.paymentAllocationMovement.deleteMany({ where });
  await owner.paymentPlanAmount.deleteMany({ where });
  await owner.paymentReceipt.deleteMany({ where });
  await owner.payment.deleteMany({ where });
  await owner.treatmentPlan.updateMany({
    where,
    data: { optionGroupId: null },
  });
  await owner.treatmentPlan.deleteMany({ where });
  await owner.patient.updateMany({ where, data: { mergedIntoId: null } });
  await owner.patient.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('DX-091 · cierre contable en planes de cuotas (int)', () => {
  let tenantId: string;
  let caracas: string;
  let patientId: string;

  const day = (civil: string) => new Date(`${civil}T00:00:00.000Z`);

  const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return fn(tx);
    });

  const stateOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (error) {
      return (
        sqlStateOf(error as Prisma.PrismaClientKnownRequestError) ??
        String(error)
      );
    }
  };

  /** Como la app: contexto de clínica y sede, y la transacción con RLS. */
  const inApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    tenantContext.run(tenantId, caracas, () => prisma.runWithTenant(fn));

  const treatmentPlan = async (
    data: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
    patient = patientId,
  ) =>
    (
      await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId: patient,
          currency: 'USD',
          status: 'PRESENTED',
          presentedAt: new Date('2026-08-01T15:00:00.000Z'),
          presentedLocationId: caracas,
          ...data,
        },
      })
    ).id;

  /** Plan de cuotas ACTIVO (como el dueño: los fixtures no pasan el cierre). */
  const paymentPlan = async (
    treatmentPlanId: string,
    dueDays: string[],
    patient = patientId,
  ) =>
    (
      await owner.paymentPlan.create({
        data: {
          tenantId,
          treatmentPlanId,
          patientId: patient,
          currency: 'USD',
          totalToFinance: 100 * dueDays.length,
          installmentsCount: dueDays.length,
          periodicity: 'MONTHLY',
          startDate: day(dueDays[0]),
          installments: {
            create: dueDays.map((d, i) => ({
              sequence: i + 1,
              dueDate: day(d),
              amount: 100,
            })),
          },
        },
      })
    ).id;

  const statusOf = async (paymentPlanId: string) =>
    (
      await owner.paymentPlan.findUniqueOrThrow({
        where: { id: paymentPlanId },
        select: { status: true },
      })
    ).status;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    tenantId = (
      await owner.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    caracas = (
      await owner.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Caracas',
          country: 'VE',
          timeZone: 'America/Caracas',
        }),
      })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Cuotas' },
      })
    ).id;
    await owner.tenant.update({
      where: { id: tenantId },
      data: { financialLockDate: day('2026-09-30') },
    });
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
    await appDb.$disconnect();
    await owner.$disconnect();
  });

  describe('grupo de opciones y cambio de estado del plan (cancelActivePaymentPlans)', () => {
    const optionGroup = async (siblingDueDays: string[]) => {
      const root = await treatmentPlan({ optionLabel: 'Opción A' });
      await owner.treatmentPlan.update({
        where: { id: root },
        data: { optionGroupId: root },
      });
      const sibling = await treatmentPlan({
        optionGroupId: root,
        optionLabel: 'Opción B',
      });
      const siblingPaymentPlan = await paymentPlan(sibling, siblingDueDays);
      return { root, sibling, siblingPaymentPlan };
    };

    const accept = (planId: string) =>
      inApp(async (tx) => {
        const locked = await lockPlanGroup(tx, planId);
        await acceptPlanInTx(tx, locked!, new Date(), null, caracas);
      });

    it('aceptar otra opción no cancela un plan de cuotas con cuotas vencidas en un día cerrado: 409 PERIOD_LOCKED y nada cambia', async () => {
      const { root, sibling, siblingPaymentPlan } = await optionGroup([
        CLOSED_DAY,
        OPEN_DAY,
      ]);
      await expect(accept(root)).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'PERIOD_LOCKED',
          lockedThrough: '2026-09-30',
          message: PERIOD_LOCKED_PLAN_STATUS_MESSAGE,
        }) as unknown,
      });
      expect(await statusOf(siblingPaymentPlan)).toBe('ACTIVE');
      const plans = await owner.treatmentPlan.findMany({
        where: { id: { in: [root, sibling] } },
        select: { id: true, status: true },
      });
      expect(plans.map((p) => p.status).sort()).toEqual([
        'PRESENTED',
        'PRESENTED',
      ]);
    });

    it('con cuotas solo después del cierre, aceptar otra opción cancela su plan de cuotas', async () => {
      const { root, siblingPaymentPlan } = await optionGroup([OPEN_DAY]);
      await accept(root);
      expect(await statusOf(siblingPaymentPlan)).toBe('CANCELLED');
    });

    it('cancelar o rechazar el plan de tratamiento: el mismo 409 (no hay excepción por este camino)', async () => {
      const plan = await treatmentPlan({ status: 'ACCEPTED' });
      const pp = await paymentPlan(plan, [CLOSED_DAY]);
      await expect(
        inApp(async (tx) => {
          await lockPlanGroup(tx, plan);
          await cancelActivePaymentPlans(tx, [plan], {
            at: new Date(),
            byId: null,
            reason: 'Cancelado por la clínica',
          });
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PERIOD_LOCKED' }) as unknown,
      });
      expect(await statusOf(pp)).toBe('ACTIVE');
    });
  });

  describe('red de la BD: payment_plans', () => {
    it('la app no cancela en SQL directo un plan de cuotas con una cuota en día cerrado (Q0910)', async () => {
      const pp = await paymentPlan(await treatmentPlan(), [CLOSED_DAY]);
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payment_plans" SET "status" = 'CANCELLED', "deletedAt" = now() WHERE "id" = ${pp}::uuid`,
          ),
        ),
      ).toBe('Q0910');
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payment_plans" SET "totalToFinance" = 1 WHERE "id" = ${pp}::uuid`,
          ),
        ),
      ).toBe('Q0910');
      // Las notas no son dinero.
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payment_plans" SET "notes" = 'nota' WHERE "id" = ${pp}::uuid`,
          ),
        ),
      ).toBe('ok');
      expect(await statusOf(pp)).toBe('ACTIVE');
    });

    it('la excepción registrada (GUC local con el id del plan de cuotas) deja pasar solo a ese plan', async () => {
      const pp = await paymentPlan(await treatmentPlan(), [CLOSED_DAY]);
      const other = await paymentPlan(await treatmentPlan(), [CLOSED_DAY]);
      expect(
        await stateOf(
          asApp(async (tx) => {
            await tx.$executeRaw`SELECT set_config('dentalix.financial_lock_override', ${pp}, true)`;
            await tx.$executeRaw`UPDATE "payment_plans" SET "status" = 'CANCELLED', "deletedAt" = now() WHERE "id" = ${other}::uuid`;
          }),
        ),
      ).toBe('Q0910');
      expect(
        await stateOf(
          asApp(async (tx) => {
            await tx.$executeRaw`SELECT set_config('dentalix.financial_lock_override', ${pp}, true)`;
            await tx.$executeRaw`UPDATE "payment_plans" SET "status" = 'CANCELLED', "deletedAt" = now() WHERE "id" = ${pp}::uuid`;
          }),
        ),
      ).toBe('ok');
    });

    it('cuotas solo futuras: se cancela sin problema', async () => {
      const pp = await paymentPlan(await treatmentPlan(), [OPEN_DAY]);
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payment_plans" SET "status" = 'CANCELLED', "deletedAt" = now() WHERE "id" = ${pp}::uuid`,
          ),
        ),
      ).toBe('ok');
    });

    it('el ADMIN con exención cancela y crea con motivo por el repositorio: la BD lo reconoce y queda el registro', async () => {
      await owner.tenant.update({
        where: { id: tenantId },
        data: { financialLockAdminExempt: true },
      });
      const admin = {
        userId: randomUUID(),
        role: ClinicRole.ADMIN,
        overrideReason: 'Plan migrado del sistema anterior',
      };
      try {
        const cancelPlan = await treatmentPlan({ status: 'ACCEPTED' });
        const pp = await paymentPlan(cancelPlan, [CLOSED_DAY]);
        await expect(
          tenantContext.run(tenantId, caracas, () =>
            planRepo.cancel(
              pp,
              {
                byId: admin.userId,
                at: new Date(),
                reason: 'Plan migrado del sistema anterior',
              },
              admin,
            ),
          ),
        ).resolves.toBe(true);
        expect(await statusOf(pp)).toBe('CANCELLED');

        const createPlan = await treatmentPlan({ status: 'ACCEPTED' });
        const created = await tenantContext.run(tenantId, caracas, () =>
          planRepo.create({
            treatmentPlanId: createPlan,
            patientId,
            currency: 'USD',
            totalToFinance: 200,
            downPayment: 0,
            installmentsCount: 2,
            periodicity: 'MONTHLY',
            startDate: day(CLOSED_DAY),
            installments: [
              { sequence: 1, dueDate: day(CLOSED_DAY), amount: 100 },
              { sequence: 2, dueDate: day(OPEN_DAY), amount: 100 },
            ],
            lockActor: admin,
          }),
        );
        const overrides = await owner.financialLockOverride.findMany({
          where: { tenantId, paymentPlanId: { in: [pp, created.id] } },
          select: { operation: true, paymentPlanId: true, reason: true },
        });
        expect(overrides).toEqual(
          expect.arrayContaining([
            {
              operation: 'PAYMENT_PLAN_CANCEL',
              paymentPlanId: pp,
              reason: admin.overrideReason,
            },
            {
              operation: 'PAYMENT_PLAN_CREATE',
              paymentPlanId: created.id,
              reason: admin.overrideReason,
            },
          ]),
        );
      } finally {
        await owner.tenant.update({
          where: { id: tenantId },
          data: { financialLockAdminExempt: false },
        });
      }
    });
  });

  describe('red de la BD: installments', () => {
    it('una cuota en día cerrado no nace, no cambia y no se borra; una futura no se mueve a un día cerrado', async () => {
      const pp = await paymentPlan(await treatmentPlan(), [
        CLOSED_DAY,
        OPEN_DAY,
      ]);
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`INSERT INTO "installments" ("id", "tenantId", "paymentPlanId", "sequence", "dueDate", "amount", "updatedAt")
                VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${pp}::uuid, 3, ${day('2026-09-20')}, 50, now())`,
          ),
        ),
      ).toBe('Q0910');
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "installments" SET "amount" = 1 WHERE "paymentPlanId" = ${pp}::uuid AND "sequence" = 1`,
          ),
        ),
      ).toBe('Q0910');
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "installments" SET "dueDate" = ${day('2026-09-01')} WHERE "paymentPlanId" = ${pp}::uuid AND "sequence" = 2`,
          ),
        ),
      ).toBe('Q0910');
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`DELETE FROM "installments" WHERE "paymentPlanId" = ${pp}::uuid AND "sequence" = 1`,
          ),
        ),
      ).not.toBe('ok');
      // Una cuota futura que sigue futura no es asunto del cierre.
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`INSERT INTO "installments" ("id", "tenantId", "paymentPlanId", "sequence", "dueDate", "amount", "updatedAt")
                VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${pp}::uuid, 3, ${day(OPEN_DAY)}, 50, now())`,
          ),
        ),
      ).toBe('ok');
      const rows = await owner.installment.findMany({
        where: { paymentPlanId: pp, sequence: { in: [1, 2] } },
        orderBy: { sequence: 'asc' },
        select: { amount: true, dueDate: true },
      });
      expect(
        rows.map((r) => [
          Number(r.amount),
          r.dueDate.toISOString().slice(0, 10),
        ]),
      ).toEqual([
        [100, CLOSED_DAY],
        [100, OPEN_DAY],
      ]);
    });
  });

  describe('red de la BD: payments (sin huecos)', () => {
    const payment = async (
      paidAt: string,
      patient = patientId,
      plan?: string,
    ) =>
      (
        await owner.payment.create({
          data: {
            tenantId,
            locationId: caracas,
            treatmentPlanId: plan ?? (await treatmentPlan({}, patient)),
            patientId: patient,
            amount: 100,
            currency: 'USD',
            paidAt: new Date(paidAt),
          },
        })
      ).id;

    it('un abono vigente de un día cerrado no cambia su dinero ni se borra; uno abierto no se mueve a un día cerrado', async () => {
      const closed = await payment('2026-09-20T16:00:00.000Z');
      const open = await payment('2099-01-20T16:00:00.000Z');
      for (const sql of [
        Prisma.sql`UPDATE "payments" SET "amount" = 1 WHERE "id" = ${closed}::uuid`,
        Prisma.sql`UPDATE "payments" SET "paidAt" = ${new Date('2026-10-05T16:00:00.000Z')} WHERE "id" = ${closed}::uuid`,
        Prisma.sql`UPDATE "payments" SET "paidAt" = ${new Date('2026-09-05T16:00:00.000Z')} WHERE "id" = ${open}::uuid`,
      ]) {
        expect(await stateOf(asApp((tx) => tx.$executeRaw(sql)))).toBe('Q0910');
      }
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`DELETE FROM "payments" WHERE "id" = ${closed}::uuid`,
          ),
        ),
      ).not.toBe('ok');
      // Un metadato sigue pudiéndose escribir.
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$executeRaw`UPDATE "payments" SET "notes" = 'nota' WHERE "id" = ${closed}::uuid`,
          ),
        ),
      ).toBe('ok');
      const row = await owner.payment.findUniqueOrThrow({
        where: { id: closed },
        select: { amount: true, paidAt: true, deletedAt: true },
      });
      expect(Number(row.amount)).toBe(100);
      expect(row.paidAt.toISOString()).toBe('2026-09-20T16:00:00.000Z');
      expect(row.deletedAt).toBeNull();
    });

    it('la fusión de pacientes (compuerta común) mueve abonos y planes de cuotas de días cerrados', async () => {
      const absorbed = (
        await owner.patient.create({
          data: { tenantId, firstName: 'Beto', lastName: 'Absorbido' },
        })
      ).id;
      const kept = (
        await owner.patient.create({
          data: { tenantId, firstName: 'Beto', lastName: 'Conservado' },
        })
      ).id;
      const plan = await treatmentPlan({ status: 'ACCEPTED' }, absorbed);
      const pp = await paymentPlan(plan, [CLOSED_DAY], absorbed);
      const pay = await payment('2026-09-20T16:00:00.000Z', absorbed, plan);
      const actor = randomUUID();
      expect(
        await stateOf(
          asApp(
            (tx) =>
              tx.$queryRaw`SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${actor}::uuid)`,
          ),
        ),
      ).toBe('ok');
      const [movedPlan, movedPayment] = await Promise.all([
        owner.paymentPlan.findUniqueOrThrow({
          where: { id: pp },
          select: { patientId: true, status: true },
        }),
        owner.payment.findUniqueOrThrow({
          where: { id: pay },
          select: { patientId: true, deletedAt: true },
        }),
      ]);
      expect(movedPlan).toEqual({ patientId: kept, status: 'ACTIVE' });
      expect(movedPayment).toEqual({ patientId: kept, deletedAt: null });
    });
  });
});
