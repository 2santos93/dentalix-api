import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanQuoteRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import { IssuePlanQuoteUseCase } from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { FixedDocumentTypeNamesReader } from '../src/modules/document-type-names/__fixtures__/fixed-document-type-names.reader';
import { resetDatabase } from './support/e2e-fixtures';
import { holdLock, waitForLockWaiters } from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-379 (M-2, M-7) contra Postgres: la primera impresión guarda UNA validez
// aunque dos lleguen a la vez (cada una con su reloj), y una reimpresión que no
// escribe no toma el bloqueo del plan.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPlanQuoteRepository(prisma, tenantContext);
const names = new FixedDocumentTypeNamesReader();

// 9 nov 2026, 11:00 en Caracas, y cuatro días después.
const DAY1 = new Date('2026-11-09T15:00:00.000Z');
const DAY5 = new Date('2026-11-13T15:00:00.000Z');
const issueAt = (at: Date) => new IssuePlanQuoteUseCase(repo, () => at, names);

let tenantId: string;
let patientId: string;
let catalogItemId: string;

async function draftPlan(): Promise<string> {
  const plan = await owner.treatmentPlan.create({
    data: { tenantId, patientId, currency: 'VES' },
    select: { id: true },
  });
  await owner.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: plan.id,
      toothNumber: '36',
      catalogItemId,
      price: 450,
      discount: 0,
    },
  });
  return plan.id;
}

const holdPlan = (planId: string) =>
  holdLock(
    owner,
    (tx) =>
      tx.$queryRaw`SELECT 1 FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`,
  );

async function storedValidity(planId: string) {
  const plan = await owner.treatmentPlan.findUniqueOrThrow({
    where: { id: planId },
    select: { quoteIssuedOn: true, quoteValidUntil: true },
  });
  return {
    issuedOn: plan.quoteIssuedOn?.toISOString().slice(0, 10) ?? null,
    validUntil: plan.quoteValidUntil?.toISOString().slice(0, 10) ?? null,
  };
}

describe('primera impresión del presupuesto en Postgres (DX-379)', () => {
  beforeAll(async () => {
    await resetDatabase(owner);
    const tenant = await owner.tenant.create({
      data: {
        name: 'dx379-int',
        subdomain: 'dx379-int',
        quoteValidityDays: 15,
      },
    });
    tenantId = tenant.id;
    await owner.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name: 'Sede principal',
      }),
    });
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Validez' },
        select: { id: true },
      })
    ).id;
    catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'c-dx379',
          kind: 'PROCEDURE',
          labelEs: 'Corona',
          color: '#123456',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('dos primeras impresiones a la vez (días distintos) guardan UNA validez y las dos devuelven esa', async () => {
    const planId = await draftPlan();
    // Las dos leen sin bloquear, deciden que hay que guardar y esperan el
    // bloqueo del plan, que retiene el test hasta que estén las dos.
    const held = await holdPlan(planId);
    const first = tenantContext.run(tenantId, () =>
      issueAt(DAY1).execute(patientId, planId),
    );
    const second = tenantContext.run(tenantId, () =>
      issueAt(DAY5).execute(patientId, planId),
    );
    await waitForLockWaiters(owner, [held.pid], 2);
    held.release();
    await held.done;
    const [a, b] = await Promise.all([first, second]);

    const stored = await storedValidity(planId);
    expect([
      { issuedOn: '2026-11-09', validUntil: '2026-11-24' },
      { issuedOn: '2026-11-13', validUntil: '2026-11-28' },
    ]).toContainEqual(stored);
    for (const doc of [a, b]) {
      expect({ issuedOn: doc.issuedOn, validUntil: doc.validUntil }).toEqual(
        stored,
      );
    }
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('M-2: reimprimir un plan que ya tiene fechas no espera el bloqueo del plan', async () => {
    const planId = await draftPlan();
    await tenantContext.run(tenantId, () =>
      issueAt(DAY1).execute(patientId, planId),
    );
    const held = await holdPlan(planId);
    try {
      const again = await tenantContext.run(tenantId, () =>
        issueAt(DAY5).execute(patientId, planId),
      );
      expect(again.issuedOn).toBe('2026-11-09');
    } finally {
      held.release();
      await held.done;
    }
  });

  it('M-5: un borrador sin ítems se imprime sin guardar fechas', async () => {
    const plan = await owner.treatmentPlan.create({
      data: { tenantId, patientId, currency: 'VES' },
      select: { id: true },
    });
    const doc = await tenantContext.run(tenantId, () =>
      issueAt(DAY1).execute(patientId, plan.id),
    );
    expect(doc.totals[0].net).toBe(0);
    expect(await storedValidity(plan.id)).toEqual({
      issuedOn: null,
      validUntil: null,
    });
  });
});
