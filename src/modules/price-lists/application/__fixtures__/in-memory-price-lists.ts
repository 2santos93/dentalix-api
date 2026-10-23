import {
  PriceList,
  PriceListItemRow,
} from '../../domain/entities/price-list.entity';
import {
  CreatePriceListRepoInput,
  PriceListItemInput,
  PriceListItemsDirectoryPage,
  PriceListItemsDirectoryParams,
  PriceListRepository,
  ReplacePriceListItemsResult,
  RetirePriceListResult,
  UpdatePriceListRepoInput,
} from '../../domain/ports/price-list-repository.port';
import { priceListNameKey } from '../../domain/price-list-rules';

/**
 * Repositorio de listas de precios en memoria con estado: los tests afirman
 * sobre `rows` y `prices` igual que un e2e lo haría sobre las tablas.
 * `deleted` guarda las retiradas y `liveAgreements` los convenios vivos por
 * lista. `catalog` hace de directorio de procedimientos.
 */
export class InMemoryPriceListRepository implements PriceListRepository {
  readonly rows: PriceList[] = [];
  readonly deleted = new Set<string>();
  readonly liveAgreements = new Map<string, number>();
  /** `listId -> catalogItemId -> price` */
  readonly prices = new Map<string, Map<string, number>>();
  readonly catalog: Omit<PriceListItemRow, 'price'>[] = [];
  replaceCalls = 0;
  private nextId = 1;

  seed(partial: Partial<PriceList> = {}): PriceList {
    const row: PriceList = {
      id: `list-${this.nextId++}`,
      name: 'Lista base',
      currency: 'COP',
      locationId: null,
      active: true,
      itemCount: 0,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  /** Precio ya cargado en una lista, con `itemCount` al día. */
  seedPrice(listId: string, catalogItemId: string, price: number): void {
    const map = this.prices.get(listId) ?? new Map<string, number>();
    map.set(catalogItemId, price);
    this.prices.set(listId, map);
    this.syncCount(listId);
  }

  private syncCount(listId: string): void {
    const row = this.rows.find((r) => r.id === listId);
    if (row) row.itemCount = this.prices.get(listId)?.size ?? 0;
  }

  private live(): PriceList[] {
    return this.rows.filter((r) => !this.deleted.has(r.id));
  }

  list(params: { includeInactive: boolean }): Promise<PriceList[]> {
    return Promise.resolve(
      this.live()
        .filter((r) => params.includeInactive || r.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<PriceList | null> {
    const row = this.live().find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<PriceList | null> {
    const row = this.live().find(
      (r) => r.id !== excludeId && priceListNameKey(r.name) === nameKey,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  findActiveByLocation(
    locationId: string,
    excludeId?: string,
  ): Promise<PriceList | null> {
    const row = this.live().find(
      (r) => r.id !== excludeId && r.active && r.locationId === locationId,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  create(input: CreatePriceListRepoInput): Promise<PriceList> {
    return Promise.resolve(
      this.seed({
        name: input.name,
        currency: input.currency,
        locationId: input.locationId,
        active: input.active,
      }),
    );
  }

  update(
    id: string,
    patch: UpdatePriceListRepoInput,
  ): Promise<PriceList | null> {
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.resolve(null);
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.currency !== undefined) row.currency = patch.currency;
    if (patch.locationId !== undefined) row.locationId = patch.locationId;
    if (patch.active !== undefined) row.active = patch.active;
    return Promise.resolve({ ...row });
  }

  retire(id: string): Promise<RetirePriceListResult> {
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.resolve('NOT_FOUND');
    if ((this.liveAgreements.get(id) ?? 0) > 0)
      return Promise.resolve('IN_USE');
    this.deleted.add(id);
    row.active = false;
    return Promise.resolve('RETIRED');
  }

  listItemsDirectory(
    id: string,
    params: PriceListItemsDirectoryParams,
  ): Promise<PriceListItemsDirectoryPage> {
    const needle = params.query?.toLowerCase();
    const matching = this.catalog
      .filter(
        (c) =>
          !needle ||
          c.code.toLowerCase().includes(needle) ||
          c.labelEs.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.code.localeCompare(b.code));
    const items = matching
      .slice(params.skip, params.skip + params.take)
      .map((c) => ({
        ...c,
        price: this.prices.get(id)?.get(c.catalogItemId) ?? null,
      }));
    return Promise.resolve({ items, total: matching.length });
  }

  replaceItems(
    id: string,
    rows: PriceListItemInput[],
  ): Promise<ReplacePriceListItemsResult> {
    this.replaceCalls += 1;
    let map = new Map(this.prices.get(id) ?? []);
    let upserted = 0;
    let removed = 0;
    for (const row of rows) {
      if (row.price === null) {
        if (map.has(row.catalogItemId)) removed += 1;
        // Se reconstruye sin la clave: la regla de borrado duro marca `.delete(`
        // también en un Map, donde no aplica y no merece una excepción.
        map = new Map([...map].filter(([key]) => key !== row.catalogItemId));
      } else {
        map.set(row.catalogItemId, row.price);
        upserted += 1;
      }
    }
    this.prices.set(id, map);
    this.syncCount(id);
    return Promise.resolve({ upserted, removed });
  }

  priceFor(listId: string, catalogItemId: string): Promise<number | null> {
    return Promise.resolve(this.prices.get(listId)?.get(catalogItemId) ?? null);
  }

  activeListForLocation(
    locationId: string,
  ): Promise<{ id: string; currency: string } | null> {
    const row = this.live().find(
      (r) => r.active && r.locationId === locationId,
    );
    return Promise.resolve(row ? { id: row.id, currency: row.currency } : null);
  }
}
