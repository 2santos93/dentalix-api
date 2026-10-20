import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { Payer } from '../../domain/entities/payer.entity';
import {
  CreatePayerRepoInput,
  PayerRepository,
  UpdatePayerRepoInput,
} from '../../domain/ports/payer-repository.port';

type PrismaPayer = Prisma.PayerGetPayload<Record<string, never>>;

function mapToEntity(row: PrismaPayer): Payer {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    country: row.country,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const DUPLICATE_PAYER_MESSAGE = 'Ya existe un pagador con ese nombre.';

/**
 * El único UNIQUE que una escritura de pagadores puede violar es
 * (tenantId, name) entre los vivos: es la red de la carrera que el caso de uso
 * (que compara sin mayúsculas ni tildes) no puede cerrar solo.
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_PAYER_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaPayerRepository implements PayerRepository {
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

  list(params: { includeInactive: boolean }): Promise<Payer[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.payer.findMany({
        where: {
          deletedAt: null,
          ...(params.includeInactive ? {} : { active: true }),
        },
      });
      // El orden de la BD depende del collation; el catálogo se ordena en `es`.
      return rows
        .map(mapToEntity)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    });
  }

  findById(id: string): Promise<Payer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.payer.findFirst({ where: { id, deletedAt: null } });
      return row ? mapToEntity(row) : null;
    });
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Payer | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // RLS acota a la clínica. `dx_search_normalize` es la misma regla que
      // `payerNameKey`, así que la comparación coincide con la del índice.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "payers"
        WHERE "deletedAt" IS NULL
          AND public.dx_search_normalize("name") = ${nameKey}
          AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null}::uuid)
        LIMIT 1`;
      if (rows.length === 0) return null;
      const row = await tx.payer.findFirst({
        where: { id: rows[0].id, deletedAt: null },
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(input: CreatePayerRepoInput): Promise<Payer> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.payer.create({
          data: {
            tenantId,
            name: input.name,
            type: input.type,
            country: input.country,
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }

  /**
   * Por `id` bajo RLS. `null` si el pagador desapareció entre la lectura del
   * caso de uso y esta escritura (P2025).
   */
  async update(id: string, patch: UpdatePayerRepoInput): Promise<Payer | null> {
    try {
      const row = await this.prisma.runWithTenant((tx) =>
        tx.payer.update({
          where: { id },
          data: {
            name: patch.name,
            type: patch.type,
            country: patch.country,
            active: patch.active,
            updatedById: patch.updatedById,
          },
        }),
      );
      return mapToEntity(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        return null;
      }
      return rethrowDuplicateName(error);
    }
  }

  async softDelete(id: string, updatedById?: string): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.payer.update({
        where: { id },
        data: { active: false, deletedAt: new Date(), updatedById },
      }),
    );
  }

  countLiveCoverages(payerId: string): Promise<number> {
    return this.prisma.runWithTenant((tx) =>
      tx.patientCoverage.count({ where: { payerId, deletedAt: null } }),
    );
  }
}
