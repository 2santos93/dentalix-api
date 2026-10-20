import { PriceList, PriceListItemRow } from '../entities/price-list.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreatePriceListRepoInput {
  name: string;
  currency: string;
  locationId: string | null;
  active: boolean;
  createdById?: string;
}

export interface UpdatePriceListRepoInput {
  name?: string;
  currency?: string;
  locationId?: string | null;
  active?: boolean;
  updatedById?: string;
}

export type RetirePriceListResult = 'RETIRED' | 'IN_USE' | 'NOT_FOUND';

export interface PriceListItemsDirectoryParams {
  query?: string;
  /** Filas a saltar. Ya normalizado por el caso de uso. */
  skip: number;
  /** Filas a devolver. Ya acotado por el caso de uso. */
  take: number;
}

export interface PriceListItemsDirectoryPage {
  items: PriceListItemRow[];
  /** Total que casa con la búsqueda, no el del catálogo. */
  total: number;
}

export interface PriceListItemInput {
  catalogItemId: string;
  /** `null` borra el precio de la lista. */
  price: number | null;
}

export interface ReplacePriceListItemsResult {
  upserted: number;
  removed: number;
}

export const PRICE_LIST_REPOSITORY = Symbol('PRICE_LIST_REPOSITORY');

export interface PriceListRepository {
  /** Listas vivas (no retiradas) de la clínica en contexto, por nombre. */
  list(params: { includeInactive: boolean }): Promise<PriceList[]>;
  /**
   * Lista viva por id, activa o no. Bajo RLS: una de otra clínica (o retirada)
   * da `null`, igual que una inexistente.
   */
  findById(id: string): Promise<PriceList | null>;
  /**
   * Otra lista viva cuyo nombre normalizado (`priceListNameKey`, igual que
   * `dx_search_normalize`) coincide. `excludeId` deja fuera a la propia lista
   * al renombrar.
   */
  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<PriceList | null>;
  /**
   * La lista activa y viva de esa sede, si hay. `excludeId` deja fuera a la
   * propia lista al editarla.
   */
  findActiveByLocation(
    locationId: string,
    excludeId?: string,
  ): Promise<PriceList | null>;
  create(input: CreatePriceListRepoInput): Promise<PriceList>;
  /** `null` si la lista ya no existe (retirada entre la lectura y la escritura). */
  update(
    id: string,
    patch: UpdatePriceListRepoInput,
  ): Promise<PriceList | null>;
  /**
   * Retira la lista (`deletedAt` y `active = false`) si ningún convenio vivo la
   * usa. Recuento y retiro van en UNA transacción con la lista bloqueada.
   */
  retire(id: string, updatedById?: string): Promise<RetirePriceListResult>;
  /**
   * Procedimientos activos del catálogo (`PROCEDURE`) con el precio que tienen
   * en la lista (`LEFT JOIN`) o `null`, por código. Cuenta y página en la misma
   * transacción.
   */
  listItemsDirectory(
    id: string,
    params: PriceListItemsDirectoryParams,
  ): Promise<PriceListItemsDirectoryPage>;
  /**
   * Lote en UNA transacción: `upsert` por fila con precio y borrado de las de
   * `price: null`. Un fallo no deja nada escrito.
   */
  replaceItems(
    id: string,
    rows: PriceListItemInput[],
  ): Promise<ReplacePriceListItemsResult>;
  /**
   * Precio del procedimiento en la lista, o `null` si no tiene (o la lista no
   * es de la clínica). Lo usa la resolución de precios del plan (DX-105).
   */
  priceFor(listId: string, catalogItemId: string): Promise<number | null>;
  /**
   * La lista activa y viva de la sede con su moneda, o `null`. Lo usa la
   * resolución de precios del plan (DX-105).
   */
  activeListForLocation(
    locationId: string,
  ): Promise<{ id: string; currency: string } | null>;
}
