import { Logger } from '@nestjs/common';
import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { PlanAllocationRepository } from '../domain/ports/plan-allocation-repository.port';
import { paymentInPlanCurrency } from './payment-in-plan-currency';
import { PlanAllocationRebalancer } from './plan-allocation-rebalancer';

/** Tope de abonos sin base por clínica y pasada (el `LIMIT` del repositorio es `int`). */
const BACKFILL_PAYMENTS_LIMIT = 1_000_000;

export interface BackfillDeps {
  repo: PlanAllocationRepository;
  rebalancer: PlanAllocationRebalancer;
  convertAmount: ConvertAmountUseCase;
  tenantContext: TenantContextService;
}

export interface BackfillOptions {
  /** Solo esta clínica; sin él, todas las vivas. */
  tenantId?: string;
  /** Cuenta las bases en lugar de insertarlas y deshace los repartos. */
  dryRun?: boolean;
}

/** Solo números (spec R17.4): nunca datos de abonos ni de pacientes. */
export interface BackfillReport {
  tenantId: string;
  /** Abonos con base nueva (en dry-run, los que la tendrían). */
  basesCreated: number;
  /** Abonos que siguen sin base por no haber tasa. */
  withoutRate: number;
  /** Planes en los que el reparto imputó algo. */
  plansRebalanced: number;
  allocatedCents: number;
}

/**
 * Backfill de imputaciones de abonos anteriores a DX-051 (spec R17, D1),
 * clínica por clínica con su tenant en el contexto (RLS FORCE): crea las bases
 * que faltan y reparte cada plan con la misma regla automática. Idempotente:
 * no recrea bases ni toca imputaciones (el reparto solo llena sobrantes), así
 * que una segunda pasada no cambia nada. Un abono sin tasa se cuenta y sigue.
 */
export async function backfillPaymentAllocations(
  deps: BackfillDeps,
  opts: BackfillOptions = {},
): Promise<BackfillReport[]> {
  const logger = new Logger('PaymentAllocationsBackfill');
  const dryRun = opts.dryRun ?? false;
  const tenantIds = await deps.repo.tenantIds();
  if (opts.tenantId !== undefined && !tenantIds.includes(opts.tenantId)) {
    throw new Error('La clínica indicada no existe o está retirada.');
  }
  const targets = opts.tenantId === undefined ? tenantIds : [opts.tenantId];

  const reports: BackfillReport[] = [];
  for (const tenantId of targets) {
    reports.push(
      await deps.tenantContext.run(tenantId, async () => {
        const report: BackfillReport = {
          tenantId,
          basesCreated: 0,
          withoutRate: 0,
          plansRebalanced: 0,
          allocatedCents: 0,
        };
        await createBases(deps, dryRun, report, logger);
        await rebalancePlans(deps, dryRun, report, logger);
        return report;
      }),
    );
  }
  return reports;
}

async function createBases(
  deps: BackfillDeps,
  dryRun: boolean,
  report: BackfillReport,
  logger: Logger,
): Promise<void> {
  const payments = await deps.repo.paymentsWithoutBase(BACKFILL_PAYMENTS_LIMIT);
  for (const payment of payments) {
    let amount: number | null;
    try {
      amount = await paymentInPlanCurrency(deps.convertAmount, payment);
    } catch (error) {
      logger.warn({
        event: 'payments.allocation_backfill_conversion_failed',
        paymentId: payment.paymentId,
        error: errorName(error),
      });
      amount = null;
    }
    // Un importe que redondea a 0 no admite base (CHECK > 0): como sin tasa.
    if (amount === null || amount <= 0) {
      report.withoutRate += 1;
      continue;
    }
    if (dryRun) {
      report.basesCreated += 1;
      continue;
    }
    const created = await deps.repo.ensureBase(
      payment.paymentId,
      amount,
      payment.planCurrency,
      payment.paidOn,
    );
    if (created) report.basesCreated += 1;
  }
}

async function rebalancePlans(
  deps: BackfillDeps,
  dryRun: boolean,
  report: BackfillReport,
  logger: Logger,
): Promise<void> {
  for (const planId of await deps.repo.planIdsWithBases()) {
    try {
      const { allocatedCents } = await deps.rebalancer.rebalancePlan(
        planId,
        null,
        { dryRun },
      );
      if (allocatedCents > 0) {
        report.plansRebalanced += 1;
        report.allocatedCents += allocatedCents;
      }
    } catch (error) {
      // El plan queda para la pasada siguiente; no frena a los demás.
      logger.warn({
        event: 'payments.allocation_backfill_rebalance_failed',
        planId,
        error: errorName(error),
      });
    }
  }
}

/** Solo el tipo del error: nunca datos del abono ni del paciente. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
