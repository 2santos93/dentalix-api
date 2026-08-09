import { Inject, Injectable } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ListCatalogDirectoryInput {
  query?: string;
  kind?: CatalogKind;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface ListCatalogDirectoryOutput {
  items: DentalCatalogItem[];
  total: number;
  page: number;
  pageSize: number;
}

// Misma normalización que `ListInventoryItemsUseCase` y `ListPatientsUseCase`:
// page < 1 (o no finito/ausente) -> 1; pageSize < 1 (o no finito/ausente) ->
// el valor por defecto, acotado a MAX_PAGE_SIZE. Se repite en cada caso de uso
// en lugar de extraerse porque el tope es una decisión POR endpoint, no una
// constante global: subirlo aquí no debe subirlo en pacientes.
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
export class ListCatalogDirectoryUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
  ) {}

  /**
   * Una página del catálogo para la pantalla de gestión.
   *
   * A diferencia de inventario, aquí se pagina en SQL (`skip`/`take`) y no en
   * memoria: el catálogo no necesita ninguna agregación cruzada entre filas
   * —no hay un equivalente al stock— así que no hay motivo para traerse la
   * tabla entera. El filtro de texto también es del repositorio por lo mismo.
   *
   * `query` se recorta y un texto en blanco se trata como "sin búsqueda": si
   * no, teclear un espacio devolvería cero resultados y parecería que el
   * catálogo está vacío.
   */
  async execute(
    input: ListCatalogDirectoryInput = {},
  ): Promise<ListCatalogDirectoryOutput> {
    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);
    const query = input.query?.trim() || undefined;

    const { items, total } = await this.repo.listDirectory({
      query,
      kind: input.kind,
      activeOnly: input.activeOnly,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { items, total, page, pageSize };
  }
}
