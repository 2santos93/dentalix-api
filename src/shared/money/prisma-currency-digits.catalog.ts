import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrencyDigitsCatalog, CurrencyDigitsTable } from './currency-digits';

/**
 * `currencies` es una tabla de referencia global (~150 filas) que solo cambia
 * con una migración: se lee una vez por proceso. Si se pide una moneda que no
 * estaba (alta posterior), se vuelve a leer una vez antes de dar error.
 */
@Injectable()
export class PrismaCurrencyDigitsCatalog implements CurrencyDigitsCatalog {
  private cached: Promise<CurrencyDigitsTable> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async table(codes: readonly string[] = []): Promise<CurrencyDigitsTable> {
    const table = await (this.cached ??= this.load());
    if (codes.every((code) => table.has(code))) return table;
    this.cached = this.load();
    return this.cached;
  }

  private async load(): Promise<CurrencyDigitsTable> {
    try {
      const rows = await this.prisma.currency.findMany({
        select: { code: true, minorUnits: true, roundingDigits: true },
      });
      return new CurrencyDigitsTable(rows);
    } catch (error) {
      this.cached = null;
      throw error;
    }
  }
}
