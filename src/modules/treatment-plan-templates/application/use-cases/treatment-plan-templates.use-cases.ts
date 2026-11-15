import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { TreatmentPlanTemplate } from '../../domain/entities/treatment-plan-template.entity';
import {
  TREATMENT_PLAN_TEMPLATE_REPOSITORY,
  type TreatmentPlanTemplateRepository,
} from '../../domain/ports/treatment-plan-template-repository.port';
import {
  normalizePlanTemplate,
  planTemplateError,
  type PlanTemplateDraft,
  type VisitIntervals,
} from '../../domain/plan-template-rules';
import {
  catalogItemNotFound,
  notAProcedure,
  PLAN_TEMPLATE_NOT_FOUND_MESSAGE,
  staleTemplate,
} from '../plan-template-errors';

export interface PlanTemplateLineInput {
  catalogItemId: string;
  quantity?: number;
  visit?: number;
  visitLabel?: string | null;
  asksSurfaces?: boolean;
}

export interface CreatePlanTemplateInput {
  name: string;
  visitIntervals?: VisitIntervals;
  lines: PlanTemplateLineInput[];
  active?: boolean;
}

export interface UpdatePlanTemplateInput {
  name?: string;
  visitIntervals?: VisitIntervals;
  lines?: PlanTemplateLineInput[];
  active?: boolean;
  /** Versión leída; si cambió, 409 PLAN_TEMPLATE_STALE. */
  version: number;
}

function toLines(lines: PlanTemplateLineInput[]): PlanTemplateDraft['lines'] {
  return lines.map((line) => ({
    catalogItemId: line.catalogItemId,
    quantity: line.quantity ?? 1,
    visit: line.visit ?? 1,
    visitLabel: line.visitLabel ?? null,
    asksSurfaces: line.asksSurfaces ?? false,
  }));
}

/** Valida y normaliza; 400 en español con el primer problema. */
function validDraft(draft: PlanTemplateDraft): PlanTemplateDraft {
  const error = planTemplateError(draft);
  if (error !== null) throw new BadRequestException(error);
  return normalizePlanTemplate(draft);
}

/**
 * Cada línea apunta a un PROCEDIMIENTO vivo de esta clínica: uno de otra
 * clínica, inexistente o retirado da 404; un diagnóstico, 422. Uno
 * desactivado SÍ se admite (la lectura lo marca y aplicar lo omite, D6).
 */
async function assertProcedures(
  repo: TreatmentPlanTemplateRepository,
  lines: PlanTemplateDraft['lines'],
): Promise<void> {
  const found = await repo.catalogItems([
    ...new Set(lines.map((l) => l.catalogItemId)),
  ]);
  const byId = new Map(found.map((item) => [item.id, item]));
  for (const [position, line] of lines.entries()) {
    const item = byId.get(line.catalogItemId);
    if (!item) throw catalogItemNotFound(position);
    if (item.kind !== 'PROCEDURE') throw notAProcedure(position, item.labelEs);
  }
}

@Injectable()
export class ListPlanTemplatesUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_TEMPLATE_REPOSITORY)
    private readonly repo: TreatmentPlanTemplateRepository,
  ) {}

  /** Por defecto solo las activas (el selector del plan). */
  execute(params: {
    includeInactive?: boolean;
  }): Promise<TreatmentPlanTemplate[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

@Injectable()
export class GetPlanTemplateUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_TEMPLATE_REPOSITORY)
    private readonly repo: TreatmentPlanTemplateRepository,
  ) {}

  async execute(id: string): Promise<TreatmentPlanTemplate> {
    const template = await this.repo.findById(id);
    if (!template) throw new NotFoundException(PLAN_TEMPLATE_NOT_FOUND_MESSAGE);
    return template;
  }
}

@Injectable()
export class CreatePlanTemplateUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_TEMPLATE_REPOSITORY)
    private readonly repo: TreatmentPlanTemplateRepository,
  ) {}

  async execute(
    input: CreatePlanTemplateInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate> {
    const draft = validDraft({
      name: input.name,
      visitIntervals: input.visitIntervals ?? {},
      lines: toLines(input.lines),
    });
    await assertProcedures(this.repo, draft.lines);
    return this.repo.create({ ...draft, active: input.active ?? true }, audit);
  }
}

@Injectable()
export class UpdatePlanTemplateUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_TEMPLATE_REPOSITORY)
    private readonly repo: TreatmentPlanTemplateRepository,
  ) {}

  /**
   * Cambia lo que venga y valida la plantilla RESULTANTE (unos intervalos
   * nuevos se comprueban contra las líneas actuales y al revés). `lines`, si
   * viene, sustituye todas. Ni esto ni desactivarla toca los planes ya
   * creados (D11).
   */
  async execute(
    id: string,
    input: UpdatePlanTemplateInput,
    audit: AuditRequestContext,
  ): Promise<TreatmentPlanTemplate> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(PLAN_TEMPLATE_NOT_FOUND_MESSAGE);
    // Aviso rápido; la comprobación que cuenta es la atómica del repositorio.
    if (input.version !== current.version) throw staleTemplate();

    const touchesContent =
      input.name !== undefined ||
      input.visitIntervals !== undefined ||
      input.lines !== undefined;
    if (!touchesContent) {
      const updated = await this.repo.update(
        id,
        { active: input.active, expectedVersion: input.version },
        audit,
      );
      if (!updated) {
        throw new NotFoundException(PLAN_TEMPLATE_NOT_FOUND_MESSAGE);
      }
      return updated;
    }

    const draft = validDraft({
      name: input.name ?? current.name,
      visitIntervals: input.visitIntervals ?? current.visitIntervals,
      lines: input.lines ? toLines(input.lines) : current.lines,
    });
    if (input.lines !== undefined)
      await assertProcedures(this.repo, draft.lines);
    const updated = await this.repo.update(
      id,
      {
        name: draft.name,
        visitIntervals: draft.visitIntervals,
        lines: input.lines !== undefined ? draft.lines : undefined,
        active: input.active,
        expectedVersion: input.version,
      },
      audit,
    );
    if (!updated) throw new NotFoundException(PLAN_TEMPLATE_NOT_FOUND_MESSAGE);
    return updated;
  }
}
