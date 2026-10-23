import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PriceList } from '../../domain/entities/price-list.entity';
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
import {
  PRICE_LIST_CATALOG_ITEMS_MESSAGE,
  PRICE_LIST_CURRENCY_LOCKED_MESSAGE,
  PRICE_LIST_DUPLICATE_MESSAGE,
  PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE,
  PRICE_LIST_LOCATION_TAKEN_MESSAGE,
  PRICE_LIST_NOT_FOUND_MESSAGE,
} from '../../domain/price-list-rules';

type PrismaPriceList = Prisma.PriceListGetPayload<{
  include: { _count: { select: { items: true } } };
}>;

const WITH_COUNT = { _count: { select: { items: true } } } as const;

function mapToEntity(row: PrismaPriceList): PriceList {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    locationId: row.locationId,
    active: row.active,
    itemCount: row._count.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Texto de `error.meta.target` (columnas o nombre del índice) en minúsculas. */
function uniqueTarget(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  const text = Array.isArray(target)
    ? target.join(',')
    : typeof target === 'string'
      ? target
      : '';
  return text.toLowerCase();
}

/**
 * Los UNIQUE parciales que una escritura de listas puede violar son dos: el
 * nombre entre las vivas y la lista activa por sede. Son la red de la carrera
 * que los casos de uso (que comparan antes) no pueden cerrar solos.
 */
function rethrowListConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(
      uniqueTarget(error).includes('location')
        ? PRICE_LIST_LOCATION_TAKEN_MESSAGE
        : PRICE_LIST_DUPLICATE_MESSAGE,
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003'
  ) {
    // La FK compuesta a `locations`: la sede se retiró entre la lectura y aquí.
    throw new BadRequestException(PRICE_LIST_LOCATION_NOT_FOUND_MESSAGE);
  }
  throw error;
}

/** Carrera con la FK compuesta del lote: una prestación dejó de ser de la clínica. */
function isCatalogItemFkViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (
    error.code === 'P2003' ||
    (error.code === 'P2010' &&
      error.message.includes('price_list_items_catalog_item_fkey'))
  );
}

/** Búsqueda libre del directorio: código, etiqueta (es/en/pt) o categoría. */
function searchFilter(query?: string): Prisma.DentalCatalogItemWhereInput {
  if (!query) return {};
  const contains = { contains: query, mode: 'insensitive' as const };
  return {
    OR: [
      { code: contains },
      { labelEs: contains },
      { labelEn: contains },
      { labelPt: contains },
      { category: contains },
    ],
  };
}

@Injectable()
export class PrismaPriceListRepository implements PriceListRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  list(params: { includeInactive: boolean }): Promise<PriceList[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.priceList.findMany({
        where: {
          deletedAt: null,
          ...(params.includeInactive ? {} : { active: true }),
        },
        include: WITH_COUNT,
      });
      // El orden de la BD depende del collation; se ordena en `es`.
      return rows
        .map(mapToEntity)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
  }

  findById(id: string): Promise<PriceList | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.priceList.findFirst({
        where: { id, deletedAt: null },
        include: WITH_COUNT,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<PriceList | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS acota a la clínica. `dx_search_normalize` es la misma regla que
      // `priceListNameKey`, así que la comparación coincide con la del índice.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "price_lists"
        WHERE "deletedAt" IS NULL
          AND public.dx_search_normalize("name") = ${nameKey}
          AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null}::uuid)
        LIMIT 1`;
      if (rows.length === 0) return null;
      const row = await tx.priceList.findFirst({
        where: { id: rows[0].id, deletedAt: null },
        include: WITH_COUNT,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  findActiveByLocation(
    locationId: string,
    excludeId?: string,
  ): Promise<PriceList | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.priceList.findFirst({
        where: {
          locationId,
          active: true,
          deletedAt: null,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        include: WITH_COUNT,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(input: CreatePriceListRepoInput): Promise<PriceList> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.priceList.create({
          data: {
            tenantId,
            name: input.name,
            currency: input.currency,
            locationId: input.locationId,
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
          include: WITH_COUNT,
        }),
      )
      .catch(rethrowListConflict);
    return mapToEntity(row);
  }

  /**
   * Por `id` bajo RLS. `null` si la lista desapareció entre la lectura del
   * caso de uso y esta escritura. Si cambia la moneda, bloquea la fila y
   * recuenta los precios aquí: un `PUT` de precios que se cuela entre la
   * lectura del caso de uso y esta escritura espera (toma `FOR SHARE`) y se
   * cuenta, así que la lista nunca acaba con precios en otra moneda.
   */
  async update(
    id: string,
    patch: UpdatePriceListRepoInput,
  ): Promise<PriceList | null> {
    try {
      const row = await this.prisma.runWithTenant(async (tx) => {
        if (patch.currency !== undefined) {
          const locked = await tx.$queryRaw<{ currency: string }[]>`
            SELECT "currency" FROM "price_lists"
            WHERE id = ${id}::uuid AND "deletedAt" IS NULL
            FOR UPDATE`;
          if (locked.length === 0) return null;
          if (locked[0].currency !== patch.currency) {
            const items = await tx.priceListItem.count({
              where: { priceListId: id },
            });
            if (items > 0) {
              throw new ConflictException(PRICE_LIST_CURRENCY_LOCKED_MESSAGE);
            }
          }
        }
        return tx.priceList.update({
          where: { id },
          data: {
            name: patch.name,
            currency: patch.currency,
            locationId: patch.locationId,
            active: patch.active,
            updatedById: patch.updatedById,
          },
          include: WITH_COUNT,
        });
      });
      return row ? mapToEntity(row) : null;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      return rethrowListConflict(error);
    }
  }

  /**
   * Candado de fila sobre la lista (`FOR UPDATE`) antes de contar: quien crea
   * o edita un convenio sobre ella la relee con `FOR SHARE` en su transacción,
   * así que uno de los dos espera al otro y ve su resultado.
   */
  retire(id: string, updatedById?: string): Promise<RetirePriceListResult> {
    return this.prisma.runWithTenant(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "price_lists"
        WHERE id = ${id}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (locked.length === 0) return 'NOT_FOUND';
      const inUse = await tx.agreement.count({
        where: { priceListId: id, deletedAt: null },
      });
      if (inUse > 0) return 'IN_USE';
      await tx.priceList.update({
        where: { id },
        data: { active: false, deletedAt: new Date(), updatedById },
      });
      return 'RETIRED';
    });
  }

  listItemsDirectory(
    id: string,
    params: PriceListItemsDirectoryParams,
  ): Promise<PriceListItemsDirectoryPage> {
    const where: Prisma.DentalCatalogItemWhereInput = {
      deletedAt: null,
      active: true,
      kind: 'PROCEDURE',
      ...searchFilter(params.query),
    };
    return this.prisma.runWithTenant(async (tx) => {
      // Cuenta y página en la MISMA transacción: el total describe estas filas.
      const [items, total] = await Promise.all([
        tx.dentalCatalogItem.findMany({
          where,
          orderBy: { code: 'asc' },
          skip: params.skip,
          take: params.take,
          select: {
            id: true,
            code: true,
            labelEs: true,
            category: true,
            defaultPrice: true,
            // LEFT JOIN: el procedimiento sale aunque la lista no lo tenga.
            priceListItems: {
              where: { priceListId: id },
              select: { price: true },
              take: 1,
            },
          },
        }),
        tx.dentalCatalogItem.count({ where }),
      ]);
      return {
        items: items.map((item) => ({
          catalogItemId: item.id,
          code: item.code,
          labelEs: item.labelEs,
          category: item.category,
          defaultPrice: item.defaultPrice ? item.defaultPrice.toNumber() : null,
          price: item.priceListItems[0]
            ? item.priceListItems[0].price.toNumber()
            : null,
        })),
        total,
      };
    });
  }

  /**
   * Una transacción: la lista se bloquea `FOR SHARE` (un cambio de moneda
   * espera), los precios se escriben con UN `INSERT … ON CONFLICT DO UPDATE`
   * por lote (no 500 viajes a la BD) y las filas `null` se borran. La FK
   * compuesta a `dental_catalog_items` es la red de «la prestación es de esta
   * clínica»: el caso de uso ya lo comprobó con `findByIds`.
   */
  async replaceItems(
    id: string,
    rows: PriceListItemInput[],
  ): Promise<ReplacePriceListItemsResult> {
    const tenantId = this.requireTenantId();
    const toSet = rows.filter(
      (r): r is { catalogItemId: string; price: number } => r.price !== null,
    );
    const toRemove = rows.filter((r) => r.price === null);
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "price_lists"
          WHERE id = ${id}::uuid AND "deletedAt" IS NULL
          FOR SHARE`;
        if (locked.length === 0) {
          throw new NotFoundException(PRICE_LIST_NOT_FOUND_MESSAGE);
        }

        let upserted = 0;
        if (toSet.length > 0) {
          // Importes como texto -> numeric: sin pasar por coma flotante.
          upserted = await tx.$executeRaw`
            INSERT INTO "price_list_items"
              ("id", "tenantId", "priceListId", "catalogItemId", "price", "createdAt", "updatedAt")
            SELECT gen_random_uuid(), ${tenantId}::uuid, ${id}::uuid, x.catalog_item_id, x.price, now(), now()
            FROM unnest(
              ${toSet.map((r) => r.catalogItemId)}::uuid[],
              ${toSet.map((r) => r.price.toFixed(2))}::text[]::numeric[]
            ) AS x(catalog_item_id, price)
            ON CONFLICT ("tenantId", "priceListId", "catalogItemId")
            DO UPDATE SET "price" = EXCLUDED."price", "updatedAt" = now()`;
        }

        let removed = 0;
        if (toRemove.length > 0) {
          // Quitar el precio = borrar la fila (allowlist de `no-hard-delete`).
          // eslint-disable-next-line no-restricted-syntax
          const result = await tx.priceListItem.deleteMany({
            where: {
              priceListId: id,
              catalogItemId: { in: toRemove.map((r) => r.catalogItemId) },
            },
          });
          removed = result.count;
        }
        return { upserted, removed };
      });
    } catch (error) {
      if (isCatalogItemFkViolation(error)) {
        throw new BadRequestException(PRICE_LIST_CATALOG_ITEMS_MESSAGE);
      }
      throw error;
    }
  }

  priceFor(listId: string, catalogItemId: string): Promise<number | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.priceListItem.findFirst({
        where: { priceListId: listId, catalogItemId },
        select: { price: true },
      });
      return row ? row.price.toNumber() : null;
    });
  }

  activeListForLocation(
    locationId: string,
  ): Promise<{ id: string; currency: string } | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.priceList.findFirst({
        where: { locationId, active: true, deletedAt: null },
        select: { id: true, currency: true },
      });
      return row ?? null;
    });
  }
}
