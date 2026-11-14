/**
 * DX-502-ter: la moneda del catálogo de la clínica, para quien lee el catálogo.
 * `tenants.catalogCurrency` si la fijó la clínica; si no, la común de sus sedes
 * activas (`clinicCatalogCurrency`); `null` si no se sabe. Es un dato de toda la
 * clínica (no depende de la sede ni del rol), el mismo que ya ven el presupuesto
 * y el plan.
 */
export interface CatalogCurrencyReader {
  current(): Promise<string | null>;
}

export const CATALOG_CURRENCY_READER = Symbol('CATALOG_CURRENCY_READER');
