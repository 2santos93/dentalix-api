import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    const where: Prisma.CityWhereInput = { countryCode };
    if (q && q.trim() !== '') {
      where.name = { contains: q.trim(), mode: 'insensitive' };
    }
    return this.prisma.city.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit,
      select: { id: true, name: true, region: true },
    });
  }
}
