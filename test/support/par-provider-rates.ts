import type { PrismaClient } from '@prisma/client';
import { addCivilDays, civilDateIn } from '../../src/shared/time/civil-day';

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
 * `resetDatabase`, así que nada se filtra a otros specs.
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
        select: { id: true },
      });
      if (exists) continue;
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
