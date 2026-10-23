import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { ExpenseCategory } from '../../domain/entities/expense-category.entity';
import type { ExpenseCategoryRepository } from '../../domain/ports/expense-category-repository.port';

type CategoryRow = Prisma.ExpenseCategoryGetPayload<Record<string, never>>;

function mapCategory(row: CategoryRow): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaExpenseCategoryRepository implements ExpenseCategoryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async listActive(): Promise<ExpenseCategory[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.expenseCategory.findMany({
        where: { deletedAt: null, active: true },
      }),
    );
    // El orden de la BD depende del collation; el catálogo se ordena en `es`.
    return rows
      .map(mapCategory)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  private async findByKey(
    key: string,
    onlyActive: boolean,
  ): Promise<ExpenseCategory | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS acota a la clínica. `dx_search_normalize` es la misma regla que
      // `categoryKey`.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "expense_categories"
         WHERE "deletedAt" IS NULL
           ${onlyActive ? Prisma.sql`AND "active"` : Prisma.empty}
           AND public.dx_search_normalize("name") = ${key}
         LIMIT 1`;
      if (rows.length === 0) return null;
      const row = await tx.expenseCategory.findFirst({
        where: { id: rows[0].id, deletedAt: null },
      });
      return row ? mapCategory(row) : null;
    });
  }

  findActiveByKey(key: string): Promise<ExpenseCategory | null> {
    return this.findByKey(key, true);
  }

  findLiveByKey(key: string): Promise<ExpenseCategory | null> {
    return this.findByKey(key, false);
  }

  async create(
    name: string,
    createdById: string,
  ): Promise<ExpenseCategory | null> {
    const tenantId = this.requireTenantId();
    try {
      const row = await this.prisma.runWithTenant((tx) =>
        tx.expenseCategory.create({ data: { tenantId, name, createdById } }),
      );
      return mapCategory(row);
    } catch (error) {
      // El único (tenantId, name) entre las vivas cierra la carrera que la
      // comparación sin tildes del caso de uso no puede.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null;
      }
      throw error;
    }
  }

  async retire(id: string): Promise<boolean> {
    const { count } = await this.prisma.runWithTenant((tx) =>
      tx.expenseCategory.updateMany({
        where: { id, deletedAt: null },
        data: { active: false, deletedAt: new Date() },
      }),
    );
    return count > 0;
  }
}
