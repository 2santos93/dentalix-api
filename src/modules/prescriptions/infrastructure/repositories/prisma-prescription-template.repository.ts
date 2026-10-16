import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PrescriptionTemplate,
  PrescriptionTemplateItem,
} from '../../domain/entities/prescription-template.entity';
import type {
  PrescriptionTemplateRepoInput,
  PrescriptionTemplateRepository,
} from '../../domain/ports/prescription-template-repository.port';

type Row = Prisma.PrescriptionTemplateGetPayload<Record<string, never>>;

export const DUPLICATE_TEMPLATE_NAME_MESSAGE =
  'Ya existe una plantilla de receta con ese nombre.';

function mapRow(row: Row): PrescriptionTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    notes: row.notes,
    // Escrito solo por esta clase, ya normalizado por el use-case.
    items: row.items as unknown as PrescriptionTemplateItem[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * El único UNIQUE que puede violar una escritura es (tenantId, name) entre
 * plantillas vivas; bajo RLS Prisma no informa `meta.target`, así que el
 * mensaje se pone aquí (mismo criterio que las plantillas de consentimiento).
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_TEMPLATE_NAME_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaPrescriptionTemplateRepository implements PrescriptionTemplateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async list(): Promise<PrescriptionTemplate[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.prescriptionTemplate.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<PrescriptionTemplate | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.prescriptionTemplate.findFirst({ where: { id, deletedAt: null } }),
    );
    return row ? mapRow(row) : null;
  }

  async create(
    input: PrescriptionTemplateRepoInput,
    createdById: string,
  ): Promise<PrescriptionTemplate> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.prescriptionTemplate.create({
          data: {
            tenantId,
            name: input.name,
            notes: input.notes,
            items: input.items as unknown as Prisma.InputJsonValue,
            createdById,
            updatedById: createdById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapRow(row);
  }

  async update(
    id: string,
    input: Partial<PrescriptionTemplateRepoInput>,
    updatedById: string,
  ): Promise<PrescriptionTemplate> {
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.prescriptionTemplate.update({
          where: { id },
          data: {
            name: input.name,
            notes: input.notes,
            items: input.items as unknown as Prisma.InputJsonValue | undefined,
            updatedById,
          },
        }),
      )
      .catch(rethrowDuplicateName);
    return mapRow(row);
  }

  async softDelete(id: string, deletedById: string): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.prescriptionTemplate.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), updatedById: deletedById },
      }),
    );
  }
}
