import { Inject, Injectable } from '@nestjs/common';
import { INVENTORY_REPOSITORY } from '../../domain/ports/inventory-repository.port';
import type { InventoryRepository } from '../../domain/ports/inventory-repository.port';
import { InventoryItemWithStock } from '../../domain/entities/inventory-item.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ListInventoryItemsInput {
  query?: string;
  page?: number;
  pageSize?: number;
  lowStockOnly?: boolean;
}

export interface ListInventoryItemsOutput {
  items: InventoryItemWithStock[];
  total: number;
  page: number;
  pageSize: number;
}

// Same normalization as `ListPatientsUseCase` (list-patients.use-case.ts):
// page < 1 (or non-finite/omitted) -> 1; pageSize < 1 (or non-finite/
// omitted) -> the default, capped at MAX_PAGE_SIZE.
function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) {
    return DEFAULT_PAGE;
  }
  return Math.floor(page);
}

function normalizePageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), MAX_PAGE_SIZE);
}

@Injectable()
export class ListInventoryItemsUseCase {
  constructor(
    @Inject(INVENTORY_REPOSITORY)
    private readonly repo: InventoryRepository,
  ) {}

  /**
   * Two queries total, REGARDLESS of how many items exist: `listItems()`
   * for the active rows (with the text filter, if any — that's the repo's
   * job) and `sumSignedQuantityAll()` for every item's stock in one
   * aggregation — never one stock query per item (N+1). `stock`/`lowStock`
   * are then computed HERE, per item, from that same aggregation:
   * `signedQuantity` stays the single source of truth for the sign rule, so
   * `lowStockOnly` filters over the value this method just derived rather
   * than a second, hand-written SQL definition of "low stock" that could
   * drift from the first. Pagination happens AFTER that filter for the same
   * reason — slicing before filtering would make `total`/"page N" describe
   * the wrong universe (all items, not the filtered ones).
   */
  async execute(
    input: ListInventoryItemsInput = {},
  ): Promise<ListInventoryItemsOutput> {
    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);

    const [items, stockByItemId] = await Promise.all([
      this.repo.listItems({ query: input.query }),
      this.repo.sumSignedQuantityAll(),
    ]);

    const withStock: InventoryItemWithStock[] = items.map((item) => {
      const stock = stockByItemId[item.id] ?? 0;
      return {
        ...item,
        stock,
        lowStock: stock <= item.minStock,
      };
    });

    const filtered = input.lowStockOnly
      ? withStock.filter((item) => item.lowStock)
      : withStock;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const pageItems = filtered.slice(start, start + pageSize);

    return { items: pageItems, total, page, pageSize };
  }
}
