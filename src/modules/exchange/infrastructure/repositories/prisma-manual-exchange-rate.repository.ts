import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import {
  latestPerDayAndCurrency,
  type ManualRateRow,
} from '../../domain/manual-rate-fallback';
import type { ManualExchangeRate } from '../../domain/entities/manual-exchange-rate.entity';
import { manualRateIdsOfRef } from '../../domain/exchange-rate-quote';
import {
  ManualExchangeRateAuthorError,
  ManualExchangeRateInUseError,
  ManualExchangeRateNotFoundError,
  ManualExchangeRateTakenError,
  type ManualExchangeRateRepository,
  type ManualRateInForce,
  type NewManualExchangeRate,
} from '../../domain/ports/manual-exchange-rate-repository.port';

const ROW_SELECT = {
  id: true,
  date: true,
  currency: true,
  rate: true,
  effectiveFrom: true,
  createdById: true,
  createdAt: true,
  createdBy: { select: { user: { select: { fullName: true } } } },
} as const;

type Row = Prisma.ManualExchangeRateGetPayload<{ select: typeof ROW_SELECT }>;

/** Día civil ↔ columna DATE: Prisma la lee y escribe como medianoche UTC. */
const toDateColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const fromDateColumn = (value: Date): string =>
  value.toISOString().slice(0, 10);

function mapToEntity(row: Row, inUse: boolean): ManualExchangeRate {
  return {
    id: row.id,
    date: fromDateColumn(row.date),
    currency: row.currency,
    rate: row.rate.toNumber(),
    effectiveFrom: row.effectiveFrom,
    createdBy: {
      userId: row.createdById,
      fullName: row.createdBy.user.fullName,
    },
    createdAt: row.createdAt,
    inUse,
  };
}

/**
 * DX-375: qué tasas manuales de entre los días `days` ya congeló algún abono
 * de la clínica. DX-586: un abono con referencia usa exactamente las que
 * nombra (`MANUAL:<id>`); uno sin referencia (anterior a DX-586) usa las de
 * su día con su moneda o su moneda de destino, como antes. Mismo criterio
 * que el trigger manual_exchange_rates_in_use_guard; filtra por el índice
 * parcial payments_exchange_rate_manual_idx.
 */
async function usedRates(
  tx: Prisma.TransactionClient,
  tenantId: string,
  days: string[],
): Promise<(row: { id: string; date: string; currency: string }) => boolean> {
  if (days.length === 0) return () => false;
  const rows = await tx.$queryRaw<
    { day: string; currency: string; ref: string | null }[]
  >`
    SELECT DISTINCT to_char(p."exchangeRateDate", 'YYYY-MM-DD') AS "day",
           c."currency", p."exchangeRateRef" AS "ref"
      FROM "payments" p
      CROSS JOIN LATERAL (VALUES (p."currency"), (p."exchangeRateCurrency")) AS c("currency")
     WHERE p."tenantId" = ${tenantId}::uuid
       AND p."exchangeRateSource" = 'MANUAL'::"ExchangeRateSource"
       AND p."exchangeRateDate" = ANY (${days}::date[])`;
  const legacy = new Set<string>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.ref === null) legacy.add(`${row.day}|${row.currency}`);
    for (const id of manualRateIdsOfRef(row.ref)) ids.add(id);
  }
  return (rate) =>
    ids.has(rate.id.toLowerCase()) ||
    legacy.has(`${rate.date}|${rate.currency}`);
}

/**
 * `manual_exchange_rates` es tabla de clínica con RLS FORCE: todo va por
 * `runWithTenant` con el tenant del contexto, y además con `tenantId`
 * explícito en el `where` (defensa en profundidad, como el resto).
 */
@Injectable()
export class PrismaManualExchangeRateRepository implements ManualExchangeRateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async ratesOn(
    date: string,
    asOf: Date,
  ): Promise<Record<string, ManualRateInForce>> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.manualExchangeRate.findMany({
        where: {
          tenantId,
          date: toDateColumn(date),
          effectiveFrom: { lte: asOf },
        },
        orderBy: [{ currency: 'asc' }, { effectiveFrom: 'asc' }],
        select: { id: true, currency: true, rate: true, effectiveFrom: true },
      }),
    );
    // Ordenadas por hora: la última de cada moneda es la que rige.
    const rates: Record<string, ManualRateInForce> = {};
    for (const row of rows) {
      rates[row.currency] = {
        id: row.id,
        rate: row.rate.toNumber(),
        effectiveFrom: row.effectiveFrom,
      };
    }
    return rates;
  }

  async ratesBetween(
    from: string,
    to: string,
    currencies: readonly string[] | undefined,
    asOf: Date,
  ): Promise<ManualRateRow[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.manualExchangeRate.findMany({
        where: {
          tenantId,
          date: { gte: toDateColumn(from), lte: toDateColumn(to) },
          effectiveFrom: { lte: asOf },
          ...(currencies ? { currency: { in: [...currencies] } } : {}),
        },
        select: {
          id: true,
          date: true,
          currency: true,
          rate: true,
          effectiveFrom: true,
        },
      }),
    );
    return latestPerDayAndCurrency(
      rows.map((row) => ({
        id: row.id,
        date: fromDateColumn(row.date),
        currency: row.currency,
        rate: row.rate.toNumber(),
        effectiveFrom: row.effectiveFrom,
      })),
    );
  }

  async listRecent(limit: number): Promise<ManualExchangeRate[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const rows = await tx.manualExchangeRate.findMany({
        where: { tenantId },
        orderBy: [
          { date: 'desc' },
          { currency: 'asc' },
          { effectiveFrom: 'desc' },
        ],
        take: limit,
        select: ROW_SELECT,
      });
      return this.withUse(tx, tenantId, rows);
    });
  }

  async listDay(date: string): Promise<ManualExchangeRate[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      const rows = await tx.manualExchangeRate.findMany({
        where: { tenantId, date: toDateColumn(date) },
        orderBy: [{ currency: 'asc' }, { effectiveFrom: 'asc' }],
        select: ROW_SELECT,
      });
      return this.withUse(tx, tenantId, rows);
    });
  }

  private async withUse(
    tx: Prisma.TransactionClient,
    tenantId: string,
    rows: Row[],
  ): Promise<ManualExchangeRate[]> {
    const inUse = await usedRates(tx, tenantId, [
      ...new Set(rows.map((r) => fromDateColumn(r.date))),
    ]);
    return rows.map((row) =>
      mapToEntity(
        row,
        inUse({
          id: row.id,
          date: fromDateColumn(row.date),
          currency: row.currency,
        }),
      ),
    );
  }

  async create(input: NewManualExchangeRate): Promise<ManualExchangeRate> {
    const tenantId = this.tenantId();
    try {
      const row = await this.prisma.runWithTenant(tenantId, async (tx) => {
        // La FK compuesta exige la membresía del autor en ESTA clínica; se
        // busca la viva (un acceso de soporte no tiene ninguna).
        const membership = await tx.clinicMembership.findFirst({
          where: { tenantId, userId: input.createdById, deletedAt: null },
          select: { id: true },
        });
        if (!membership) throw new ManualExchangeRateAuthorError();
        return tx.manualExchangeRate.create({
          data: {
            tenantId,
            date: toDateColumn(input.date),
            currency: input.currency,
            rate: new Prisma.Decimal(input.rate),
            effectiveFrom: input.effectiveFrom,
            createdById: input.createdById,
            createdByMembershipId: membership.id,
          },
          select: ROW_SELECT,
        });
      });
      return mapToEntity(row, false);
    } catch (error) {
      // Única violación posible (DX-586): (tenant, moneda, desde), también
      // con dos altas a la vez.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ManualExchangeRateTakenError();
      }
      throw error;
    }
  }

  async correct(id: string, rate: number): Promise<ManualExchangeRate> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      // FOR UPDATE: un abono que la está congelando la tiene FOR SHARE; o
      // termina antes (y aquí se ve) o espera y ya no la encuentra igual.
      const [locked] = await tx.$queryRaw<{ date: string; currency: string }[]>`
        SELECT to_char("date", 'YYYY-MM-DD') AS "date", "currency"
          FROM "manual_exchange_rates"
         WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${id}::uuid
           FOR UPDATE`;
      if (!locked) throw new ManualExchangeRateNotFoundError();
      const inUse = await usedRates(tx, tenantId, [locked.date]);
      if (inUse({ id, date: locked.date, currency: locked.currency })) {
        throw new ManualExchangeRateInUseError();
      }
      const row = await tx.manualExchangeRate.update({
        where: { id, tenantId },
        data: { rate: new Prisma.Decimal(rate) },
        select: ROW_SELECT,
      });
      return mapToEntity(row, false);
    });
  }

  async isKnownCurrency(code: string): Promise<boolean> {
    // `currencies` es GLOBAL (sin tenant): sin runWithTenant.
    const found = await this.prisma.currency.findUnique({
      where: { code },
      select: { code: true },
    });
    return found !== null;
  }

  async referenceTimeZone(): Promise<string> {
    const tenantId = this.tenantId();
    const location = await this.prisma.runWithTenant(tenantId, (tx) =>
      resolveReferenceLocation(
        tx,
        tenantId,
        this.tenantContext.getLocationId() ?? null,
      ),
    );
    return location.timeZone;
  }
}
