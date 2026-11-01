/**
 * DX-502: la moneda del catálogo de la clínica. `defaultPrice` no lleva
 * moneda; es la común de las sedes ACTIVAS (la misma regla con que la web
 * pinta Ajustes › Catálogo). Con sedes en monedas distintas, alguna sin
 * moneda o ninguna sede activa, no se sabe: `null`, nunca otra en su lugar.
 * Se calcula con TODAS las sedes de la clínica, no solo las del miembro: un
 * usuario restringido a una sede no ve otra moneda del catálogo. La
 * migración `dx502_plan_item_catalog_currency` repite esta regla en SQL.
 */
export function catalogCurrencyOf(
  activeLocations: readonly { currency: string | null }[],
): string | null {
  const currencies = new Set(activeLocations.map((l) => l.currency));
  if (currencies.size !== 1) return null;
  const [only] = currencies;
  return only ?? null;
}
