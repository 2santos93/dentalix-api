import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import type { BcvRateSnapshot } from '../../domain/bcv-rate';
import type { BcvRateRepository } from '../../domain/ports/bcv-rate-repository.port';

type Row = Prisma.BcvRateSnapshotGetPayload<Record<string, never>>;

/** Día civil ↔ columna DATE: Prisma la lee y escribe como medianoche UTC. */
const toDateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);

function toSnapshot(row: Row): BcvRateSnapshot {
  return {
    valueDate: row.valueDate.toISOString().slice(0, 10),
    usdVes: row.usdVes.toNumber(),
    eurVes: row.eurVes.toNumber(),
    fetchedAt: row.fetchedAt,
    origin: row.origin === 'FALLBACK' ? 'FALLBACK' : 'BCV',
  };
}

/**
 * DX-585: `bcv_rate_snapshots` es una tabla de referencia GLOBAL (sin
 * tenantId ni RLS), como `exchange_rate_snapshots`: se consulta con los
 * métodos de `PrismaService`, nunca con `runWithTenant`.
 */
@Injectable()
export class PrismaBcvRateRepository implements BcvRateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async inForce(date: string, oldest: string): Promise<BcvRateSnapshot | null> {
    const row = await this.prisma.bcvRateSnapshot.findFirst({
      where: {
        valueDate: { lte: toDateColumn(date), gte: toDateColumn(oldest) },
      },
      orderBy: { valueDate: 'desc' },
    });
    return row ? toSnapshot(row) : null;
  }

  async latestUpTo(valueDate: string): Promise<BcvRateSnapshot | null> {
    const row = await this.prisma.bcvRateSnapshot.findFirst({
      where: { valueDate: { lte: toDateColumn(valueDate) } },
      orderBy: { valueDate: 'desc' },
    });
    return row ? toSnapshot(row) : null;
  }

  async latest(): Promise<BcvRateSnapshot | null> {
    const row = await this.prisma.bcvRateSnapshot.findFirst({
      orderBy: { valueDate: 'desc' },
    });
    return row ? toSnapshot(row) : null;
  }

  async upsert(snapshot: BcvRateSnapshot): Promise<void> {
    const data = {
      usdVes: new Prisma.Decimal(snapshot.usdVes),
      eurVes: new Prisma.Decimal(snapshot.eurVes),
      fetchedAt: snapshot.fetchedAt,
      origin: snapshot.origin,
    };
    await this.prisma.bcvRateSnapshot.upsert({
      where: { valueDate: toDateColumn(snapshot.valueDate) },
      create: { valueDate: toDateColumn(snapshot.valueDate), ...data },
      update: data,
    });
  }
}
