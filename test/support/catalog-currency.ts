import type { PrismaClient } from '@prisma/client';

/**
 * DX-513-bis: fija la moneda del catálogo de una clínica (DX-502-bis) con una
 * escritura directa (sin auditoría ni otros efectos), para los specs que dan de
 * alta ítems de catálogo en planes en otra moneda que la de su sede sin probar
 * conversiones. Con el catálogo en la moneda del plan, la referencia del ítem
 * está en esa moneda: no hace falta tasa (nunca 422) y el precio por defecto es
 * el `defaultPrice` de siempre, así que los importes del spec no cambian. Los
 * abonos no se tocan (no siembra ninguna tasa).
 *
 * Solo vale para los ítems que se den de alta DESPUÉS (la moneda se congela en
 * cada ítem). Un plan en otra moneda que la fijada vuelve a necesitar tasa.
 */
export async function pinCatalogCurrency(
  raw: PrismaClient,
  tenantId: string,
  currency: string,
): Promise<void> {
  await raw.tenant.update({
    where: { id: tenantId },
    data: { catalogCurrency: currency },
  });
}
