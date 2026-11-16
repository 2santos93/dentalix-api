import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { lockRow } from '../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import {
  TEMPLATE_DUPLICATE_CODE,
  TEMPLATE_DUPLICATE_MESSAGE,
  TEMPLATE_HIDDEN_FIELDS,
  TEMPLATE_STALE_CODE,
  TEMPLATE_STALE_MESSAGE,
  externalOrderTemplateSnapshot,
  templateNameKey,
  type ExternalOrderTemplate,
  type ExternalOrderTemplateDraft,
} from '../domain/external-order-template';

export const EXTERNAL_ORDER_TEMPLATE_REPOSITORY = Symbol(
  'EXTERNAL_ORDER_TEMPLATE_REPOSITORY',
);

type TemplateRow = Prisma.ExternalOrderTemplateGetPayload<object>;

function toTemplate(row: TemplateRow): ExternalOrderTemplate {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    recipient: row.recipient,
    items: row.items,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function staleTemplate(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: TEMPLATE_STALE_CODE,
    message: TEMPLATE_STALE_MESSAGE,
  });
}

export function duplicateTemplateName(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: TEMPLATE_DUPLICATE_CODE,
    message: TEMPLATE_DUPLICATE_MESSAGE,
  });
}

/** La red de una carrera: el UNIQUE (tenantId, name). */
function rethrowDuplicate(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw duplicateTemplateName();
  }
  throw error;
}

/**
 * Candado de transacción por clínica para los nombres: dos altas de
 * «Panorámica» y «panorámica» a la vez se serializan y la segunda ve la
 * primera (el UNIQUE de la BD distingue mayúsculas; la regla, no).
 */
async function lockNames(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx572_external_order_template_name'),
    hashtext(${tenantId})
  )`;
}

async function assertNameFree(
  tx: Prisma.TransactionClient,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const rows = await tx.externalOrderTemplate.findMany({
    where: exceptId ? { id: { not: exceptId } } : {},
    select: { name: true },
  });
  const key = templateNameKey(name);
  if (rows.some((r) => templateNameKey(r.name) === key)) {
    throw duplicateTemplateName();
  }
}

/**
 * DX-572: plantillas de órdenes externas en Postgres, bajo `runWithTenant`
 * (RLS FORCE). El alta y la edición se auditan en la MISMA transacción
 * (DX-360): EXTERNAL_ORDER_TEMPLATE con EXTERNAL_ORDER_TEMPLATE_CREATED o
 * _UPDATED, sin el destinatario ni los estudios.
 */
@Injectable()
export class PrismaExternalOrderTemplateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  list(params: { includeInactive: boolean }): Promise<ExternalOrderTemplate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.externalOrderTemplate.findMany({
        where: params.includeInactive ? {} : { active: true },
      });
      // El orden de la BD depende del collation; las plantillas, en `es`.
      return rows
        .map(toTemplate)
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id),
        );
    });
  }

  findById(id: string): Promise<ExternalOrderTemplate | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.externalOrderTemplate.findFirst({ where: { id } });
      return row ? toTemplate(row) : null;
    });
  }

  async create(
    draft: ExternalOrderTemplateDraft,
    audit: AuditRequestContext,
  ): Promise<ExternalOrderTemplate> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        await lockNames(tx, tenantId);
        await assertNameFree(tx, draft.name, null);
        const created = toTemplate(
          await tx.externalOrderTemplate.create({
            data: {
              tenantId,
              name: draft.name,
              kind: draft.kind,
              recipient: draft.recipient,
              items: draft.items,
              active: draft.active,
              createdById: audit.actor.userId,
              updatedById: audit.actor.userId,
            },
          }),
        );
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'EXTERNAL_ORDER_TEMPLATE',
            resourceId: created.id,
            reason: 'EXTERNAL_ORDER_TEMPLATE_CREATED',
            after: externalOrderTemplateSnapshot(created),
            hiddenFields: TEMPLATE_HIDDEN_FIELDS,
          }),
        );
        return created;
      })
      .catch(rethrowDuplicate);
  }

  /**
   * El «antes» se lee con la fila bloqueada: otra edición de la misma
   * plantilla espera y entonces ve la versión nueva (409). `build` arma la
   * plantilla resultante desde la actual (y la valida) antes de escribir.
   */
  async update(
    id: string,
    expectedVersion: number,
    build: (current: ExternalOrderTemplate) => ExternalOrderTemplateDraft,
    audit: AuditRequestContext,
  ): Promise<ExternalOrderTemplate | null> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        // El candado de nombres antes que la fila, siempre en el mismo orden.
        await lockNames(tx, tenantId);
        if (!(await lockRow(tx, 'external_order_templates', id))) return null;
        const current = toTemplate(
          await tx.externalOrderTemplate.findUniqueOrThrow({ where: { id } }),
        );
        if (current.version !== expectedVersion) throw staleTemplate();
        const next = build(current);
        if (templateNameKey(next.name) !== templateNameKey(current.name)) {
          await assertNameFree(tx, next.name, id);
        }
        const updated = toTemplate(
          await tx.externalOrderTemplate.update({
            where: { id },
            data: {
              name: next.name,
              kind: next.kind,
              recipient: next.recipient,
              items: next.items,
              active: next.active,
              version: { increment: 1 },
              updatedById: audit.actor.userId,
            },
          }),
        );
        const event = configAuditEvent(audit, {
          action: 'UPDATE',
          resourceType: 'EXTERNAL_ORDER_TEMPLATE',
          resourceId: id,
          reason: 'EXTERNAL_ORDER_TEMPLATE_UPDATED',
          before: externalOrderTemplateSnapshot(current),
          after: externalOrderTemplateSnapshot(updated),
          hiddenFields: TEMPLATE_HIDDEN_FIELDS,
        });
        if (event) await writeAuditEvent(tx, event);
        return updated;
      })
      .catch(rethrowDuplicate);
  }
}
