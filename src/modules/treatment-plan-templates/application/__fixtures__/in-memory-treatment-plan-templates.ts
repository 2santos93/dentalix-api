import type { CatalogKind } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
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
} from '../../domain/plan-template-rules';
import { duplicateTemplateName, staleTemplate } from '../plan-template-errors';

export interface FakeCatalogItem {
  id: string;
  kind: CatalogKind;
  labelEs: string;
  code?: string;
  active?: boolean;
  deleted?: boolean;
}

export const AUDIT_CTX: AuditRequestContext = {
  tenantId: 'tenant-1',
  locationId: null,
  actor: { userId: 'admin-1', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

/**
 * Repositorio de plantillas de plan en memoria con estado: los tests afirman
 * sobre `rows` como un e2e lo haría sobre la tabla.
 */
export class InMemoryTreatmentPlanTemplateRepository implements TreatmentPlanTemplateRepository {
  readonly rows: TreatmentPlanTemplate[] = [];
  readonly catalog = new Map<string, FakeCatalogItem>();
  /** Eventos de auditoría «escritos» (acción y reason). */
  readonly events: { action: string; reason: string; id: string }[] = [];
  private nextId = 1;

  addCatalogItem(item: FakeCatalogItem): void {
    this.catalog.set(item.id, item);
  }

  private toLines(templateId: string, lines: PlanTemplateDraft['lines']) {
    return lines.map((line, position) => {
      const item = this.catalog.get(line.catalogItemId);
      return {
        id: `${templateId}-l${position}-${this.nextId++}`,
        position,
        catalogItemId: line.catalogItemId,
        catalogItemLabel: item?.labelEs ?? '',
        catalogItemCode: item?.code ?? '',
        catalogItemActive: (item?.active ?? true) && !item?.deleted,
        quantity: line.quantity,
        visit: line.visit,
        visitLabel: line.visitLabel,
        asksSurfaces: line.asksSurfaces,
      };
    });
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const key = planTemplateNameKey(name);
    if (
      this.rows.some(
        (r) => r.id !== exceptId && planTemplateNameKey(r.name) === key,
      )
    ) {
      throw duplicateTemplateName();
    }
  }

  list(params: { includeInactive: boolean }): Promise<TreatmentPlanTemplate[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => params.includeInactive || r.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    );
  }

  findById(id: string): Promise<TreatmentPlanTemplate | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  catalogItems(ids: string[]): Promise<TemplateCatalogItem[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const item = this.catalog.get(id);
        return item && !item.deleted
          ? [{ id: item.id, kind: item.kind, labelEs: item.labelEs }]
          : [];
      }),
    );
  }

  create(
    input: CreatePlanTemplateRepoInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate> {
    this.assertNameFree(input.name, null);
    const id = `tpl-${this.nextId++}`;
    const now = new Date();
    const row: TreatmentPlanTemplate = {
      id,
      tenantId: audit.tenantId,
      name: input.name,
      active: input.active,
      version: 1,
      visitIntervals: { ...input.visitIntervals },
      lines: this.toLines(id, input.lines),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    this.events.push({ action: 'CREATE', reason: 'PLAN_TEMPLATE_CREATED', id });
    return Promise.resolve(row);
  }

  update(
    id: string,
    input: UpdatePlanTemplateRepoInput,
  ): Promise<TreatmentPlanTemplate | null> {
    const index = this.rows.findIndex((r) => r.id === id);
    if (index < 0) return Promise.resolve(null);
    const current = this.rows[index];
    if (current.version !== input.expectedVersion) throw staleTemplate();
    if (input.name !== undefined) this.assertNameFree(input.name, id);
    const next: TreatmentPlanTemplate = {
      ...current,
      name: input.name ?? current.name,
      visitIntervals: input.visitIntervals ?? current.visitIntervals,
      active: input.active ?? current.active,
      lines: input.lines ? this.toLines(id, input.lines) : current.lines,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    this.rows[index] = next;
    this.events.push({ action: 'UPDATE', reason: 'PLAN_TEMPLATE_UPDATED', id });
    return Promise.resolve(next);
  }
}
