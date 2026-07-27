import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

// `currencies` is a GLOBAL (not tenant-scoped) table — reads via `prisma`
// directly, never `runWithTenant`, same rationale as PrismaReferenceLookup
// reading `city`/`country` (patients module).
@Injectable()
export class PrismaCurrencyWhitelist implements CurrencyWhitelist {
  constructor(private readonly prisma: PrismaService) {}

  async has(code: string): Promise<boolean> {
    const found = await this.prisma.currency.findUnique({
      where: { code: code.toUpperCase() },
      select: { code: true },
    });
    return found !== null;
  }
}
