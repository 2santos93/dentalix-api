import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ExchangeRateSnapshot } from '../../domain/entities/exchange-rate-snapshot.entity';
import { ExchangeRateRepository } from '../../domain/ports/exchange-rate-repository.port';

type PrismaExchangeRateSnapshot = Prisma.ExchangeRateSnapshotGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaExchangeRateSnapshot): ExchangeRateSnapshot {
  return {
    id: row.id,
    date: row.date,
    currency: row.currency,
    rate: row.rate.toNumber(),
    fetchedAt: row.fetchedAt,
  };
}

/**
 * `exchange_rate_snapshots` is a global reference-data table (NO tenantId,
 * NO RLS, NO soft-delete — see schema comment + multi-tenancy rule's
 * technical exception). It is queried directly through the plain
 * `PrismaClient` methods `PrismaService` inherits — deliberately NOT via
 * `runWithTenant`, since there is no tenant to scope by.
 */
@Injectable()
export class PrismaExchangeRateRepository implements ExchangeRateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByDate(date: string): Promise<ExchangeRateSnapshot[]> {
    const rows = await this.prisma.exchangeRateSnapshot.findMany({
      where: { date },
    });
    return rows.map(mapToEntity);
  }

  async upsertMany(date: string, rates: Record<string, number>): Promise<void> {
    const fetchedAt = new Date();
    const entries = Object.entries(rates);
    if (entries.length === 0) {
      return;
    }

    // One upsert per (date, currency) pair, batched in a single transaction
    // so a partial failure doesn't leave a half-written snapshot for the
    // day. Idempotent by construction: re-running for the same date/rates
    // updates rate + fetchedAt on the existing row instead of duplicating it
    // (`@@unique([date, currency])`).
    await this.prisma.$transaction(
      entries.map(([currency, rate]) =>
        this.prisma.exchangeRateSnapshot.upsert({
          where: { date_currency: { date, currency } },
          update: { rate, fetchedAt },
          create: { date, currency, rate },
        }),
      ),
    );
  }
}
