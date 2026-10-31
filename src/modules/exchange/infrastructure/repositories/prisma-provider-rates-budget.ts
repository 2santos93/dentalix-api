import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import {
  type BudgetCaller,
  budgetPlan,
  type BudgetVerdict,
  type ClinicQuota,
  type ProviderRatesBudget,
  secondsToWindowEnd,
  windowStart,
} from '../../application/provider-rates-budget';
import {
  PROVIDER_RATES_LIMITS,
  type ProviderRatesLimits,
} from '../../application/provider-rates-gate';
import { EXCHANGE_RATE_CLOCK } from '../../application/use-cases/manual-exchange-rates.use-cases';

/** Un cupo lleno: deshace la transacción para no gastar ninguno. */
class BudgetFull extends Error {
  constructor(readonly verdict: Extract<BudgetVerdict, { spent: false }>) {
    super('provider budget full');
  }
}

/** Instante → `timestamp(3)` en UTC (las horas de la BD no llevan zona). */
const utc = (ms: number) =>
  Prisma.sql`(${new Date(ms).toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * SEC-058: los contadores del presupuesto del proveedor en la BD, los mismos
 * para todas las réplicas (migración 20261106150000_sec058_exchange_provider_budgets).
 * Una transacción por llamada, con `app.current_tenant` de la clínica que
 * gasta: sus cupos en `exchange_provider_clinic_budgets` (RLS: solo los
 * suyos) y después el global con `dx_exchange_provider_spend_global` (la app
 * no tiene privilegios sobre esa tabla). Cada contador es un UPSERT
 * condicional (`… WHERE calls < tope RETURNING calls`): el candado de fila
 * serializa a las réplicas y un cupo lleno deshace los anteriores.
 */
@Injectable()
export class PrismaProviderRatesBudget implements ProviderRatesBudget {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROVIDER_RATES_LIMITS)
    private readonly limits: ProviderRatesLimits,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
  ) {}

  async spend(caller: BudgetCaller): Promise<BudgetVerdict> {
    try {
      return caller.kind === 'PLATFORM'
        ? await this.prisma.$transaction((tx) => this.spendIn(tx, caller, null))
        : await this.prisma.runWithTenant(caller.tenantId, (tx) =>
            this.spendIn(tx, caller, caller.tenantId),
          );
    } catch (error) {
      if (error instanceof BudgetFull) return error.verdict;
      throw error;
    }
  }

  private async spendIn(
    tx: Prisma.TransactionClient,
    caller: BudgetCaller,
    tenantId: string | null,
  ): Promise<BudgetVerdict> {
    const now = this.now();
    const at = now.getTime();
    // `tenants` es global (sin RLS): el alta de la clínica decide si es nueva.
    const createdAt = tenantId
      ? (
          await tx.tenant.findUniqueOrThrow({
            where: { id: tenantId },
            select: { createdAt: true },
          })
        ).createdAt
      : null;
    const plan = budgetPlan(caller, this.limits, createdAt, now);

    const filled: ClinicQuota[] = [];
    for (const quota of plan.clinic) {
      const calls = await this.spendClinic(tx, tenantId!, quota, at);
      if (calls === null) {
        throw new BudgetFull({
          spent: false,
          scope: 'CLINIC',
          quota,
          retryAfterSeconds: secondsToWindowEnd(at, quota.windowMs),
        });
      }
      if (calls === quota.limit) filled.push(quota);
    }

    const [{ calls }] = await tx.$queryRaw<{ calls: number | null }[]>`
      SELECT dx_exchange_provider_spend_global(
        ${utc(windowStart(at, plan.globalWindowMs))}::timestamp(3),
        ${plan.globalCap}::integer
      ) AS calls`;
    if (calls === null) {
      throw new BudgetFull({
        spent: false,
        scope: 'GLOBAL',
        retryAfterSeconds: secondsToWindowEnd(at, plan.globalWindowMs),
      });
    }
    return { spent: true, globalUsed: calls, filled };
  }

  /** Suma una llamada al cupo si cabe; `null` si está lleno. */
  private async spendClinic(
    tx: Prisma.TransactionClient,
    tenantId: string,
    quota: ClinicQuota,
    at: number,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<{ calls: number }[]>`
      INSERT INTO "exchange_provider_clinic_budgets" AS b
        ("tenantId", "quota", "windowStart", "calls")
      VALUES (${tenantId}::uuid, ${quota.kind}, ${utc(windowStart(at, quota.windowMs))}, 1)
      ON CONFLICT ("tenantId", "quota") DO UPDATE
         SET "calls" = CASE WHEN EXCLUDED."windowStart" > b."windowStart"
                            THEN 1 ELSE b."calls" + 1 END,
             "windowStart" = GREATEST(b."windowStart", EXCLUDED."windowStart"),
             "updatedAt" = timezone('UTC', now())
       WHERE EXCLUDED."windowStart" > b."windowStart"
          OR b."calls" < ${quota.limit}::integer
      RETURNING b."calls"`;
    return rows[0]?.calls ?? null;
  }
}
