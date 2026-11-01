import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrencyDigitsCatalog, CurrencyDigitsTable } from './currency-digits';

/** Cuánto vale una lectura de `currencies` antes de volver a leerla. */
export const CURRENCY_DIGITS_TTL_MS = 5 * 60 * 1000;

/**
 * `currencies` es una tabla de referencia global (~150 filas) que solo cambia
 * con una migración de datos: se lee entera y se guarda en memoria
 * `CURRENCY_DIGITS_TTL_MS` (5 min). Así un cambio de `rounding_digits` llega a
 * todas las réplicas sin reiniciarlas, como mucho 5 minutos después. Si se
 * pide una moneda que no estaba (alta posterior), se relee en el acto.
 */
@Injectable()
export class PrismaCurrencyDigitsCatalog implements CurrencyDigitsCatalog {
  private cached: Promise<CurrencyDigitsTable> | null = null;
  private loadedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async table(codes: readonly string[] = []): Promise<CurrencyDigitsTable> {
    const fresh =
      this.cached && Date.now() - this.loadedAt < CURRENCY_DIGITS_TTL_MS;
    const table = await (fresh && this.cached ? this.cached : this.reload());
    if (codes.every((code) => table.has(code))) return table;
    return this.reload();
  }

  private reload(): Promise<CurrencyDigitsTable> {
    this.loadedAt = Date.now();
    const loading = this.load();
    this.cached = loading;
    // Un fallo no se queda en caché: la siguiente llamada vuelve a leer.
    loading.catch(() => {
      if (this.cached === loading) this.cached = null;
    });
    return loading;
  }

  private async load(): Promise<CurrencyDigitsTable> {
    const rows = await this.prisma.currency.findMany({
      select: { code: true, minorUnits: true, roundingDigits: true },
    });
    return new CurrencyDigitsTable(rows);
  }
}
