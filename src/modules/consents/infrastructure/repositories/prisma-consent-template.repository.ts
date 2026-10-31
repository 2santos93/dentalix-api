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
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import {
  CONSENT_TEMPLATE_HIDDEN_FIELDS,
  consentTemplateSnapshot,
} from '../../domain/consent-template-audit';

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
    audit: AuditRequestContext,
  ): Promise<ConsentTemplate> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const created = mapToEntity(
          await tx.consentTemplate.create({
            data: {
              tenantId,
              title: input.title,
              body: input.body,
              active: input.active,
              createdById: input.createdById,
              updatedById: input.createdById,
            },
          }),
        );
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'CONSENT_TEMPLATE',
            resourceId: created.id,
            reason: 'CONSENT_TEMPLATE_CREATED',
            after: consentTemplateSnapshot(created),
            hiddenFields: CONSENT_TEMPLATE_HIDDEN_FIELDS,
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateTitle);
  }

  /**
   * `update` por `id` bajo RLS: una plantilla de otra clínica no es visible y
   * Prisma lanza P2025; el use-case ya comprobó antes que existe aquí.
   */
  async update(
    id: string,
    input: UpdateConsentTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<ConsentTemplate> {
    return this.prisma
      .runWithTenant(async (tx) => {
        const before = mapToEntity(
          await tx.consentTemplate.findUniqueOrThrow({ where: { id } }),
        );
        const after = mapToEntity(
          await tx.consentTemplate.update({
            where: { id },
            data: {
              title: input.title,
              body: input.body,
              active: input.active,
              updatedById: input.updatedById,
              ...(input.bumpVersion ? { version: { increment: 1 } } : {}),
            },
          }),
        );
        const event = configAuditEvent(audit, {
          action: 'UPDATE',
          resourceType: 'CONSENT_TEMPLATE',
          resourceId: id,
          reason: 'CONSENT_TEMPLATE_UPDATED',
          before: consentTemplateSnapshot(before),
          after: consentTemplateSnapshot(after),
          hiddenFields: CONSENT_TEMPLATE_HIDDEN_FIELDS,
        });
        if (event) await writeAuditEvent(tx, event);
        return after;
      })
      .catch(rethrowDuplicateTitle);
  }
}
