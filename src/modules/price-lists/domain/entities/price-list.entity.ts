/**
 * Lista de precios de la clínica (DX-105): precios de procedimientos pactados
 * para una moneda y, opcionalmente, para una sede. Una sede tiene a lo sumo una
 * lista activa. Desactivarla la saca de la resolución de precios; retirarla
 * (`DELETE`) la quita de la gestión y solo se permite sin convenios vivos que
 * la usen.
 */
export interface PriceList {
  id: string;
  name: string;
  /** Código ISO 4217 de `currencies`. No cambia una vez la lista tiene precios. */
  currency: string;
  /** `null` = toda la clínica. */
  locationId: string | null;
  active: boolean;
  /** Procedimientos con precio en la lista. */
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Una fila del directorio de una lista: el procedimiento y su precio o `null`. */
export interface PriceListItemRow {
  catalogItemId: string;
  code: string;
  labelEs: string;
  category: string | null;
  defaultPrice: number | null;
  /** Precio en esta lista; `null` = sin precio. */
  price: number | null;
}
