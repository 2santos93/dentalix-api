import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { lockRow } from '../../../../shared/prisma/lock-row';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../../audit/domain/config-audit';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { TreatmentPlanTemplate } from '../../domain/entities/treatment-plan-template.entity';
import type {
  CreatePlanTemplateRepoInput,
  TemplateCatalogItem,
  TreatmentPlanTemplateRepository,
  UpdatePlanTemplateRepoInput,
} from '../../domain/ports/treatment-plan-template-repository.port';
import {
  planTemplateNameKey,
  type PlanTemplateDraft,
  type VisitIntervals,
} from '../../domain/plan-template-rules';
import {
  PLAN_TEMPLATE_HIDDEN_FIELDS,
  planTemplateSnapshot,
} from '../../domain/plan-template-audit';
import {
  duplicateTemplateName,
  staleTemplate,
} from '../../application/plan-template-errors';

const WITH_LINES = {
  lines: {
    orderBy: { position: 'asc' },
    include: {
      catalogItem: {
        select: { labelEs: true, code: true, active: true, deletedAt: true },
      },
    },
  },
} as const satisfies Prisma.TreatmentPlanTemplateInclude;

type PrismaTemplate = Prisma.TreatmentPlanTemplateGetPayload<{
  include: typeof WITH_LINES;
}>;

export function mapToEntity(row: PrismaTemplate): TreatmentPlanTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    active: row.active,
    version: row.version,
    visitIntervals: row.visitIntervals as VisitIntervals,
    lines: row.lines.map((line) => ({
      id: line.id,
      position: line.position,
      catalogItemId: line.catalogItemId,
      catalogItemLabel: line.catalogItem.labelEs,
      catalogItemCode: line.catalogItem.code,
      catalogItemActive:
        line.catalogItem.active && line.catalogItem.deletedAt === null,
      quantity: line.quantity,
      visit: line.visit,
      visitLabel: line.visitLabel,
      asksSurfaces: line.asksSurfaces,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * El único UNIQUE que una escritura puede violar es (tenantId, name): la red
 * de una carrera entre dos nombres idénticos.
 */
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
 * Candado de transacción por clínica para los nombres: dos altas de «Endo» y
 * «endo» a la vez se serializan y la segunda ve la primera (el UNIQUE de la
 * BD distingue mayúsculas; la regla de la clínica, no).
 */
async function lockNames(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx559_plan_template_name'),
    hashtext(${tenantId})
  )`;
}

/** 409 si otra plantilla de la clínica ya se llama así (sin mayúsculas). */
async function assertNameFree(
  tx: Prisma.TransactionClient,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const rows = await tx.treatmentPlanTemplate.findMany({
    where: exceptId ? { id: { not: exceptId } } : {},
    select: { name: true },
  });
  const key = planTemplateNameKey(name);
  if (rows.some((r) => planTemplateNameKey(r.name) === key)) {
    throw duplicateTemplateName();
  }
}

@Injectable()
export class PrismaTreatmentPlanTemplateRepository implements TreatmentPlanTemplateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /** Filas de las líneas en su orden (posición = índice). */
  private lineRows(lines: PlanTemplateDraft['lines']) {
    return lines.map((line, position) => ({
      position,
      catalogItemId: line.catalogItemId,
      quantity: line.quantity,
      visit: line.visit,
      visitLabel: line.visitLabel,
      asksSurfaces: line.asksSurfaces,
    }));
  }

  list(params: { includeInactive: boolean }): Promise<TreatmentPlanTemplate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.treatmentPlanTemplate.findMany({
        where: params.includeInactive ? {} : { active: true },
        include: WITH_LINES,
      });
      // El orden de la BD depende del collation; las plantillas, en `es`.
      return rows
        .map(mapToEntity)
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id),
        );
    });
  }

  findById(id: string): Promise<TreatmentPlanTemplate | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.treatmentPlanTemplate.findFirst({
        where: { id },
        include: WITH_LINES,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  catalogItems(ids: string[]): Promise<TemplateCatalogItem[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.runWithTenant((tx) =>
      tx.dentalCatalogItem.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, kind: true, labelEs: true },
      }),
    );
  }

  async create(
    input: CreatePlanTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        await lockNames(tx, tenantId);
        await assertNameFree(tx, input.name, null);
        const row = await tx.treatmentPlanTemplate.create({
          data: {
            tenantId,
            name: input.name,
            active: input.active,
            visitIntervals: input.visitIntervals,
            createdById: audit.actor.userId,
            updatedById: audit.actor.userId,
            // Anidada: tenantId y templateId salen de la plantilla (FK
            // compuesta), nunca del cliente.
            lines: {
              createMany: { data: this.lineRows(input.lines) },
            },
          },
          include: WITH_LINES,
        });
        const created = mapToEntity(row);
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'TREATMENT_PLAN_TEMPLATE',
            resourceId: created.id,
            reason: 'PLAN_TEMPLATE_CREATED',
            after: planTemplateSnapshot(created),
            hiddenFields: PLAN_TEMPLATE_HIDDEN_FIELDS,
          }),
        );
        return created;
      })
      .catch(rethrowDuplicate);
  }

  /**
   * El «antes» se lee con la fila bloqueada (FOR UPDATE): otra edición de la
   * misma plantilla espera a que esta confirme y entonces ve la versión
   * nueva (409). Sin la versión esperada no se escribe nada.
   */
  async update(
    id: string,
    input: UpdatePlanTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate | null> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        // El candado de nombres antes que la fila, siempre en el mismo orden.
        if (input.name !== undefined) await lockNames(tx, tenantId);
        if (!(await lockRow(tx, 'treatment_plan_templates', id))) return null;
        const current = await tx.treatmentPlanTemplate.findUniqueOrThrow({
          where: { id },
          include: WITH_LINES,
        });
        if (current.version !== input.expectedVersion) throw staleTemplate();
        if (input.name !== undefined) await assertNameFree(tx, input.name, id);
        if (input.lines !== undefined) {
          // Excepción legítima al borrado lógico: las líneas son la
          // configuración de la plantilla, sin datos de pacientes, y nada las
          // referencia (los ítems del plan no apuntan a la plantilla). El
          // cambio queda en audit_events.
          // eslint-disable-next-line no-restricted-syntax
          await tx.treatmentPlanTemplateLine.deleteMany({
            where: { templateId: id },
          });
          await tx.treatmentPlanTemplateLine.createMany({
            data: this.lineRows(input.lines).map((l) => ({
              ...l,
              tenantId,
              templateId: id,
            })),
          });
        }
        const row = await tx.treatmentPlanTemplate.update({
          where: { id },
          data: {
            name: input.name,
            visitIntervals: input.visitIntervals,
            active: input.active,
            version: { increment: 1 },
            updatedById: audit.actor.userId,
          },
          include: WITH_LINES,
        });
        const updated = mapToEntity(row);
        const event = configAuditEvent(audit, {
          action: 'UPDATE',
          resourceType: 'TREATMENT_PLAN_TEMPLATE',
          resourceId: id,
          reason: 'PLAN_TEMPLATE_UPDATED',
          before: planTemplateSnapshot(mapToEntity(current)),
          after: planTemplateSnapshot(updated),
          hiddenFields: PLAN_TEMPLATE_HIDDEN_FIELDS,
        });
        if (event) await writeAuditEvent(tx, event);
        return updated;
      })
      .catch(rethrowDuplicate);
  }
}
