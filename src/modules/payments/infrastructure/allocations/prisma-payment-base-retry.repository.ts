import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  frozenRateOf,
  type FrozenRateColumns,
} from '../repositories/frozen-exchange-rate.mapper';
import type {
  PaymentBaseBacklog,
  PaymentBaseRetryCandidate,
  PaymentBaseRetryFailure,
  PaymentBaseRetryRepository,
} from '../../domain/ports/payment-base-retry-repository.port';

/** Hora UTC de la BD: las columnas son `timestamp(3)` sin zona, en UTC. */
const NOW = Prisma.sql`timezone('UTC', now())`;

/**
 * `payment_base_retries` (DX-380), RLS FORCE: todo en la clínica del
 * contexto con `tenantId` explícito, salvo `dueTenantIds`, que llama a la
 * función del barrido (SECURITY INVOKER: recorre las clínicas fijando su
 * tenant, así que solo lee lo de cada una) en una sola sentencia.
 */
@Injectable()
export class PrismaPaymentBaseRetryRepository implements PaymentBaseRetryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async dueTenantIds(): Promise<string[]> {
    // Fuera de una transacción de la app: el set_config local de la función
    // muere con la transacción implícita de la sentencia.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t AS "id" FROM dx_payment_allocation_sweep_tenants() AS t`;
    return rows.map((r) => r.id);
  }

  async due(limit: number): Promise<PaymentBaseRetryCandidate[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // El orden es el del índice payment_base_retries_due_idx.
      const rows = await tx.$queryRaw<
        ({
          paymentId: string;
          attempts: number;
          amount: Prisma.Decimal;
          currency: string;
          paidAt: Date;
          locationId: string;
          voided: boolean;
          targetCurrency: string | null;
          planCurrency: string | null;
          hasBase: boolean;
        } & FrozenRateColumns)[]
      >`
        SELECT r."paymentId", r."attempts",
               p."amount", p."currency", p."paidAt", p."locationId",
               p."deletedAt" IS NOT NULL AS "voided",
               p."exchangeRateCurrency", p."exchangeRateFrom",
               p."exchangeRateTo", p."exchangeRateSource", p."exchangeRateDate",
               COALESCE(t."currency", o."currency") AS "targetCurrency",
               CASE WHEN t."deletedAt" IS NULL THEN t."currency" END AS "planCurrency",
               EXISTS (
                 SELECT 1 FROM "payment_plan_amounts" b
                  WHERE b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
               ) AS "hasBase"
          FROM "payment_base_retries" r
          JOIN "payments" p
            ON p."tenantId" = r."tenantId" AND p."id" = r."paymentId"
          LEFT JOIN "treatment_plans" t
            ON t."tenantId" = p."tenantId" AND t."id" = p."treatmentPlanId"
          LEFT JOIN "opening_balances" o
            ON o."tenantId" = p."tenantId" AND o."id" = p."openingBalanceId"
         WHERE r."tenantId" = ${tenantId}::uuid
           AND r."nextAttemptAt" <= ${NOW}
         ORDER BY r."nextAttemptAt", r."paymentId"
         LIMIT ${limit}::int`;
      if (rows.length === 0) return [];
      // DX-097: la fecha de la tasa es el día civil del abono en SU sede.
      const zoneOf = await resolveLocationTimeZones(
        tx,
        tenantId,
        rows.map((r) => r.locationId),
      );
      return rows.map((r) => ({
        paymentId: r.paymentId,
        attempts: r.attempts,
        live: !r.voided && r.targetCurrency !== null,
        amount: Number(r.amount),
        currency: r.currency,
        paidOn: civilDateIn(r.paidAt, zoneOf(r.locationId)),
        targetCurrency: r.targetCurrency ?? r.currency,
        planCurrency: r.planCurrency,
        hasBase: r.hasBase,
        exchangeRateCurrency: r.exchangeRateCurrency,
        frozenRate: frozenRateOf(r),
      }));
    });
  }

  async resolve(paymentId: string): Promise<void> {
    const tenantId = this.requireTenantId();
    // Borrado duro legítimo: la fila es estado operativo del reintento, no
    // dato de negocio (el abono y su base quedan).
    await this.prisma.runWithTenant(
      (tx) => tx.$executeRaw`
        DELETE FROM "payment_base_retries"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "paymentId" = ${paymentId}::uuid`,
    );
  }

  async postpone(
    paymentId: string,
    failure: PaymentBaseRetryFailure,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(
      (tx) => tx.$executeRaw`
        UPDATE "payment_base_retries"
           SET "attempts" = ${failure.attempts}::int,
               "lastReason" = ${failure.reason}::"PaymentBaseRetryReason",
               "nextAttemptAt" = ${NOW} + make_interval(secs => ${failure.delayMs / 1000}::float8),
               "updatedAt" = ${NOW}
         WHERE "tenantId" = ${tenantId}::uuid
           AND "paymentId" = ${paymentId}::uuid`,
    );
  }

  wake(): Promise<number> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(
      (tx) => tx.$executeRaw`
        UPDATE "payment_base_retries"
           SET "nextAttemptAt" = ${NOW}, "updatedAt" = ${NOW}
         WHERE "tenantId" = ${tenantId}::uuid
           AND "nextAttemptAt" > ${NOW}`,
    );
  }

  async backlog(olderThanHours: number): Promise<PaymentBaseBacklog> {
    const tenantId = this.requireTenantId();
    const [row] = await this.prisma.runWithTenant(
      (tx) => tx.$queryRaw<{ count: number; oldestSince: Date | null }[]>`
        SELECT count(*)::int AS "count", min(r."createdAt") AS "oldestSince"
          FROM "payment_base_retries" r
          JOIN "payments" p
            ON p."tenantId" = r."tenantId" AND p."id" = r."paymentId"
         WHERE r."tenantId" = ${tenantId}::uuid
           AND p."deletedAt" IS NULL
           AND r."createdAt" <= ${NOW} - make_interval(hours => ${olderThanHours}::int)`,
    );
    return { count: row.count, oldestSince: row.oldestSince };
  }
}
