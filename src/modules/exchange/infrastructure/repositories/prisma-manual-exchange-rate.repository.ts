import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveReferenceLocation } from '../../../../shared/locations/reference-location';
import type { ManualExchangeRate } from '../../domain/entities/manual-exchange-rate.entity';
import {
  ManualExchangeRateAuthorError,
  ManualExchangeRateTakenError,
  type ManualExchangeRateRepository,
  type NewManualExchangeRate,
} from '../../domain/ports/manual-exchange-rate-repository.port';

const ROW_SELECT = {
  id: true,
  date: true,
  currency: true,
  rate: true,
  createdById: true,
  createdAt: true,
  createdBy: { select: { user: { select: { fullName: true } } } },
} as const;

type Row = Prisma.ManualExchangeRateGetPayload<{ select: typeof ROW_SELECT }>;

/** Día civil ↔ columna DATE: Prisma la lee y escribe como medianoche UTC. */
const toDateColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const fromDateColumn = (value: Date): string =>
  value.toISOString().slice(0, 10);

function mapToEntity(row: Row): ManualExchangeRate {
  return {
    id: row.id,
    date: fromDateColumn(row.date),
    currency: row.currency,
    rate: row.rate.toNumber(),
    createdBy: {
      userId: row.createdById,
      fullName: row.createdBy.user.fullName,
    },
    createdAt: row.createdAt,
  };
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

  async ratesOn(date: string): Promise<Record<string, number>> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.manualExchangeRate.findMany({
        where: { tenantId, date: toDateColumn(date) },
        select: { currency: true, rate: true },
      }),
    );
    const rates: Record<string, number> = {};
    for (const row of rows) rates[row.currency] = row.rate.toNumber();
    return rates;
  }

  async listRecent(limit: number): Promise<ManualExchangeRate[]> {
    const tenantId = this.tenantId();
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.manualExchangeRate.findMany({
        where: { tenantId },
        orderBy: [{ date: 'desc' }, { currency: 'asc' }],
        take: limit,
        select: ROW_SELECT,
      }),
    );
    return rows.map(mapToEntity);
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
            createdById: input.createdById,
            createdByMembershipId: membership.id,
          },
          select: ROW_SELECT,
        });
      });
      return mapToEntity(row);
    } catch (error) {
      // Única violación posible: (tenant, día, moneda), también con dos
      // altas a la vez.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ManualExchangeRateTakenError();
      }
      throw error;
    }
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
