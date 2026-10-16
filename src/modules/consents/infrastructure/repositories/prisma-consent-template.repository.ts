import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { ConsentTemplate } from '../../domain/entities/consent-template.entity';
import {
  ConsentTemplateRepository,
  CreateConsentTemplateRepoInput,
  UpdateConsentTemplateRepoInput,
} from '../../domain/ports/consent-template-repository.port';

type PrismaConsentTemplate = Prisma.ConsentTemplateGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaConsentTemplate): ConsentTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    body: row.body,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const DUPLICATE_TITLE_MESSAGE =
  'Ya existe una plantilla de consentimiento con ese título.';

/**
 * El único UNIQUE que una escritura de plantillas puede violar es
 * (tenantId, title). Se traduce aquí porque, bajo RLS, Prisma no informa
 * `meta.target` y el filtro global no sabría qué mensaje dar.
 */
function rethrowDuplicateTitle(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_TITLE_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaConsentTemplateRepository implements ConsentTemplateRepository {
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

  list(params?: { active?: boolean }): Promise<ConsentTemplate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.consentTemplate.findMany({
        where: params?.active === undefined ? {} : { active: params.active },
        orderBy: { title: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<ConsentTemplate | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.consentTemplate.findFirst({ where: { id } });
      return row ? mapToEntity(row) : null;
    });
  }

  async create(
    input: CreateConsentTemplateRepoInput,
  ): Promise<ConsentTemplate> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.consentTemplate.create({
          data: {
            tenantId,
            title: input.title,
            body: input.body,
            active: input.active,
            createdById: input.createdById,
            updatedById: input.createdById,
          },
        }),
      )
      .catch(rethrowDuplicateTitle);
    return mapToEntity(row);
  }

  /**
   * `update` por `id` bajo RLS: una plantilla de otra clínica no es visible y
   * Prisma lanza P2025; el use-case ya comprobó antes que existe aquí.
   */
  async update(
    id: string,
    input: UpdateConsentTemplateRepoInput,
  ): Promise<ConsentTemplate> {
    const row = await this.prisma
      .runWithTenant((tx) =>
        tx.consentTemplate.update({
          where: { id },
          data: {
            title: input.title,
            body: input.body,
            active: input.active,
            updatedById: input.updatedById,
            ...(input.bumpVersion ? { version: { increment: 1 } } : {}),
          },
        }),
      )
      .catch(rethrowDuplicateTitle);
    return mapToEntity(row);
  }
}
