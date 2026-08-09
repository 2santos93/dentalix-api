import { CatalogKind } from '@prisma/client';
import { DentalCatalogItem } from '../entities/dental-catalog-item.entity';

export interface CreateDentalCatalogItemRepoInput {
  code: string;
  category?: string;
  kind: CatalogKind;
  labelEs: string;
  labelEn?: string;
  labelPt?: string;
  color: string;
  defaultPrice?: number;
  active?: boolean;
}

export interface UpdateDentalCatalogItemRepoInput {
  code?: string;
  category?: string | null;
  kind?: CatalogKind;
  labelEs?: string;
  labelEn?: string | null;
  labelPt?: string | null;
  color?: string;
  defaultPrice?: number | null;
  active?: boolean;
}

export interface ListDentalCatalogItemsParams {
  kind?: CatalogKind;
  activeOnly?: boolean;
}

export interface ListCatalogDirectoryParams extends ListDentalCatalogItemsParams {
  /** Texto libre: código, etiqueta (es/en/pt) o categoría, sin distinguir
   * mayúsculas ni acentos de más — `contains` + `insensitive`. */
  query?: string;
  /** Filas a saltar. Ya normalizado por el caso de uso: aquí llega resuelto. */
  skip: number;
  /** Filas a devolver. Ya acotado por el caso de uso. */
  take: number;
}

export interface CatalogDirectoryPage {
  items: DentalCatalogItem[];
  /** Total que casa con los filtros, NO el total del catálogo: es lo que la
   * paginación necesita para saber cuántas páginas hay de ESTA búsqueda. */
  total: number;
}

export const DENTAL_CATALOG_REPOSITORY = Symbol('DENTAL_CATALOG_REPOSITORY');

export interface DentalCatalogRepository {
  create(input: CreateDentalCatalogItemRepoInput): Promise<DentalCatalogItem>;

  /** El catálogo ENTERO que casa con los filtros, sin paginar. Es lo que
   * consumen los selectores (odontograma, panel de diente, plan de
   * tratamiento): necesitan todas las opciones de golpe, no una página. */
  list(params: ListDentalCatalogItemsParams): Promise<DentalCatalogItem[]>;

  /** Una PÁGINA del catálogo, con búsqueda libre — para la pantalla de
   * gestión. Va aparte de `list` por la misma razón que `GET /staff/directory`
   * vive aparte de `GET /staff`: un selector y una tabla de administración
   * quieren cosas distintas, y hacer que un endpoint sirva a los dos obliga a
   * uno de los dos a fingir. Cuenta y trae en la MISMA transacción, así que el
   * total nunca describe un universo distinto al de las filas devueltas. */
  listDirectory(
    params: ListCatalogDirectoryParams,
  ): Promise<CatalogDirectoryPage>;
  findById(id: string): Promise<DentalCatalogItem | null>;
  update(
    id: string,
    patch: UpdateDentalCatalogItemRepoInput,
  ): Promise<DentalCatalogItem>;
}
