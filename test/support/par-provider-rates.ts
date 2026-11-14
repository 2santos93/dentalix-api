import type { PrismaClient } from '@prisma/client';
import { addCivilDays, civilDateIn } from '../../src/shared/time/civil-day';

/** Error claro: ya había una tasa de verdad para ese día y moneda. */
export class ParRateConflictError extends Error {
  constructor(date: string, currency: string, rate: string) {
    super(
      `seedParProviderRates: ya hay una tasa de ${currency} para el ${date} (${rate}), no la par: un spec anterior la dejó sin limpiar o la sembró a propósito. Los importes de este spec cambiarían en silencio; bórrala en su spec o no uses la par aquí.`,
    );
    this.name = 'ParRateConflictError';
  }
}

/**
 * DX-513-bis: al añadir un ítem cuya referencia de catálogo está en otra moneda
 * (p. ej. el catálogo en VES de la sede y un plan en USD o EUR), la API la
 * convierte con la tasa de hoy; sin tasa responde 422. Los specs que crean
 * esos ítems sin probar descuentos ni tasas siembran aquí las tasas del
 * proveedor ya «cacheadas» (`exchange_rate_snapshots`, que la clínica en
 * AUTOMATIC lee antes que al proveedor, vacío en la CI) a la PAR (1 unidad por
 * USD): la referencia convertida es la misma cifra y sus importes no cambian.
 *
 * Solo añade las filas que faltan, del día UTC de ayer a mañana (cubre el día
 * de cualquier sede), y devuelve con qué borrarlas: la tabla sobrevive a
 * `resetDatabase`, así que nada se filtra a otros specs. Si ya hay una tasa
 * DISTINTA de la par para ese día y moneda, falla en voz alta
 * (`ParRateConflictError`) en vez de convertir con ella en silencio.
 *
 * OJO, abonos: estas filas son tasas del proveedor de verdad para la API. Un
 * abono en otra moneda registrado esos días en el spec congela la tasa 1
 * (DX-375) en lugar de quedar «sin tasa». Un spec que pruebe abonos en otra
 * moneda de hoy (o «sin tasa») no debe usar este helper, o debe sembrar sus
 * propias tasas antes.
 */
export async function seedParProviderRates(
  raw: PrismaClient,
  currencies: readonly string[] = ['VES', 'EUR', 'GBP'],
): Promise<() => Promise<void>> {
  const today = civilDateIn(new Date(), 'UTC');
  const created: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = addCivilDays(today, offset);
    for (const currency of currencies) {
      const exists = await raw.exchangeRateSnapshot.findUnique({
        where: { date_currency: { date, currency } },
        select: { id: true, rate: true },
      });
      if (exists) {
        if (!exists.rate.equals(1)) {
          throw new ParRateConflictError(
            date,
            currency,
            exists.rate.toString(),
          );
        }
        continue;
      }
      const row = await raw.exchangeRateSnapshot.create({
        data: { date, currency, rate: 1 },
        select: { id: true },
      });
      created.push(row.id);
    }
  }
  return async () => {
    await raw.exchangeRateSnapshot.deleteMany({
      where: { id: { in: created } },
    });
  };
}
