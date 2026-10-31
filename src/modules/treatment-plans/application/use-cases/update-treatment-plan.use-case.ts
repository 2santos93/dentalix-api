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
  PLAN_STATUS_LABELS,
  acceptPlanError,
  isPlanClosed,
  planTransitionError,
} from '../../domain/plan-status-machine';
import { normalizeOptionLabel } from '../../domain/plan-options';
import { TREATMENT_PLAN_CLOCK, type PlanClock } from '../plan-clock';
import { SIGNED_PLAN_HEADER_LOCKED_MESSAGE } from './signed-plan-lock';
import { FEE_PLAN_LOCKED_MESSAGE } from '../../../cancellation-fees/domain/cancellation-fee';

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
  /** Usuario del token: autor de la cancelación del plan de cuotas (DX-109). */
  userId?: string;
}

export const USE_PLAN_ACTIONS_MESSAGE =
  'Para presentar o rechazar un plan usa sus acciones «Presentar» y «Rechazar».';
export const CURRENCY_LOCKED_BY_PAYMENTS_MESSAGE =
  'El plan tiene abonos registrados: su moneda ya no cambia. Anula los abonos antes de cambiarla.';
/**
 * DX-438: los asientos del saldo a favor están en la moneda del plan y los
 * saldos solo suman los de su moneda actual: cambiarla haría desaparecer ese
 * saldo. Vale aunque el plan no tenga abonos (un borrador que recibió un
 * traspaso). La red es el trigger `treatment_plans_credit_currency_locked`.
 */
export const CURRENCY_LOCKED_BY_CREDIT_CODE = 'PLAN_CURRENCY_LOCKED_BY_CREDIT';
export const CURRENCY_LOCKED_BY_CREDIT_MESSAGE =
  'El plan tiene saldo a favor traspasado o devuelto: su moneda ya no cambia, porque ese saldo está en la moneda actual del plan.';
export const CURRENCY_LOCKED_BY_PAYMENT_PLAN_MESSAGE =
  'El plan tiene un plan de cuotas activo: cancélalo antes de cambiar la moneda.';
/** Motivo que queda en el plan de cuotas cancelado junto a su plan (DX-109). */
export const PAYMENT_PLAN_CANCELLED_WITH_TREATMENT_REASON =
  'Se canceló el plan de tratamiento.';

export function closedPlanCurrencyMessage(status: TreatmentPlanStatus): string {
  return `El plan está «${PLAN_STATUS_LABELS[status]}»: su moneda ya no cambia.`;
}

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
    return this.repo.updatePlan(id, (existing, facts) => {
      // SEC-050: el plan que lleva un cargo vigente no se cancela ni cambia de
      // moneda (dejaría de cobrarse); completarlo sí. El trigger
      // `treatment_plans_cancellation_fee_locked` es la red.
      if (
        existing.items.some((item) => item.cancellationFeeAppointmentId) &&
        ((status !== undefined &&
          status !== existing.status &&
          status !== TreatmentPlanStatus.COMPLETED) ||
          (currency !== undefined && currency !== existing.currency))
      ) {
        throw new ConflictException(FEE_PLAN_LOCKED_MESSAGE);
      }
      const patch: UpdateTreatmentPlanRepoInput = {};
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.optionLabel !== undefined) {
        patch.optionLabel = normalizeOptionLabel(input.optionLabel);
      }
      if (status !== undefined && status !== existing.status) {
        // Aceptar sigue la MISMA regla que la aceptación firmada (DX-109).
        const error =
          status === TreatmentPlanStatus.ACCEPTED
            ? acceptPlanError(existing.status, { allowAlreadyAccepted: false })
            : planTransitionError(existing.status, status);
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
        if (status === TreatmentPlanStatus.ACCEPTED) {
          patch.acceptedAt = at;
          patch.acceptedById = actor.userId ?? null;
        }
        if (status === TreatmentPlanStatus.CANCELLED) {
          patch.cancellation = {
            at,
            byId: actor.userId ?? null,
            reason: PAYMENT_PLAN_CANCELLED_WITH_TREATMENT_REASON,
          };
        }
      }
      if (currency !== undefined) {
        if (currency !== existing.currency) {
          // Aceptado con firma (DX-012): los importes firmados no cambian de
          // moneda. Cerrado, cobrado o financiado (DX-109): tampoco, porque
          // el saldo y las cuotas se calculan en esta moneda. Con saldo a favor
          // en asientos (DX-438), tampoco: esos asientos son de esta moneda.
          if (existing.acceptance) {
            throw new ConflictException(SIGNED_PLAN_HEADER_LOCKED_MESSAGE);
          }
          if (isPlanClosed(existing.status)) {
            throw new ConflictException(
              closedPlanCurrencyMessage(existing.status),
            );
          }
          if (facts.hasLivePayments) {
            throw new ConflictException(CURRENCY_LOCKED_BY_PAYMENTS_MESSAGE);
          }
          if (facts.hasCreditEntries) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: CURRENCY_LOCKED_BY_CREDIT_CODE,
              message: CURRENCY_LOCKED_BY_CREDIT_MESSAGE,
            });
          }
          if (facts.hasActivePaymentPlan) {
            throw new ConflictException(
              CURRENCY_LOCKED_BY_PAYMENT_PLAN_MESSAGE,
            );
          }
        }
        patch.currency = currency;
      }
      return patch;
    });
  }
}
