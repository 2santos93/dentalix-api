import { Prisma, PrismaClient, PriceSource } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanRepricingRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-repricing.repository';
import {
  computeRepricing,
  type RepricingReference,
} from '../src/modules/treatment-plans/application/repricing';
import type { DecideRepricing } from '../src/modules/treatment-plans/domain/ports/plan-repricing-repository.port';
import { DEFAULT_DISCOUNT_POLICY } from '../src/modules/discounts/domain/discount-policy';
import { resetDatabase } from './support/e2e-fixtures';
import {
  holdLock,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-379 (porción B) contra Postgres: la excepción de los triggers de la foto
// del precio (solo con la marca y en un ítem propuesto de un plan abierto),
// la tabla de recotizaciones de solo alta y la idempotencia bajo concurrencia.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPlanRepricingRepository(prisma, tenantContext);

const KEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FINGERPRINT = 'f'.repeat(64);

let tenantId: string;
let locationId: string;
let patientId: string;
let catalogItemId: string;
let userId: string;

async function plan(
  status: 'DRAFT' | 'PRESENTED' | 'ACCEPTED' | 'CANCELLED' = 'PRESENTED',
): Promise<{ planId: string; itemId: string }> {
  const created = await owner.treatmentPlan.create({
    data: { tenantId, patientId, currency: 'VES' },
    select: { id: true },
  });
  const item = await owner.treatmentPlanItem.create({
    data: {
      tenantId,
      planId: created.id,
      toothNumber: '36',
      catalogItemId,
      catalogPrice: 100,
      basePrice: 100,
      catalogCurrency: 'USD',
      priceSource: PriceSource.CATALOG,
      pricingLocationId: locationId,
      referenceCurrency: 'USD',
      referencePriceInPlan: 3600,
      basePriceInPlan: 3600,
      referenceRateFrom: 1,
      referenceRateTo: 36,
      referenceRateSource: 'MANUAL',
      referenceRateDate: new Date('2026-10-01T00:00:00.000Z'),
      price: 3600,
      discount: 0,
    },
    select: { id: true },
  });
  if (status !== 'DRAFT') {
    await owner.treatmentPlan.update({
      where: { id: created.id },
      data: {
        status,
        presentedAt: new Date('2026-11-01T15:00:00.000Z'),
        presentedLocationId: locationId,
      },
    });
  }
  return { planId: created.id, itemId: item.id };
}

/** Reescribe la foto del ítem como lo hace la recotización. */
function rewriteSnapshot(
  itemId: string,
  withMarker: boolean,
  opts: { price?: boolean } = {},
) {
  return tenantContext.run(tenantId, () =>
    prisma.runWithTenant(async (tx) => {
      if (withMarker) {
        await tx.$executeRaw`SELECT set_config('app.plan_item_reprice', 'on', true)`;
      }
      await tx.treatmentPlanItem.update({
        where: { id: itemId },
        data: {
          catalogCurrency: 'VES',
          referenceCurrency: 'VES',
          referencePriceInPlan: 4000,
          basePriceInPlan: 4000,
          referenceRateFrom: null,
          referenceRateTo: null,
          referenceRateSource: null,
          referenceRateDate: null,
          ...(opts.price === false ? {} : { price: 4000 }),
        },
      });
    }),
  );
}

function catalogReference(price: number): RepricingReference {
  return {
    kind: 'priced',
    resolved: {
      price,
      basePrice: price,
      source: PriceSource.CATALOG,
      agreementId: null,
      agreementName: null,
      allowDiscount: true,
    },
    catalogCurrency: 'VES',
    pricingLocationId: locationId,
    reference: {
      referenceCurrency: 'VES',
      referencePriceInPlan: price,
      basePriceInPlan: price,
      referenceRate: null,
    },
  };
}

const decideAt =
  (price: number): DecideRepricing =>
  ({ plan: locked }) =>
    computeRepricing({
      plan: locked,
      references: new Map([[catalogItemId, catalogReference(price)]]),
      digits: 2,
      policy: DEFAULT_DISCOUNT_POLICY,
      actor: { userId, role: 'DENTIST' },
      at: new Date('2026-11-09T15:00:00.000Z'),
      validity: { issuedOn: '2026-11-09', validUntil: '2026-12-09' },
    });

describe('recotizar en Postgres (DX-379 porción B)', () => {
  beforeAll(async () => {
    await resetDatabase(owner);
    const tenant = await owner.tenant.create({
      data: { name: 'dx379b-int', subdomain: 'dx379b-int' },
    });
    tenantId = tenant.id;
    locationId = (
      await owner.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede principal',
        }),
        select: { id: true },
      })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Recotiza' },
        select: { id: true },
      })
    ).id;
    catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'c-dx379b',
          kind: 'PROCEDURE',
          labelEs: 'Endodoncia',
          color: '#123456',
        },
        select: { id: true },
      })
    ).id;
    userId = (
      await owner.user.create({
        data: {
          email: 'dx379b@example.test',
          fullName: 'Dra. Recotiza',
          passwordHash: 'x',
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

  describe('triggers de la foto del precio', () => {
    it('sin la marca, la moneda del catálogo y la foto siguen sin poder cambiar', async () => {
      const { itemId } = await plan('PRESENTED');
      await expect(rewriteSnapshot(itemId, false)).rejects.toThrow(
        /queda fijada/,
      );
    });

    it('con la marca, en un ítem propuesto de un plan abierto (borrador o presentado), sí', async () => {
      for (const status of ['DRAFT', 'PRESENTED'] as const) {
        const { itemId } = await plan(status);
        await rewriteSnapshot(itemId, true);
        const row = await owner.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        });
        expect(row.catalogCurrency).toBe('VES');
        expect(row.referencePriceInPlan?.toNumber()).toBe(4000);
      }
    });

    it('con la marca, en un plan aceptado o cancelado, o en un ítem no propuesto, no', async () => {
      for (const status of ['ACCEPTED', 'CANCELLED'] as const) {
        const { itemId } = await plan(status);
        // El trigger de la foto falla primero, con su mensaje exacto.
        await expect(rewriteSnapshot(itemId, true)).rejects.toThrow(
          /la moneda del catálogo del ítem queda fijada al darlo de alta: no cambia/,
        );
      }
      const { itemId } = await plan('PRESENTED');
      await owner.treatmentPlanItem.update({
        where: { id: itemId },
        data: { status: 'ACCEPTED' },
      });
      await expect(rewriteSnapshot(itemId, true)).rejects.toThrow(
        /queda fijada/,
      );
    });

    it('M-1/M-2: con la marca, tampoco en un plan borrado, un ítem borrado ni el cargo vigente por inasistencia', async () => {
      const deletedPlan = await plan('PRESENTED');
      await owner.treatmentPlan.update({
        where: { id: deletedPlan.planId },
        data: { deletedAt: new Date() },
      });
      await expect(
        rewriteSnapshot(deletedPlan.itemId, true, { price: false }),
      ).rejects.toThrow(/queda fijada/);

      const deletedItem = await plan('PRESENTED');
      await owner.treatmentPlanItem.update({
        where: { id: deletedItem.itemId },
        data: { deletedAt: new Date() },
      });
      await expect(
        rewriteSnapshot(deletedItem.itemId, true, { price: false }),
      ).rejects.toThrow(/queda fijada/);

      // Cargo vigente (CHARGED, sin anular) de una cita: solo se toca la foto
      // (el precio ya lo congela el trigger SEC-050).
      const feeItem = await plan('PRESENTED');
      const start = new Date('2026-11-02T14:00:00.000Z');
      const policy = await owner.cancellationPolicyVersion.create({
        data: {
          tenantId,
          locationId,
          version: 1,
          noticeHours: 24,
          suggestedFee: 10,
          currency: 'VES',
          createdById: userId,
        },
        select: { id: true },
      });
      const appointment = await owner.appointment.create({
        data: {
          tenantId,
          locationId,
          patientId,
          providerId: userId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
          noShowMarkedAt: start,
          policyVersionId: policy.id,
        },
        select: { id: true },
      });
      await owner.cancellationFee.create({
        data: {
          tenantId,
          appointmentId: appointment.id,
          patientId,
          locationId,
          status: 'CHARGED',
          amount: 10,
          currency: 'VES',
          planItemId: feeItem.itemId,
          policyVersionId: policy.id,
          createdById: userId,
        },
      });
      await expect(
        rewriteSnapshot(feeItem.itemId, true, { price: false }),
      ).rejects.toThrow(/queda fijada/);
      // Control: sin cargo, la misma escritura con la marca pasa.
      const control = await plan('PRESENTED');
      await rewriteSnapshot(control.itemId, true, { price: false });
    });

    it('la marca de una transacción no vale en la siguiente (SET LOCAL)', async () => {
      const { itemId } = await plan('PRESENTED');
      await tenantContext.run(tenantId, () =>
        prisma.runWithTenant(
          (tx) =>
            tx.$executeRaw`SELECT set_config('app.plan_item_reprice', 'on', true)`,
        ),
      );
      await expect(rewriteSnapshot(itemId, false)).rejects.toThrow(
        /queda fijada/,
      );
    });
  });

  describe('treatment_plan_repricings', () => {
    it('aplicar escribe ítems, validez del plan y la fila; la marca no queda puesta', async () => {
      const { planId, itemId } = await plan('PRESENTED');
      const outcome = await tenantContext.run(tenantId, () =>
        repo.apply(
          patientId,
          planId,
          { key: KEY, fingerprint: FINGERPRINT },
          userId,
          decideAt(4000),
        ),
      );
      expect(outcome.kind).toBe('applied');
      const item = await owner.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.price.toNumber()).toBe(4000);
      expect(item.catalogCurrency).toBe('VES');
      expect(item.referenceRateTo).toBeNull();
      const stored = await owner.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { quoteIssuedOn: true, quoteValidUntil: true },
      });
      expect(stored.quoteIssuedOn?.toISOString().slice(0, 10)).toBe(
        '2026-11-09',
      );
      expect(stored.quoteValidUntil?.toISOString().slice(0, 10)).toBe(
        '2026-12-09',
      );
      const rows = await owner.treatmentPlanRepricing.findMany({
        where: { planId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        patientId,
        locationId,
        actorUserId: userId,
        source: 'MANUAL',
        validityRenewed: true,
        idempotencyKey: KEY,
        requestFingerprint: FINGERPRINT,
      });
      expect(rows[0].totalBefore.toNumber()).toBe(3600);
      expect(rows[0].totalAfter.toNumber()).toBe(4000);
      const lines = rows[0].lines as { before: { price: number } }[];
      expect(lines[0].before.price).toBe(3600);

      // Misma clave, misma petición: lo aplicado; otra petición: key-reused.
      const again = await tenantContext.run(tenantId, () =>
        repo.apply(
          patientId,
          planId,
          { key: KEY, fingerprint: FINGERPRINT },
          userId,
          decideAt(9999),
        ),
      );
      expect(again).toEqual({
        kind: 'replayed',
        record: outcome.kind === 'applied' ? outcome.record : null,
      });
      const other = await tenantContext.run(tenantId, () =>
        repo.apply(
          patientId,
          planId,
          { key: KEY, fingerprint: 'e'.repeat(64) },
          userId,
          decideAt(9999),
        ),
      );
      expect(other).toEqual({ kind: 'key-reused' });
    });

    it('la app no la cambia ni la borra; el owner tampoco la cambia', async () => {
      const [row] = await owner.treatmentPlanRepricing.findMany({ take: 1 });
      await expect(
        tenantContext.run(tenantId, () =>
          prisma.runWithTenant((tx) =>
            tx.treatmentPlanRepricing.update({
              where: { id: row.id },
              data: { totalAfter: 1 },
            }),
          ),
        ),
      ).rejects.toThrow(/permission denied|permiso denegado/i);
      await expect(
        tenantContext.run(tenantId, () =>
          prisma.runWithTenant(
            (tx) =>
              // Por SQL: el cliente ya prohíbe el borrado duro antes.
              tx.$executeRaw`DELETE FROM "treatment_plan_repricings" WHERE "id" = ${row.id}::uuid`,
          ),
        ),
      ).rejects.toThrow(/permission denied|permiso denegado/i);
      await expect(
        owner.treatmentPlanRepricing.update({
          where: { id: row.id },
          data: { totalAfter: 1 },
        }),
      ).rejects.toThrow(/solo alta/);
    });

    it('otra clínica no la ve (RLS FORCE)', async () => {
      const other = await owner.tenant.create({
        data: { name: 'dx379b-other', subdomain: 'dx379b-other' },
      });
      const seen = await tenantContext.run(other.id, () =>
        prisma.runWithTenant((tx) => tx.treatmentPlanRepricing.count()),
      );
      expect(seen).toBe(0);
    });

    it('dos aplicar a la vez con la misma clave dejan UNA fila: la segunda devuelve la primera', async () => {
      const { planId } = await plan('PRESENTED');
      const key = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b00';
      // El test retiene el candado de la clave hasta que esperan las dos.
      const held = await holdLock(
        owner,
        (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext('dx_plan_repricing_idempotency:' || ${tenantId}),
          hashtext(${key})
        )`,
      );
      const run = () =>
        settle(
          tenantContext.run(tenantId, () =>
            repo.apply(
              patientId,
              planId,
              { key, fingerprint: FINGERPRINT },
              userId,
              decideAt(4100),
            ),
          ),
        );
      const first = run();
      const second = run();
      await waitForLockWaiters(owner, [held.pid], 2);
      held.release();
      await held.done;
      const outcomes = await Promise.all([first, second]);
      const kinds = outcomes.map((o) =>
        o.status === 'fulfilled' ? o.value.kind : 'rejected',
      );
      expect(kinds.sort()).toEqual(['applied', 'replayed']);
      const ids = outcomes.map((o) =>
        o.status === 'fulfilled' && o.value.kind !== 'key-reused'
          ? o.value.record.id
          : null,
      );
      expect(ids[0]).toBe(ids[1]);
      expect(
        await owner.treatmentPlanRepricing.count({
          where: { tenantId, idempotencyKey: key },
        }),
      ).toBe(1);
    });

    it('si decide lanza, nada se escribe', async () => {
      const { planId, itemId } = await plan('PRESENTED');
      await expect(
        tenantContext.run(tenantId, () =>
          repo.apply(
            patientId,
            planId,
            {
              key: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c00',
              fingerprint: FINGERPRINT,
            },
            userId,
            () => {
              throw new Error('obsoleta');
            },
          ),
        ),
      ).rejects.toThrow('obsoleta');
      const item = await owner.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.price.toNumber()).toBe(3600);
      expect(
        await owner.treatmentPlanRepricing.count({ where: { planId } }),
      ).toBe(0);
    });
  });
});
