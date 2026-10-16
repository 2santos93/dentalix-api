import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';
import { TREATMENT_PLAN_REPOSITORY } from '../../domain/ports/treatment-plan-repository.port';
import type {
  TreatmentPlanRepository,
  UpdateTreatmentPlanRepoInput,
} from '../../domain/ports/treatment-plan-repository.port';
import { CURRENCY_WHITELIST } from '../../domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';
import { TreatmentPlan } from '../../domain/entities/treatment-plan.entity';
import {
  PLAN_DECISION_ROLES,
  planTransitionError,
} from '../../domain/plan-status-machine';
import { normalizeOptionLabel } from '../../domain/plan-options';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';
import { SIGNED_PLAN_HEADER_LOCKED_MESSAGE } from './signed-plan-lock';

/** Lo que admite el PATCH del plan. */
export interface UpdateTreatmentPlanInput {
  status?: TreatmentPlanStatus;
  currency?: string;
  notes?: string | null;
  optionLabel?: string | null;
}

/** Quién hace el cambio (del token, nunca del cuerpo). */
export interface PlanActor {
  role: ClinicRole;
}

export const USE_PLAN_ACTIONS_MESSAGE =
  'Para presentar o rechazar un plan usa sus acciones «Presentar» y «Rechazar».';
export const ACCEPT_ROLE_MESSAGE =
  'Solo el odontólogo o la administración aceptan un plan de tratamiento.';

@Injectable()
export class UpdateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
  ) {}

  /**
   * Cambia estado, moneda, notas o etiqueta de la opción. El estado sigue la
   * máquina de estados (409 si la transición no existe, DX-040); presentar y
   * rechazar tienen su propia acción porque llevan datos (sede, motivo).
   * Aceptar es del odontólogo o la administración y rechaza en la misma
   * transacción a las demás opciones abiertas del grupo.
   */
  async execute(
    id: string,
    input: UpdateTreatmentPlanInput,
    actor: PlanActor,
  ): Promise<TreatmentPlan> {
    const { status } = input;
    if (
      status === TreatmentPlanStatus.PRESENTED ||
      status === TreatmentPlanStatus.REJECTED
    ) {
      throw new BadRequestException(USE_PLAN_ACTIONS_MESSAGE);
    }

    // Only validate when the caller actually wants to change the currency —
    // an omitted `currency` must never re-validate (or otherwise touch) the
    // plan's existing one.
    let currency: string | undefined;
    if (input.currency !== undefined) {
      currency = input.currency.toUpperCase();
      if (!(await this.whitelist.has(currency))) {
        throw new BadRequestException(`Moneda desconocida: ${currency}`);
      }
    }
    const at = this.now();

    // Missing row and another tenant's row are indistinguishable under RLS:
    // the repository answers both with 404.
    return this.repo.updatePlan(id, (existing) => {
      const patch: UpdateTreatmentPlanRepoInput = {};
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.optionLabel !== undefined) {
        patch.optionLabel = normalizeOptionLabel(input.optionLabel);
      }
      if (status !== undefined && status !== existing.status) {
        const error = planTransitionError(existing.status, status);
        if (error) throw new ConflictException(error);
        // Solo cuenta si de verdad pasa a aceptado: repetir ACCEPTED junto a
        // unas notas no es aceptar.
        if (
          status === TreatmentPlanStatus.ACCEPTED &&
          !PLAN_DECISION_ROLES.includes(actor.role)
        ) {
          throw new ForbiddenException(ACCEPT_ROLE_MESSAGE);
        }
        patch.status = status;
        if (status === TreatmentPlanStatus.ACCEPTED) patch.acceptedAt = at;
      }
      if (currency !== undefined) {
        // Aceptado con firma (DX-012): los importes firmados no cambian de
        // moneda. Cerrarlo y las notas, sí.
        if (existing.acceptance && currency !== existing.currency) {
          throw new ConflictException(SIGNED_PLAN_HEADER_LOCKED_MESSAGE);
        }
        patch.currency = currency;
      }
      return patch;
    });
  }
}
