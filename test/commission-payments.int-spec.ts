import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { PrismaCommissionRepository } from '../src/modules/commissions/infrastructure/prisma-commission.repository';
import { PrismaCommissionPaymentRepository } from '../src/modules/commissions/infrastructure/prisma-commission-payment.repository';
import { PdfkitCommissionPdfRenderer } from '../src/modules/commissions/infrastructure/commission-pdf.renderer';
import { CommissionPaymentUseCases } from '../src/modules/commissions/application/commission-payment.use-cases';
import type { CommissionProfessional } from '../src/modules/commissions/domain/ports/commission-repository.port';
import type { CommissionLineDraft } from '../src/modules/commissions/domain/commission-calculator';
import type { CommissionRuleTerms } from '../src/modules/commissions/domain/commission-rule';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaExpenseRepository } from '../src/modules/expenses/infrastructure/repositories/prisma-expense.repository';
import { CreateExpenseUseCase } from '../src/modules/expenses/application/use-cases/create-expense.use-case';
import { VoidExpenseUseCase } from '../src/modules/expenses/application/use-cases/void-expense.use-case';
import { ExpenseCategoryResolver } from '../src/modules/expenses/application/expense-category-resolver';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants, purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-464, capa DB del pago de la liquidación: el pago parcial y el total
// crean su gasto de la sede en la MISMA transacción (con su pago y la
// categoría «Honorarios»), la anulación anula el gasto y devuelve lo
// pendiente, una línea no se paga dos veces (único parcial), el gasto ligado
// no se toca desde Gastos, el cierre contable frena el pago, y la RLS separa
// dos clínicas. Se escribe como la app (runWithTenant, dentalix_app); `raw`
// (DIRECT_URL) siembra y comprueba.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const settlements = new PrismaCommissionRepository(prisma, tenantContext);
const payRepo = new PrismaCommissionPaymentRepository(prisma, tenantContext);
const expenseRepo = new PrismaExpenseRepository(prisma, tenantContext);
const clock = () => new Date();
const createExpense = new CreateExpenseUseCase(
  expenseRepo,
  // «Honorarios» es predefinida: no consulta las categorías propias.
  new ExpenseCategoryResolver({} as never),
  {} as never,
  { has: () => Promise.resolve(true) },
  clock,
);
const voidExpense = new VoidExpenseUseCase(expenseRepo, clock);
const useCases = new CommissionPaymentUseCases(
  payRepo,
  createExpense,
  voidExpense,
  tenantContext,
  new PdfkitCommissionPdfRenderer({ compress: false }),
  clock,
);

interface Clinic {
  tenantId: string;
  locationId: string;
  adminId: string;
  professional: CommissionProfessional;
  patientId: string;
  planId: string;
  itemIds: string[];
}

const SUBDOMAINS = ['dx464-int-a', 'dx464-int-b'];
const TODAY = civilDateIn(new Date(), 'America/Caracas');
// Período ya terminado y relativo a hoy (FAKE_NOW de la CI incluido).
const PERIOD = { from: addCivilDays(TODAY, -40), to: addCivilDays(TODAY, -10) };

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
  const [admin, dentist] = await Promise.all(
    ['admin', 'dra'].map((who) =>
      raw.user.create({
        data: {
          email: `${who}-${randomUUID()}@${subdomain}.test`,
          passwordHash: 'x',
          fullName: who === 'admin' ? 'Admin Sede' : 'Dra. Andrea Rivas',
        },
      }),
    ),
  );
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: admin.id, role: 'ADMIN' },
  });
  const membership = await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: dentist.id, role: 'DENTIST' },
  });
  const patient = await raw.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'María José',
      lastName: 'Pérez',
      phone: '+584120000464',
    },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: 'dx464',
      kind: 'PROCEDURE',
      labelEs: 'Resina compuesta',
      category: 'Operatoria',
      color: '#123456',
    },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
  });
  const itemIds: string[] = [];
  for (const tooth of ['16', '26', '36']) {
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        catalogItemId: catalog.id,
        toothNumber: tooth,
        price: 100,
        status: 'DONE',
        performedById: dentist.id,
        performedByMembershipId: membership.id,
        performedLocationId: location.id,
        completedAt: new Date(`${addCivilDays(PERIOD.from, 2)}T15:00:00.000Z`),
      },
    });
    itemIds.push(item.id);
  }
  return {
    tenantId: tenant.id,
    locationId: location.id,
    adminId: admin.id,
    professional: {
      membershipId: membership.id,
      userId: dentist.id,
      name: dentist.fullName,
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
  percent: 35,
  categories: [],
  deductLabCost: false,
  deductCardFee: false,
};

function accrual(
  c: Clinic,
  itemId: string,
  currency: string,
  amount: number,
): CommissionLineDraft {
  const at = new Date(`${addCivilDays(PERIOD.from, 2)}T15:00:00.000Z`);
  return {
    kind: 'ACCRUAL',
    adjustsLineId: null,
    itemId,
    planId: c.planId,
    patientId: c.patientId,
    paymentId: null,
    locationId: c.locationId,
    catalogCode: 'dx464',
    catalogLabel: 'Resina compuesta',
    category: 'Operatoria',
    toothNumber: '16',
    completedAt: at,
    paidAt: null,
    paymentAmount: null,
    paymentCurrency: null,
    releasedAt: at,
    currency,
    base: Math.round((amount / 0.35) * 100) / 100,
    percent: 35,
    amount,
  };
}

function ctxOf(c: Clinic): AuditRequestContext {
  return {
    tenantId: c.tenantId,
    locationId: null,
    actor: { userId: c.adminId, role: 'ADMIN' },
    requestId: null,
    ip: null,
    userAgent: null,
  };
}

const ADMIN = (c: Clinic) => ({ userId: c.adminId, role: 'ADMIN' as const });

const inTenant = <T>(c: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(c.tenantId, undefined, fn);

async function closeSettlement(c: Clinic): Promise<string> {
  const closed = await inTenant(c, () =>
    settlements.close(
      c.professional.membershipId,
      () =>
        Promise.resolve({
          professional: c.professional,
          period: PERIOD,
          terms: TERMS,
          lines: [
            accrual(c, c.itemIds[0], 'USD', 35),
            accrual(c, c.itemIds[1], 'USD', 15),
            accrual(c, c.itemIds[2], 'VES', 1200),
          ],
        }),
      ctxOf(c),
    ),
  );
  return closed.id;
}

const lineIdsOf = async (settlementId: string, currency: string) =>
  (
    await raw.commissionSettlementLine.findMany({
      where: { settlementId, currency },
      orderBy: { amount: 'desc' },
      select: { id: true },
    })
  ).map((l) => l.id);

describe('Pago de la liquidación de honorarios (int, DX-464)', () => {
  let a: Clinic;
  let b: Clinic;
  let settlementId: string;
  let partialPaymentId: string;

  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    settlementId = await closeSettlement(a);
  });

  afterAll(async () => {
    await purgeTenants(raw, [a.tenantId, b.tenantId]);
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('pago parcial: una línea USD crea su gasto pagado en la sede y deja la liquidación «Pagada parcialmente»', async () => {
    const [first] = await lineIdsOf(settlementId, 'USD');
    const payment = await inTenant(a, () =>
      useCases.pay(
        ADMIN(a),
        settlementId,
        {
          currency: 'USD',
          lineIds: [first],
          paidOn: TODAY,
          method: 'TRANSFER',
          reference: 'TRF-0042',
        },
        ctxOf(a),
      ),
    );
    partialPaymentId = payment.id;
    expect(payment).toMatchObject({
      currency: 'USD',
      amount: 35,
      method: 'TRANSFER',
      paidOn: TODAY,
      reference: 'TRF-0042',
      lineIds: [first],
      location: { id: a.locationId, name: 'Sede Chacao' },
      voidedAt: null,
      receipt: { status: 'NONE' },
    });
    const expense = await raw.expense.findUniqueOrThrow({
      where: { id: payment.expenseId },
      include: { payments: true },
    });
    expect(expense).toMatchObject({
      tenantId: a.tenantId,
      locationId: a.locationId,
      category: 'Honorarios',
      supplier: 'Dra. Andrea Rivas',
      currency: 'USD',
      createdById: a.adminId,
      voidedAt: null,
    });
    expect(expense.amount.toNumber()).toBe(35);
    expect(expense.description).toBe(
      `Liquidación de honorarios del ${PERIOD.from} al ${PERIOD.to} · Ref. TRF-0042`,
    );
    expect(expense.payments).toHaveLength(1);
    expect(expense.payments[0]).toMatchObject({ method: 'TRANSFER' });
    expect(expense.payments[0].amount.toNumber()).toBe(35);

    const view = await inTenant(a, () =>
      settlements.getSettlement(settlementId),
    );
    expect(view?.summary.payment.status).toBe('PARTIALLY_PAID');
    expect(view?.summary.payment.currencies).toEqual([
      { currency: 'USD', total: 50, paid: 35, pending: 15, pendingLines: 1 },
      { currency: 'VES', total: 1200, paid: 0, pending: 1200, pendingLines: 1 },
    ]);
    expect(view?.lines.find((l) => l.id === first)?.paidInPaymentId).toBe(
      payment.id,
    );
    // Auditado sin importes, en la misma transacción.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceId: { in: [settlementId, payment.expenseId] },
      },
      select: { action: true, resourceType: true, metadata: true },
    });
    expect(
      events.map(
        (e) =>
          `${e.action} ${e.resourceType} ${(e.metadata as { reason?: string }).reason}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'CREATE COMMISSION_SETTLEMENT COMMISSION_PAYMENT_CREATED',
        'CREATE EXPENSE COMMISSION_PAYMENT',
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('"35"');
  });

  it('una línea ya pagada no se vuelve a pagar (409) y no queda gasto huérfano', async () => {
    const [first] = await lineIdsOf(settlementId, 'USD');
    const before = await raw.expense.count({ where: { tenantId: a.tenantId } });
    await expect(
      inTenant(a, () =>
        useCases.pay(
          ADMIN(a),
          settlementId,
          { currency: 'USD', lineIds: [first], paidOn: TODAY, method: 'CASH' },
          ctxOf(a),
        ),
      ),
    ).rejects.toThrow(ConflictException);
    // La BD también lo frena (único parcial por línea viva).
    await expect(
      inTenant(a, () =>
        prisma.runWithTenant((tx) =>
          tx.commissionPaymentLine.create({
            data: {
              id: randomUUID(),
              tenantId: a.tenantId,
              paymentId: partialPaymentId,
              lineId: first,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/Unique constraint|commission_payment_lines/);
    expect(await raw.expense.count({ where: { tenantId: a.tenantId } })).toBe(
      before,
    );
  });

  it('el gasto ligado no se anula ni edita desde Gastos (409)', async () => {
    const payment = await raw.commissionPayment.findUniqueOrThrow({
      where: { id: partialPaymentId },
    });
    await expect(
      inTenant(a, () =>
        voidExpense.execute(
          payment.expenseId,
          'Anulado desde gastos',
          a.adminId,
        ),
      ),
    ).rejects.toThrow(/liquidación/);
    await expect(
      inTenant(a, () =>
        expenseRepo.update(payment.expenseId, { description: 'x' }, new Date()),
      ),
    ).rejects.toThrow(/liquidación/);
  });

  it('pago total: el resto de USD y luego VES (cada moneda aparte, sin convertir) → «Pagada»', async () => {
    const usd = await inTenant(a, () =>
      useCases.pay(
        ADMIN(a),
        settlementId,
        { currency: 'USD', paidOn: TODAY, method: 'CASH' },
        ctxOf(a),
      ),
    );
    expect(usd.amount).toBe(15);
    const ves = await inTenant(a, () =>
      useCases.pay(
        ADMIN(a),
        settlementId,
        { currency: 'VES', paidOn: TODAY, method: 'TRANSFER' },
        ctxOf(a),
      ),
    );
    expect(ves).toMatchObject({ currency: 'VES', amount: 1200 });
    const expense = await raw.expense.findUniqueOrThrow({
      where: { id: ves.expenseId },
    });
    expect(expense.currency).toBe('VES');
    expect(expense.amount.toNumber()).toBe(1200);
    const view = await inTenant(a, () =>
      settlements.getSettlement(settlementId),
    );
    expect(view?.summary.payment.status).toBe('PAID');
    // Nada más que pagar: 409.
    await expect(
      inTenant(a, () =>
        useCases.pay(
          ADMIN(a),
          settlementId,
          { currency: 'USD', paidOn: TODAY, method: 'CASH' },
          ctxOf(a),
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: 'COMMISSION_NOTHING_PENDING' },
    });
  });

  it('anular el pago (con motivo) anula el gasto y su pago y devuelve lo pendiente', async () => {
    const voided = await inTenant(a, () =>
      useCases.void(
        ADMIN(a),
        partialPaymentId,
        'Transferencia rebotada',
        ctxOf(a),
      ),
    );
    expect(voided).toMatchObject({
      voidReason: 'Transferencia rebotada',
      voidedBy: { userId: a.adminId },
    });
    expect(voided.voidedAt).not.toBeNull();
    const expense = await raw.expense.findUniqueOrThrow({
      where: { id: voided.expenseId },
      include: { payments: true },
    });
    expect(expense.voidedAt).not.toBeNull();
    expect(expense.voidReason).toBe('Transferencia rebotada');
    expect(expense.payments.every((p) => p.voidedAt !== null)).toBe(true);
    const lines = await raw.commissionPaymentLine.findMany({
      where: { paymentId: partialPaymentId },
    });
    expect(lines.every((l) => l.voidedAt !== null)).toBe(true);
    const view = await inTenant(a, () =>
      settlements.getSettlement(settlementId),
    );
    expect(view?.summary.payment.status).toBe('PARTIALLY_PAID');
    expect(
      view?.summary.payment.currencies.find((c) => c.currency === 'USD'),
    ).toMatchObject({ paid: 15, pending: 35 });
    // Otra vez: 409.
    await expect(
      inTenant(a, () =>
        useCases.void(ADMIN(a), partialPaymentId, 'Otra vez', ctxOf(a)),
      ),
    ).rejects.toThrow(ConflictException);
    // La línea vuelve a poder pagarse.
    const again = await inTenant(a, () =>
      useCases.pay(
        ADMIN(a),
        settlementId,
        { currency: 'USD', paidOn: TODAY, method: 'CARD' },
        ctxOf(a),
      ),
    );
    expect(again.amount).toBe(35);
  });

  it('un pago o su anulación no se cambian ni se borran (trigger y grants)', async () => {
    const asApp = (sql: Prisma.Sql) =>
      inTenant(a, () => prisma.runWithTenant((tx) => tx.$executeRaw(sql)));
    await expect(
      asApp(
        Prisma.sql`UPDATE "commission_payments" SET "amount" = 1 WHERE "id" = ${partialPaymentId}::uuid`,
      ),
    ).rejects.toThrow(/anulado no cambia|no se edita/);
    await expect(
      asApp(
        Prisma.sql`DELETE FROM "commission_payments" WHERE "id" = ${partialPaymentId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(
        Prisma.sql`UPDATE "commission_payment_lines" SET "voidedAt" = NULL WHERE "paymentId" = ${partialPaymentId}::uuid`,
      ),
    ).rejects.toThrow(/solo se anula/);
  });

  it('un día en un período contable cerrado frena el pago (409 PERIOD_LOCKED)', async () => {
    // El cierre subió hasta el «hasta» de la liquidación: pagar ese día no vale.
    const settlementB = await closeSettlement(b);
    await expect(
      inTenant(b, () =>
        useCases.pay(
          ADMIN(b),
          settlementB,
          { currency: 'USD', paidOn: PERIOD.to, method: 'CASH' },
          ctxOf(b),
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PERIOD_LOCKED' },
    });
    expect(await raw.expense.count({ where: { tenantId: b.tenantId } })).toBe(
      0,
    );
  });

  it('RLS: otra clínica no ve, no paga y no anula pagos de A', async () => {
    await expect(
      inTenant(b, () =>
        useCases.pay(
          ADMIN(b),
          settlementId,
          { currency: 'USD', paidOn: TODAY, method: 'CASH' },
          ctxOf(b),
        ),
      ),
    ).rejects.toThrow(NotFoundException);
    await expect(
      inTenant(b, () =>
        useCases.void(
          ADMIN(b),
          partialPaymentId,
          'Desde otra clínica',
          ctxOf(b),
        ),
      ),
    ).rejects.toThrow(NotFoundException);
    const visible = await inTenant(b, () =>
      prisma.runWithTenant(
        (tx) =>
          tx.$queryRaw<{ n: bigint }[]>`
          SELECT (SELECT count(*) FROM "commission_payments")
               + (SELECT count(*) FROM "commission_payment_lines") AS n`,
      ),
    );
    expect(Number(visible[0].n)).toBe(0);
    await expect(
      inTenant(b, () =>
        prisma.runWithTenant((tx) =>
          tx.commissionPayment.create({
            data: {
              tenantId: a.tenantId,
              settlementId,
              userId: a.professional.userId,
              locationId: a.locationId,
              currency: 'USD',
              amount: 1,
              method: 'CASH',
              paidOn: new Date(`${TODAY}T00:00:00.000Z`),
              expenseId: randomUUID(),
              createdById: b.adminId,
            },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('PDF de la liquidación: solo iniciales del paciente', async () => {
    const { pdf, filename } = await inTenant(a, () =>
      useCases.settlementPdf(ADMIN(a), settlementId),
    );
    expect(filename).toBe(
      `liquidacion-honorarios-${PERIOD.from}-${PERIOD.to}.pdf`,
    );
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    const painted = [...text.matchAll(/\[([^\]]*)\] TJ/g)]
      .map((op) =>
        [...op[1].matchAll(/<([0-9a-f]*)>/g)]
          .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
          .join(''),
      )
      .join('\n');
    expect(painted).toContain('M. J. P.');
    expect(painted).not.toContain('Pérez');
  });
});
