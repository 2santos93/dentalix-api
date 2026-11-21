import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCommissionRepository } from '../src/modules/commissions/infrastructure/prisma-commission.repository';
import type { CommissionProfessional } from '../src/modules/commissions/domain/ports/commission-repository.port';
import type { CommissionLineDraft } from '../src/modules/commissions/domain/commission-calculator';
import type { CommissionRuleTerms } from '../src/modules/commissions/domain/commission-rule';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants, purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-018, capa DB de los honorarios: RLS FORCE (otra clínica no ve ni escribe
// nada), la liquidación cerrada y su detalle son inalterables (sin UPDATE ni
// DELETE para la app; el trigger los rechaza también al dueño), sin solapes
// por profesional (EXCLUDE), un devengo no se paga dos veces al mismo
// profesional, el cierre contable sube con el cierre y nunca retrocede, y el
// ajuste se detecta en SQL cuando el ítem cambia tras el cierre. Se escribe
// como la app (runWithTenant, dentalix_app); `raw` (DIRECT_URL) siembra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaCommissionRepository(prisma, tenantContext);

interface Clinic {
  tenantId: string;
  locationId: string;
  professional: CommissionProfessional;
  patientId: string;
  planId: string;
  itemIds: string[];
}

const SUBDOMAINS = ['dx018-int-a', 'dx018-int-b'];

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dra-${randomUUID()}@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Carmen',
      lastName: subdomain,
      phone: '+584120000018',
    },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'dx018',
      kind: 'PROCEDURE',
      labelEs: 'Endodoncia',
      category: 'Endodoncia',
      color: '#123456',
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
  });
  const itemIds: string[] = [];
  for (const [i, tooth] of ['11', '21'].entries()) {
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        catalogItemId: catalog.id,
        toothNumber: tooth,
        price: 200,
        status: 'DONE',
        performedById: user.id,
        performedByMembershipId: membership.id,
        performedLocationId: location.id,
        completedAt: new Date(`2026-09-1${i}T15:00:00.000Z`),
      },
    });
    itemIds.push(item.id);
  }
  return {
    tenantId: tenant.id,
    locationId: location.id,
    professional: {
      membershipId: membership.id,
      userId: user.id,
      name: user.fullName,
      role: 'DENTIST',
      active: true,
    },
    patientId: patient.id,
    planId: plan.id,
    itemIds,
  };
}

const TERMS: CommissionRuleTerms = {
  basis: 'PRODUCED',
  releaseMode: 'PER_ITEM',
  percent: 30,
  categories: [],
  deductLabCost: false,
  deductCardFee: false,
};

function accrual(c: Clinic, itemId: string): CommissionLineDraft {
  return {
    kind: 'ACCRUAL',
    adjustsLineId: null,
    itemId,
    planId: c.planId,
    patientId: c.patientId,
    paymentId: null,
    locationId: c.locationId,
    catalogCode: 'dx018',
    catalogLabel: 'Endodoncia',
    category: 'Endodoncia',
    toothNumber: '11',
    completedAt: new Date('2026-09-10T15:00:00.000Z'),
    paidAt: null,
    paymentAmount: null,
    paymentCurrency: null,
    releasedAt: new Date('2026-09-10T15:00:00.000Z'),
    currency: 'USD',
    base: 200,
    percent: 30,
    amount: 60,
    grossBase: 200,
    labCostDeducted: 0,
    cardFeePercent: null,
    cardFeeDeducted: 0,
    labCostSkippedCurrencies: [],
  };
}

function ctxOf(c: Clinic): AuditRequestContext {
  return {
    tenantId: c.tenantId,
    locationId: c.locationId,
    actor: { userId: c.professional.userId, role: 'ADMIN' },
    requestId: null,
    ip: null,
    userAgent: null,
  };
}

const inTenant = <T>(c: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(c.tenantId, undefined, fn);

const close = (
  c: Clinic,
  period: { from: string; to: string },
  lines: CommissionLineDraft[],
) =>
  inTenant(c, () =>
    repo.close(
      c.professional.membershipId,
      () =>
        Promise.resolve({
          professional: c.professional,
          period,
          terms: TERMS,
          lines,
        }),
      ctxOf(c),
    ),
  );

describe('Honorarios: RLS y liquidación congelada (int, DX-018)', () => {
  let a: Clinic;
  let b: Clinic;
  let septId: string;

  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await purgeTenants(raw, [a.tenantId, b.tenantId]);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('cerrar inserta la cabecera y el detalle y sube el cierre contable hasta el «hasta»', async () => {
    const closed = await close(a, { from: '2026-09-01', to: '2026-09-30' }, [
      accrual(a, a.itemIds[0]),
    ]);
    septId = closed.id;
    expect(closed).toMatchObject({
      lockDateBefore: null,
      lockDateAfter: '2026-09-30',
    });
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
      select: { financialLockDate: true },
    });
    expect(tenant.financialLockDate?.toISOString().slice(0, 10)).toBe(
      '2026-09-30',
    );
    const view = await inTenant(a, () => repo.getSettlement(septId));
    expect(view?.summary.totals).toEqual([
      { currency: 'USD', accrued: 60, adjustments: 0, total: 60, lines: 1 },
    ]);
    expect(view?.lines[0].patient.name).toBe(`Carmen ${SUBDOMAINS[0]}`);
  });

  it('el cierre contable nunca retrocede', async () => {
    await raw.tenant.update({
      where: { id: a.tenantId },
      data: { financialLockDate: new Date('2026-11-05T00:00:00.000Z') },
    });
    const closed = await close(a, { from: '2026-10-01', to: '2026-10-31' }, []);
    expect(closed).toMatchObject({
      lockDateBefore: '2026-11-05',
      lockDateAfter: '2026-11-05',
    });
  });

  it('la app no puede cambiar ni borrar una liquidación cerrada ni su detalle', async () => {
    const asApp = (sql: Prisma.Sql) =>
      inTenant(a, () => prisma.runWithTenant((tx) => tx.$executeRaw(sql)));
    await expect(
      asApp(
        Prisma.sql`UPDATE "commission_settlements" SET "percent" = 99 WHERE "id" = ${septId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        Prisma.sql`UPDATE "commission_settlement_lines" SET "amount" = 1 WHERE "settlementId" = ${septId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        Prisma.sql`DELETE FROM "commission_settlement_lines" WHERE "settlementId" = ${septId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(Prisma.sql`DELETE FROM "commission_rules"`),
    ).rejects.toThrow(/permission denied/);
    // El trigger también al dueño (UPDATE): se corrige con ajustes en la siguiente.
    await expect(
      raw.$executeRaw`UPDATE "commission_settlement_lines" SET "amount" = 1 WHERE "settlementId" = ${septId}::uuid`,
    ).rejects.toThrow(/inalterable/);
    const line = await raw.commissionSettlementLine.findFirstOrThrow({
      where: { settlementId: septId },
      select: { amount: true },
    });
    expect(line.amount.toNumber()).toBe(60);
  });

  it('RLS: otra clínica no ve ni escribe liquidaciones de A', async () => {
    expect(await inTenant(b, () => repo.getSettlement(septId))).toBeNull();
    expect(
      await inTenant(b, () => repo.listSettlements({ limit: 50 })),
    ).toEqual([]);
    const visible = await inTenant(b, () =>
      prisma.runWithTenant(
        (tx) =>
          tx.$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) AS n FROM "commission_settlement_lines"`,
      ),
    );
    expect(Number(visible[0].n)).toBe(0);
    await expect(
      inTenant(b, () =>
        prisma.runWithTenant((tx) =>
          tx.commissionRule.create({
            data: {
              id: '00000000-0000-4000-8000-000000000018',
              tenantId: a.tenantId,
              membershipId: a.professional.membershipId,
              userId: a.professional.userId,
              basis: 'COLLECTED',
              percent: 50,
              createdById: a.professional.userId,
              updatedById: a.professional.userId,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('dos liquidaciones del mismo profesional no se solapan (EXCLUDE → 409)', async () => {
    await expect(
      close(a, { from: '2026-09-15', to: '2026-10-15' }, []),
    ).rejects.toThrow(ConflictException);
  });

  it('un devengo no se paga dos veces al mismo profesional', async () => {
    await expect(
      close(a, { from: '2026-11-01', to: '2026-11-30' }, [
        accrual(a, a.itemIds[0]),
      ]),
    ).rejects.toThrow(
      /commission_settlement_lines_accrual_key|Unique constraint/,
    );
    // La transacción entera se deshizo: no quedó la cabecera de noviembre.
    expect(
      await raw.commissionSettlement.count({
        where: {
          tenantId: a.tenantId,
          periodFrom: new Date('2026-11-01T00:00:00.000Z'),
        },
      }),
    ).toBe(0);
  });

  it('lo liquidado que cambia después (ítem borrado) sale en SQL para ajustarlo; lo pendiente, como candidato', async () => {
    const reader = <T>(fn: Parameters<typeof repo.read<T>>[0]) =>
      inTenant(a, () => repo.read(fn));
    expect(await reader((r) => r.settledToAdjust(a.professional))).toEqual([]);
    // El segundo ítem aún no se liquidó: es candidato «producido» de septiembre.
    const candidates = await reader((r) =>
      r.candidates(a.professional, TERMS, {
        start: new Date('2026-08-31T10:00:00.000Z'),
        end: new Date('2026-10-01T14:00:00.000Z'),
      }),
    );
    expect(candidates.map((c) => c.itemId)).toEqual([a.itemIds[1]]);
    expect(candidates[0]).toMatchObject({
      timeZone: 'America/Caracas',
      net: 200,
      category: 'Endodoncia',
      producedPending: true,
    });

    await raw.treatmentPlanItem.update({
      where: { id: a.itemIds[0] },
      data: { deletedAt: new Date() },
    });
    const toAdjust = await reader((r) => r.settledToAdjust(a.professional));
    expect(toAdjust).toEqual([
      expect.objectContaining({
        itemId: a.itemIds[0],
        settledBase: 200,
        settledAmount: 60,
        settledGross: 200,
        originalGross: 200,
        originalLabCost: 0,
        cardFeePercent: null,
        currentGross: 0,
        percent: 30,
      }),
    ]);
    // Otra clínica no ve lo de A.
    expect(
      await inTenant(b, () =>
        repo.read((r) => r.settledToAdjust(a.professional)),
      ),
    ).toEqual([]);
  });
  it('DX-018-bis: los candidatos traen el costo de laboratorio de sus órdenes vivas en la moneda del plan; las de otra moneda, aparte', async () => {
    const lab = await raw.dentalLab.create({
      data: { tenantId: a.tenantId, name: 'Laboratorio Dental Caracas' },
    });
    const order = (cost: string, currency: string) =>
      raw.dentalLabOrder.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientId,
          professionalMembershipId: a.professional.membershipId,
          labId: lab.id,
          treatmentPlanItemId: a.itemIds[1],
          description: 'Corona de zirconio',
          createdById: a.professional.userId,
          // Lo pone el trigger.
          number: 0,
          cost: new Prisma.Decimal(cost),
          costCurrency: currency,
        },
      });
    await order('50.10', 'USD');
    await order('20', 'USD');
    await order('3650', 'VES');
    // Anulada: no cuenta (anular en el alta lo rechaza el CHECK de DX-017).
    const voided = await order('999', 'USD');
    await raw.dentalLabOrder.update({
      where: { id: voided.id },
      data: {
        cancelledAt: new Date('2026-09-12T15:00:00.000Z'),
        cancelledById: a.professional.userId,
        cancelReason: 'Repetida por error',
      },
    });
    const window = {
      start: new Date('2026-08-31T10:00:00.000Z'),
      end: new Date('2026-10-01T14:00:00.000Z'),
    };
    const read = (terms: CommissionRuleTerms) =>
      inTenant(a, () =>
        repo.read((r) => r.candidates(a.professional, terms, window)),
      );
    const [withLab] = await read({ ...TERMS, deductLabCost: true });
    expect(withLab).toMatchObject({
      itemId: a.itemIds[1],
      labCost: 70.1,
      labCostSkippedCurrencies: ['VES'],
    });
    // Sin «descontar laboratorio» ni se consulta.
    const [withoutLab] = await read(TERMS);
    expect(withoutLab).toMatchObject({
      labCost: null,
      labCostSkippedCurrencies: [],
    });
    // Otra clínica no ve los costos de A.
    await expect(
      inTenant(b, () =>
        repo.read((r) =>
          r.candidates(
            a.professional,
            { ...TERMS, deductLabCost: true },
            window,
          ),
        ),
      ),
    ).resolves.toEqual([]);
  });

  it('DX-018-bis: la línea congelada cumple base = bruta − laboratorio − pasarela (CHECK)', async () => {
    const period = { from: '2026-11-01', to: '2026-11-02' };
    const line = (over: Partial<CommissionLineDraft>) => ({
      ...accrual(a, a.itemIds[1]),
      ...over,
    });
    await expect(
      close(a, period, [line({ grossBase: 250, labCostDeducted: 30 })]),
    ).rejects.toThrow(/commission_settlement_lines_deductions_check/);
    await expect(
      close(a, period, [
        line({ grossBase: 210, cardFeePercent: 0, cardFeeDeducted: 10 }),
      ]),
    ).rejects.toThrow(/commission_settlement_lines_deductions_check/);
    const closed = await close(a, period, [
      line({
        grossBase: 260,
        labCostDeducted: 50.9,
        cardFeePercent: 3.5,
        cardFeeDeducted: 9.1,
        labCostSkippedCurrencies: ['VES'],
      }),
    ]);
    const view = await inTenant(a, () => repo.getSettlement(closed.id));
    expect(view?.lines[0]).toMatchObject({
      base: 200,
      deductions: {
        grossBase: 260,
        labCost: 50.9,
        cardFeePercent: 3.5,
        cardFee: 9.1,
        labCostSkippedCurrencies: ['VES'],
      },
    });
    // Las líneas anteriores (sin base bruta) se leen como bruta = base.
    const sept = await inTenant(a, () => repo.getSettlement(septId));
    expect(sept?.lines[0].deductions).toEqual({
      grossBase: 200,
      labCost: 0,
      cardFeePercent: null,
      cardFee: 0,
      labCostSkippedCurrencies: [],
    });
  });
});
