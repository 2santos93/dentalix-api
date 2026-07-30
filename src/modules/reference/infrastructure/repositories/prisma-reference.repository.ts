import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ReferenceRepository } from '../../domain/ports/reference-repository.port';
import { Currency } from '../../domain/entities/currency.entity';
import { Country } from '../../domain/entities/country.entity';
import { City } from '../../domain/entities/city.entity';

@Injectable()
export class PrismaReferenceRepository implements ReferenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  listCurrencies(): Promise<Currency[]> {
    return this.prisma.currency.findMany({ orderBy: { code: 'asc' } });
  }

  listCountries(): Promise<Country[]> {
    return this.prisma.country.findMany({
      orderBy: { name: 'asc' },
      select: { code: true, name: true },
    });
  }

  async searchCities(
    countryCode: string,
    q: string | undefined,
    limit: number,
  ): Promise<City[]> {
    const term = q?.trim();
    if (!term) {
      return this.prisma.city.findMany({
        where: { countryCode },
        orderBy: { name: 'asc' },
        take: limit,
        select: { id: true, name: true, region: true },
      });
    }
    // Accent-insensitive (and case-insensitive) match so "medellin" finds
    // "Medellín". Prisma's `mode: 'insensitive'` only folds case, not accents,
    // so we drop to a raw query using the `unaccent` extension (enabled by the
    // 20260729000000_enable_unaccent migration). ILIKE wildcards in the user
    // input are escaped so the term matches literally, matching the previous
    // `contains` semantics.
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    return this.prisma.$queryRaw<City[]>`
      SELECT id, name, region
      FROM cities
      WHERE "countryCode" = ${countryCode}
        AND unaccent(name) ILIKE unaccent(${pattern})
      ORDER BY name ASC
      LIMIT ${limit}
    `;
  }
}
