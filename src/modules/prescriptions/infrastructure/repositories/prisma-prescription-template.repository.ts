import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { lockRow } from '../../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PrescriptionTemplate,
  PrescriptionTemplateItem,
} from '../../domain/entities/prescription-template.entity';
import type {
  PrescriptionTemplateRepoInput,
  PrescriptionTemplateRepository,
} from '../../domain/ports/prescription-template-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import {
  PRESCRIPTION_TEMPLATE_HIDDEN_FIELDS,
  prescriptionTemplateSnapshot,
} from '../../domain/prescription-template-audit';

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
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate> {
    const tenantId = this.requireTenantId();
    const createdById = audit.actor.userId;
    return this.prisma
      .runWithTenant(async (tx) => {
        const created = mapRow(
          await tx.prescriptionTemplate.create({
            data: {
              tenantId,
              name: input.name,
              notes: input.notes,
              items: input.items as unknown as Prisma.InputJsonValue,
              createdById,
              updatedById: createdById,
            },
          }),
        );
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'PRESCRIPTION_TEMPLATE',
            resourceId: created.id,
            reason: 'PRESCRIPTION_TEMPLATE_CREATED',
            after: prescriptionTemplateSnapshot(created),
            hiddenFields: PRESCRIPTION_TEMPLATE_HIDDEN_FIELDS,
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateName);
  }

  async update(
    id: string,
    input: Partial<PrescriptionTemplateRepoInput>,
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate> {
    return this.prisma
      .runWithTenant(async (tx) => {
        // DX-360: el antes, con la fila bloqueada hasta el final.
        await lockRow(tx, 'prescription_templates', id);
        const before = mapRow(
          await tx.prescriptionTemplate.findUniqueOrThrow({ where: { id } }),
        );
        const after = mapRow(
          await tx.prescriptionTemplate.update({
            where: { id },
            data: {
              name: input.name,
              notes: input.notes,
              items: input.items as unknown as
                Prisma.InputJsonValue | undefined,
              updatedById: audit.actor.userId,
            },
          }),
        );
        const event = configAuditEvent(audit, {
          action: 'UPDATE',
          resourceType: 'PRESCRIPTION_TEMPLATE',
          resourceId: id,
          reason: 'PRESCRIPTION_TEMPLATE_UPDATED',
          before: prescriptionTemplateSnapshot(before),
          after: prescriptionTemplateSnapshot(after),
          hiddenFields: PRESCRIPTION_TEMPLATE_HIDDEN_FIELDS,
        });
        if (event) await writeAuditEvent(tx, event);
        return after;
      })
      .catch(rethrowDuplicateName);
  }

  async softDelete(id: string, audit: AuditRequestContext): Promise<void> {
    await this.prisma.runWithTenant(async (tx) => {
      await lockRow(tx, 'prescription_templates', id);
      const live = await tx.prescriptionTemplate.findFirst({
        where: { id, deletedAt: null },
      });
      if (!live) return;
      await tx.prescriptionTemplate.update({
        where: { id },
        data: { deletedAt: new Date(), updatedById: audit.actor.userId },
      });
      await writeAuditEvent(
        tx,
        configAuditEvent(audit, {
          action: 'DELETE',
          resourceType: 'PRESCRIPTION_TEMPLATE',
          resourceId: id,
          reason: 'PRESCRIPTION_TEMPLATE_DELETED',
          before: prescriptionTemplateSnapshot(mapRow(live)),
          hiddenFields: PRESCRIPTION_TEMPLATE_HIDDEN_FIELDS,
        }),
      );
    });
  }
}
