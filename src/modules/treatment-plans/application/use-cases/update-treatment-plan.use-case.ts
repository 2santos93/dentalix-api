import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
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
import { GetDiscountPolicyUseCase } from '../../../discounts/application/use-cases/discount-policy.use-cases';
import { assertCurrencyChangeKeepsDiscounts } from './item-discount';
import { UNKNOWN_CURRENCY_MESSAGE } from '../../../../shared/money/currency-messages';
import { locationTimeZoneRequired } from '../../../../shared/locations/location-time-zone';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import {
  QUOTE_EXPIRY_REGIONAL,
  type QuoteExpiryRegional,
  type QuoteExpiryRegionalReader,
} from '../../domain/ports/quote-expiry-regional.port';
import { isQuoteExpired, quoteCanExpire } from '../../domain/quote-validity';
import { quoteExpiredStatusMessage } from '../../domain/expired-quote-acceptance';
import { quoteExpiredConflict } from '../quote-expiry';

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
/**
 * DX-513-bis §5.6: la referencia de cada ítem (y su foto convertida) está en
 * la moneda del plan de cuando se escribió: un plan con algún ítem vivo con
 * precio de referencia ya no cambia de moneda (cierra H1, R1 y R2 de DX-513).
 * Los ítems libres no bloquean.
 */
export const CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE =
  'PLAN_CURRENCY_LOCKED_BY_PRICED_ITEMS';
export const CURRENCY_LOCKED_BY_PRICED_ITEMS_MESSAGE =
  'El plan ya tiene ítems con precio de referencia: su moneda no cambia. Crea el plan en la otra moneda o quita esos ítems.';
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
/** DX-379 (C): el plan se presentó entre la lectura de su sede y el bloqueo. */
export const PLAN_CHANGED_RETRY_MESSAGE =
  'El plan cambió mientras se aceptaba: vuelve a intentarlo.';

/**
 * Sin lector configurado (unit anteriores a DX-379 C): no hay sede, así que
 * un plan CON validez guardada no se acepta por PATCH (409), nunca se acepta
 * vencido por no saberlo.
 */
const UNCONFIGURED_EXPIRY_REGIONAL: QuoteExpiryRegionalReader = {
  forPlan: () => Promise.resolve(null),
};

/**
 * DX-379 (C, D-6): aceptar sin firma (PATCH «Aceptado») un presupuesto
 * vencido no se puede: no hay documento firmado donde dejar el motivo. Con el
 * día civil de la sede del plan (la de la presentación o la de escritura),
 * como `quoteExpired`. Solo un borrador o un plan presentado con validez
 * guardada puede estar vencido.
 */
function assertQuoteNotExpired(
  plan: TreatmentPlan,
  regional: QuoteExpiryRegional | null,
  at: Date,
): void {
  const validUntil = plan.quoteValidUntil;
  if (validUntil === null || !quoteCanExpire(plan.status)) return;
  if (!regional || regional.presentedLocationId !== plan.presentedLocationId) {
    throw new ConflictException(PLAN_CHANGED_RETRY_MESSAGE);
  }
  if (!regional.timeZone) throw locationTimeZoneRequired(regional.locationId);
  if (!isQuoteExpired(validUntil, at, regional.timeZone)) return;
  const day = requireLocationFormat({
    id: regional.locationId,
    locale: regional.locale,
    hourCycle: regional.hourCycle,
  }).civilDate(validUntil);
  throw quoteExpiredConflict(validUntil, quoteExpiredStatusMessage(day));
}

@Injectable()
export class UpdateTreatmentPlanUseCase {
  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    @Inject(TREATMENT_PLAN_CLOCK)
    private readonly now: PlanClock,
    private readonly discountPolicy: GetDiscountPolicyUseCase,
    @Optional()
    @Inject(QUOTE_EXPIRY_REGIONAL)
    private readonly expiryRegional: QuoteExpiryRegionalReader = UNCONFIGURED_EXPIRY_REGIONAL,
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
        throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
      }
    }
    const at = this.now();
    // DX-513: la política de descuentos, para volver a medir los ítems si la
    // moneda cambia (se lee antes de la transacción, como en el alta).
    const policy =
      currency !== undefined ? await this.discountPolicy.execute() : null;
    // DX-379 (C): para aceptar, la sede con la que se decide si el
    // presupuesto venció (antes de la transacción; dentro se comprueba que
    // sigue siendo la misma).
    const regional =
      status === TreatmentPlanStatus.ACCEPTED
        ? await this.expiryRegional.forPlan(id)
        : null;

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
        if (status === TreatmentPlanStatus.ACCEPTED) {
          assertQuoteNotExpired(existing, regional, at);
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
          // Antes que los abonos: con asientos, anular los abonos no
          // desbloquearía la moneda y ese mensaje engañaría.
          if (facts.hasCreditEntries) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: CURRENCY_LOCKED_BY_CREDIT_CODE,
              message: CURRENCY_LOCKED_BY_CREDIT_MESSAGE,
            });
          }
          if (facts.hasLivePayments) {
            throw new ConflictException(CURRENCY_LOCKED_BY_PAYMENTS_MESSAGE);
          }
          if (facts.hasActivePaymentPlan) {
            throw new ConflictException(
              CURRENCY_LOCKED_BY_PAYMENT_PLAN_MESSAGE,
            );
          }
          // DX-513-bis §5.6: con algún ítem vivo con referencia, la moneda
          // ya no cambia (su referencia y su foto están en esta moneda).
          if (existing.items.some((item) => item.catalogPrice !== null)) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: CURRENCY_LOCKED_BY_PRICED_ITEMS_CODE,
              message: CURRENCY_LOCKED_BY_PRICED_ITEMS_MESSAGE,
            });
          }
          // DX-513 (revisión H1): sin ítems con referencia no hay rebaja que
          // pueda aparecer o desaparecer; la comprobación queda como red.
          if (policy) {
            assertCurrencyChangeKeepsDiscounts(
              policy,
              { role: actor.role, userId: actor.userId ?? '' },
              existing.items,
              existing.currency,
              currency,
              at,
            );
          }
        }
        patch.currency = currency;
      }
      return patch;
    });
  }
}
