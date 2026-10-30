import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CountryWhitelist } from '../../domain/ports/country-whitelist.port';

// `countries` is a GLOBAL (not tenant-scoped) table — reads via `prisma`
// directly, never `runWithTenant`, same rationale as PrismaCurrencyWhitelist.
@Injectable()
export class PrismaCountryWhitelist implements CountryWhitelist {
  constructor(private readonly prisma: PrismaService) {}

  async has(code: string): Promise<boolean> {
    const found = await this.prisma.country.findUnique({
      where: { code },
      select: { code: true },
    });
    return found !== null;
  }
}
