import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { Chair } from '../../domain/entities/chair.entity';
import { DUPLICATE_CHAIR_NAME_MESSAGE } from '../../domain/chair-rules';
import type {
  ChairRepository,
  CreateChairRepoInput,
  UpdateChairRepoInput,
} from '../../domain/ports/chair-repository.port';

type PrismaChair = Prisma.ChairGetPayload<Record<string, never>>;

function mapToEntity(row: PrismaChair): Chair {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    name: row.name,
    sortOrder: row.sortOrder,
    defaultProviderId: row.defaultProviderId,
    active: row.active,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const ORDER = [
  { sortOrder: 'asc' },
  { name: 'asc' },
] satisfies Prisma.ChairOrderByWithRelationInput[];

/**
 * El único UNIQUE que una escritura de sillones puede violar es
 * (tenantId, locationId, name). Bajo RLS Prisma no informa `meta.target`, así
 * que se traduce aquí (como los tipos de cita).
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_CHAIR_NAME_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaChairRepository implements ChairRepository {
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

  /**
   * La membresía VIVA del profesional en esta clínica (RLS), que la FK
   * compuesta chairs_default_provider_fkey exige junto con el usuario. El
   * caso de uso ya comprobó que es un miembro activo.
   */
  private async membershipOf(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const membership = await tx.clinicMembership.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException('Profesional no encontrado');
    return membership.id;
  }

  listByLocation(params: {
    locationId: string;
    includeInactive: boolean;
  }): Promise<Chair[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.chair.findMany({
        where: {
          locationId: params.locationId,
          ...(params.includeInactive ? {} : { active: true }),
        },
        orderBy: ORDER,
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<Chair | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.chair.findFirst({ where: { id } });
      return row ? mapToEntity(row) : null;
    });
  }

  findByIds(ids: readonly string[]): Promise<Chair[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.chair.findMany({
        where: { id: { in: [...ids] } },
        orderBy: ORDER,
      });
      return rows.map(mapToEntity);
    });
  }

  async create(input: CreateChairRepoInput): Promise<Chair> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant(async (tx) =>
        tx.chair.create({
          data: {
            tenantId,
            locationId: input.locationId,
            name: input.name,
            sortOrder: input.sortOrder,
            defaultProviderId: input.defaultProviderId,
            defaultProviderMembershipId:
              input.defaultProviderId !== null
                ? await this.membershipOf(tx, input.defaultProviderId)
                : null,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }

  /** Por `id` bajo RLS; el caso de uso ya comprobó que existe. */
  async update(id: string, input: UpdateChairRepoInput): Promise<Chair> {
    const row = await this.prisma
      .runWithTenant(async (tx) => {
        let provider: Prisma.ChairUncheckedUpdateInput = {};
        if (input.defaultProviderId === null) {
          provider = {
            defaultProviderId: null,
            defaultProviderMembershipId: null,
          };
        } else if (input.defaultProviderId !== undefined) {
          provider = {
            defaultProviderId: input.defaultProviderId,
            defaultProviderMembershipId: await this.membershipOf(
              tx,
              input.defaultProviderId,
            ),
          };
        }
        return tx.chair.update({
          where: { id },
          data: {
            name: input.name,
            sortOrder: input.sortOrder,
            active: input.active,
            updatedById: input.updatedById,
            ...provider,
          },
        });
      })
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }

  reorder(
    locationId: string,
    chairIds: readonly string[],
    updatedById: string,
  ): Promise<Chair[]> {
    return this.prisma.runWithTenant(async (tx) => {
      for (const [index, id] of chairIds.entries()) {
        await tx.chair.updateMany({
          where: { id, locationId },
          data: { sortOrder: index, updatedById },
        });
      }
      const rows = await tx.chair.findMany({
        where: { locationId },
        orderBy: ORDER,
      });
      return rows.map(mapToEntity);
    });
  }
}
