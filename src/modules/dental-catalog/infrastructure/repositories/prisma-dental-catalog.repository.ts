import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateDentalCatalogItemRepoInput,
  DentalCatalogRepository,
  ListDentalCatalogItemsParams,
  UpdateDentalCatalogItemRepoInput,
} from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';

type PrismaDentalCatalogItem = Prisma.DentalCatalogItemGetPayload<
  Record<string, never>
>;

function mapToEntity(item: PrismaDentalCatalogItem): DentalCatalogItem {
  return {
    id: item.id,
    tenantId: item.tenantId,
    code: item.code,
    category: item.category,
    kind: item.kind,
    labelEs: item.labelEs,
    labelEn: item.labelEn,
    labelPt: item.labelPt,
    color: item.color,
    defaultPrice: item.defaultPrice ? item.defaultPrice.toNumber() : null,
    active: item.active,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

@Injectable()
export class PrismaDentalCatalogRepository implements DentalCatalogRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT/UPDATE/DELETE,
   * which RLS filters transparently — an INSERT still needs the app to
   * supply it explicitly. We never take it from the input (never from the
   * client); we read it from the same request-scoped context that
   * `runWithTenant(fn)` uses to set `app.current_tenant` (see
   * PrismaPatientRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(
    input: CreateDentalCatalogItemRepoInput,
  ): Promise<DentalCatalogItem> {
    const tenantId = this.requireTenantId();
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.dentalCatalogItem.create({
        data: {
          tenantId,
          code: input.code,
          category: input.category,
          kind: input.kind,
          labelEs: input.labelEs,
          labelEn: input.labelEn,
          labelPt: input.labelPt,
          color: input.color,
          defaultPrice: input.defaultPrice,
          active: input.active,
        },
      });
    });
    return mapToEntity(item);
  }

  async findById(id: string): Promise<DentalCatalogItem | null> {
    const item = await this.prisma.runWithTenant(async (tx) => {
      return tx.dentalCatalogItem.findFirst({
        where: { id, deletedAt: null },
      });
    });
    return item ? mapToEntity(item) : null;
  }

  async list(
    params: ListDentalCatalogItemsParams,
  ): Promise<DentalCatalogItem[]> {
    const where: Prisma.DentalCatalogItemWhereInput = {
      deletedAt: null,
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.activeOnly ? { active: true } : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const items = await tx.dentalCatalogItem.findMany({
        where,
        orderBy: { code: 'asc' },
      });
      return items.map(mapToEntity);
    });
  }

  async update(
    id: string,
    patch: UpdateDentalCatalogItemRepoInput,
  ): Promise<DentalCatalogItem> {
    return this.prisma.runWithTenant(async (tx) => {
      const existing = await tx.dentalCatalogItem.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Catalog item not found');
      }

      const item = await tx.dentalCatalogItem.update({
        where: { id },
        data: patch,
      });
      return mapToEntity(item);
    });
  }
}
