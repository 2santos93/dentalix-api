import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { prismaRuleCode } from '../src/shared/prisma/prisma-exception.filter';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCreditRepository } from '../src/modules/patient-credit/infrastructure/prisma-patient-credit.repository';
import { TransferCreditUseCase } from '../src/modules/patient-credit/application/patient-credit.use-cases';
import { CREDIT_CHANGED_MESSAGE } from '../src/modules/patient-credit/domain/patient-credit';
import type {
  CreateTransferInput,
  PatientCreditRepository,
} from '../src/modules/patient-credit/domain/ports/patient-credit-repository.port';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import {
  CURRENCY_LOCKED_BY_CREDIT_CODE,
  CURRENCY_LOCKED_BY_CREDIT_MESSAGE,
  UpdateTreatmentPlanUseCase,
} from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-438 (DB-066): el saldo a favor vive en asientos en la moneda del plan, y
// todas las lecturas suman solo los de la moneda ACTUAL del plan. Un plan que
// recibió un traspaso (aunque no tenga abonos) no cambia de moneda: ni por la
// app (409 con código propio) ni en la BD (trigger
// `treatment_plans_credit_currency_locked`, restrict_violation). Y el traspaso
// revalida bajo el bloqueo que origen y destino siguen en su moneda.
// `raw` (DIRECT_URL, superusuario) siembra y limpia; lo que se prueba va como
// dentalix_app (runWithTenant, bajo RLS).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const credit = new PrismaPatientCreditRepository(prisma, tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const updatePlan = new UpdateTreatmentPlanUseCase(
  plans,
  { has: (code) => Promise.resolve(['COP', 'USD'].includes(code)) },
  () => new Date(),
);
const DIAGNOSTIC_SQL = readFileSync(
  join(__dirname, '../prisma/scripts/credit-currency-report.sql'),
  'utf8',
);

const SUBDOMAINS = ['dx438-int-a', 'dx438-int-b'];
const EMAIL = 'dx438-int@example.com';
const ADMIN = { role: ClinicRole.ADMIN };

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  /** Cancelado con un abono de 300.000 COP: todo es saldo a favor. */
  sourcePlan: string;
}

let a: Seeded;
let b: Seeded;
let userId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    const where = { tenantId: { in: ids } };
    // Superusuario: el trigger append-only deja la purga administrativa.
    await raw.patientCreditEntry.deleteMany({ where });
    await raw.patientCreditRefundPayment.deleteMany({ where });
    await raw.patientCreditRefund.deleteMany({ where });
    await raw.patientCreditTransfer.deleteMany({ where });
    await raw.patientCreditRefundCounter.deleteMany({ where });
    await raw.paymentReceipt.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.patientLedger.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

async function seed(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
      country: 'CO',
    }),
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: 'Moneda',
      docNumber: `${subdomain}-1`,
    },
  });
  const source = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  await raw.payment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      treatmentPlanId: source.id,
      patientId: patient.id,
      amount: 300_000,
      currency: 'COP',
      paidAt: new Date(),
      method: 'CASH',
    },
  });
  await raw.treatmentPlan.update({
    where: { id: source.id },
    data: { status: 'CANCELLED' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    sourcePlan: source.id,
  };
}

/** Un plan en borrador del paciente, sin abonos ni asientos. */
async function draftPlan(seeded: Seeded): Promise<string> {
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId: seeded.tenantId,
      patientId: seeded.patientId,
      currency: 'COP',
      status: 'DRAFT',
    },
  });
  return plan.id;
}

function asApp<T>(
  seeded: Seeded,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.runWithTenant(seeded.tenantId, fn);
}

function inContext<T>(seeded: Seeded, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(seeded.tenantId, seeded.locationId, fn);
}

async function sqlState(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return prismaRuleCode(error) ?? String(error);
  }
  throw new Error('la BD aceptó la escritura');
}

function transferInput(
  sourcePlanId: string,
  targetPlanId: string,
  amountCents: number,
): CreateTransferInput {
  return {
    sourcePlanId,
    targetPlanId,
    amountCents,
    currency: 'COP',
    reason: null,
    userId,
    fingerprint: 'f',
  };
}

async function movements(seeded: Seeded): Promise<[number, number]> {
  const where = { tenantId: seeded.tenantId };
  return Promise.all([
    raw.patientCreditTransfer.count({ where }),
    raw.patientCreditEntry.count({ where }),
  ]);
}

describe('DX-438 · saldo a favor y cambio de moneda del plan (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    userId = (
      await raw.user.create({
        data: { email: EMAIL, fullName: 'Admin', passwordHash: 'x' },
      })
    ).id;
    a = await seed(SUBDOMAINS[0]);
    b = await seed(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('traspaso a un plan DRAFT + PATCH de moneda → 409 con código propio, y el saldo del destino sigue visible', async () => {
    const target = await draftPlan(a);
    await inContext(a, () =>
      credit.createTransfer(transferInput(a.sourcePlan, target, 5_000_000)),
    );

    const error: unknown = await inContext(a, () =>
      updatePlan.execute(target, { currency: 'USD' }, ADMIN),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: CURRENCY_LOCKED_BY_CREDIT_CODE,
      message: CURRENCY_LOCKED_BY_CREDIT_MESSAGE,
    });

    const state = await inContext(a, () => credit.readPlanCredit(target));
    expect(state).toMatchObject({ currency: 'COP', entriesCents: 5_000_000 });
    expect(state?.creditCents).toBe(5_000_000);
    // El origen (TRANSFER_OUT) tampoco cambia de moneda.
    await expect(
      inContext(a, () =>
        updatePlan.execute(a.sourcePlan, { notes: 'Sin cambio' }, ADMIN),
      ),
    ).resolves.toMatchObject({ currency: 'COP', notes: 'Sin cambio' });
  });

  it('carrera: el destino cambia de moneda (confirmado) entre la lectura y el bloqueo del traspaso → 409 y no escribe nada', async () => {
    const target = await draftPlan(a);
    // Entre las lecturas del caso de uso y la transacción del repositorio,
    // otra petición confirma el cambio de moneda del destino (sin asientos
    // todavía, así que la app y la BD lo dejan pasar).
    const racing: PatientCreditRepository = Object.create(
      credit,
    ) as PatientCreditRepository;
    racing.createTransfer = async (input) => {
      await asApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plans" SET "currency" = 'USD' WHERE "id" = ${target}::uuid`,
      );
      return credit.createTransfer(input);
    };
    const before = await movements(a);

    const error: unknown = await inContext(a, () =>
      new TransferCreditUseCase(racing).execute(
        a.sourcePlan,
        { targetPlanId: target, amount: 10_000, currency: 'COP' },
        { role: ClinicRole.ADMIN, userId },
      ),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(CREDIT_CHANGED_MESSAGE);
    expect(await movements(a)).toEqual(before);
  });

  it('carrera real: traspaso y PATCH de moneda simultáneos sobre el mismo destino nunca dejan un asiento en otra moneda', async () => {
    const target = await draftPlan(a);
    const [transfer, patch] = await Promise.allSettled([
      inContext(a, () =>
        credit.createTransfer(transferInput(a.sourcePlan, target, 1_000_000)),
      ),
      inContext(a, () =>
        updatePlan.execute(target, { currency: 'USD' }, ADMIN),
      ),
    ]);
    // Exactamente uno de los dos gana.
    expect(
      [transfer.status, patch.status].filter((s) => s === 'fulfilled'),
    ).toHaveLength(1);
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: target },
    });
    const entries = await raw.patientCreditEntry.findMany({
      where: { tenantId: a.tenantId, treatmentPlanId: target },
    });
    if (transfer.status === 'fulfilled') {
      expect(plan.currency).toBe('COP');
      expect(entries.map((e) => e.currency)).toEqual(['COP']);
    } else {
      expect(plan.currency).toBe('USD');
      expect(entries).toEqual([]);
    }
  });

  it('devolución: bajo el bloqueo, un plan que ya no está en la moneda pedida es 409 CREDIT_CHANGED', async () => {
    const before = await movements(a);
    await expect(
      inContext(a, () =>
        credit.createRefund({
          planId: a.sourcePlan,
          amountCents: 100,
          currency: 'USD',
          method: 'TRANSFER',
          reason: 'Devolución pedida',
          paymentIds: [],
          userId,
          fingerprint: 'f',
        }),
      ),
    ).rejects.toThrow(new ConflictException(CREDIT_CHANGED_MESSAGE));
    expect(await movements(a)).toEqual(before);
  });

  describe('migración: trigger treatment_plans_credit_currency_locked', () => {
    let withEntries: string;
    let withoutEntries: string;

    beforeAll(async () => {
      withEntries = await draftPlan(a);
      withoutEntries = await draftPlan(a);
      await inContext(a, () =>
        credit.createTransfer(
          transferInput(a.sourcePlan, withEntries, 100_000),
        ),
      );
    });

    it('existe con search_path fijo y solo mira la columna currency', async () => {
      const [row] = await raw.$queryRaw<
        { tgtype: number; cols: string[]; config: string[] | null }[]
      >`
        SELECT t.tgtype::int AS "tgtype",
               ARRAY(SELECT a.attname::text FROM pg_attribute a
                      WHERE a.attrelid = t.tgrelid AND a.attnum = ANY(t.tgattr)) AS "cols",
               p.proconfig AS "config"
          FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE t.tgrelid = 'public.treatment_plans'::regclass
           AND t.tgname = 'treatment_plans_credit_currency_locked'`;
      expect(row.cols).toEqual(['currency']);
      // BEFORE (2) | ROW (1) | UPDATE (16).
      expect(row.tgtype & (1 | 2 | 16)).toBe(19);
      expect(row.config).toEqual(['search_path=pg_catalog, pg_temp']);
    });

    it('como dentalix_app rechaza el UPDATE de currency de un plan con asientos (destino y origen)', async () => {
      for (const id of [withEntries, a.sourcePlan]) {
        expect(
          await sqlState(
            asApp(
              a,
              (tx) =>
                tx.$executeRaw`UPDATE "treatment_plans" SET "currency" = 'USD' WHERE "id" = ${id}::uuid`,
            ),
          ),
        ).toBe('23001');
      }
      // Ni siquiera el superusuario (sin RLS ve los asientos).
      expect(
        await sqlState(
          raw.treatmentPlan.update({
            where: { id: withEntries },
            data: { currency: 'USD' },
          }),
        ),
      ).toBe('23001');
    });

    it('permite cambiar otras columnas, repetir la misma moneda y cambiar la de un plan sin asientos', async () => {
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`UPDATE "treatment_plans" SET "notes" = 'Notas', "currency" = 'COP' WHERE "id" = ${withEntries}::uuid`,
        ),
      ).resolves.toBe(1);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`UPDATE "treatment_plans" SET "status" = 'CANCELLED' WHERE "id" = ${withEntries}::uuid`,
        ),
      ).resolves.toBe(1);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`UPDATE "treatment_plans" SET "currency" = 'USD' WHERE "id" = ${withoutEntries}::uuid`,
        ),
      ).resolves.toBe(1);
    });

    it('los asientos de otra clínica no bloquean (filtra por tenantId)', async () => {
      const other = await draftPlan(b);
      await expect(
        asApp(
          b,
          (tx) =>
            tx.$executeRaw`UPDATE "treatment_plans" SET "currency" = 'USD' WHERE "id" = ${other}::uuid`,
        ),
      ).resolves.toBe(1);
    });
  });

  describe('diagnóstico prisma/scripts/credit-currency-report.sql (solo lectura, por clínica)', () => {
    it('como dentalix_app con la clínica fijada: 0 filas cuando todo cuadra', async () => {
      const rows = await asApp(a, (tx) =>
        tx.$queryRawUnsafe<unknown[]>(DIAGNOSTIC_SQL),
      );
      expect(rows).toEqual([]);
    });

    it('lista el asiento huérfano (moneda ≠ la de su plan) solo a su clínica', async () => {
      const plan = await draftPlan(b);
      const transfer = await inContext(b, () =>
        credit.createTransfer(transferInput(b.sourcePlan, plan, 100)),
      );
      // Un asiento en USD contra un plan en COP: lo que dejaba DB-066 antes
      // de las guardas. Solo el superusuario puede escribirlo ya así.
      await raw.patientCreditEntry.create({
        data: {
          tenantId: b.tenantId,
          patientId: b.patientId,
          treatmentPlanId: plan,
          currency: 'USD',
          amount: 1,
          kind: 'TRANSFER_IN',
          transferId: transfer.id,
        },
      });
      const seenByB = await asApp(b, (tx) =>
        tx.$queryRawUnsafe<
          {
            problem: string;
            tenantId: string;
            treatmentPlanId: string;
            entryCurrency: string;
            planCurrency: string;
          }[]
        >(DIAGNOSTIC_SQL),
      );
      expect(seenByB).toEqual([
        expect.objectContaining({
          problem: 'ENTRY_CURRENCY_MISMATCH',
          tenantId: b.tenantId,
          treatmentPlanId: plan,
          entryCurrency: 'USD',
          planCurrency: 'COP',
        }),
      ]);
      const seenByA = await asApp(a, (tx) =>
        tx.$queryRawUnsafe<unknown[]>(DIAGNOSTIC_SQL),
      );
      expect(seenByA).toEqual([]);
    });

    it('sin clínica fijada ni BYPASSRLS no da un falso «todo bien»', async () => {
      const rows =
        await prisma.$queryRawUnsafe<{ problem: string }[]>(DIAGNOSTIC_SQL);
      expect(rows.map((r) => r.problem)).toEqual(['NO_CLINIC_VISIBLE']);
    });
  });
});
