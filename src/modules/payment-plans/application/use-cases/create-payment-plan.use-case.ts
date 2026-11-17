import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';
import { PaymentPlanWithInstallments } from '../../domain/entities/payment-plan.entity';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import type { Periodicity } from '../schedule/generate-schedule';
import {
  parseInstallmentTerms,
  planInstallmentSchedule,
} from '../schedule/installment-schedule';
import { round2 } from '../../../../shared/money/money';
import { TOTAL_TO_FINANCE_MESSAGE } from '../../../../shared/money/currency-messages';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';

export interface CreatePaymentPlanInput {
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: string | Date;
  totalToFinance?: number;
  notes?: string;
  /** DX-091: ver `CreatePaymentPlanRepoInput.lockActor`. */
  lockActor?: LockActor | null;
}

/**
 * DX-488: las cuotas se reparten en unidades de la moneda del plan; sin sus
 * decimales en `currencies` no hay reparto (422, no un 500).
 */
export const PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE = (code: string): string =>
  `La moneda ${code} del plan no está en el catálogo de monedas: no se pueden repartir las cuotas.`;

export const ACTIVE_PAYMENT_PLAN_MESSAGE =
  'Este plan de tratamiento ya tiene un plan de cuotas activo.';

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

@Injectable()
export class CreatePaymentPlanUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
    // Same cross-module DI pattern as RecordPaymentUseCase: "does the plan
    // exist / what are its patientId & currency" live in exactly one place.
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    // Reused so the default totalToFinance uses the SAME balance math
    // (accepted+done items − paid, multi-currency) as everywhere else.
    private readonly getPlanBalance: GetPlanBalanceUseCase,
    // DX-488: las cuotas se reparten en unidades de la moneda del plan.
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
  ) {}

  async execute(
    treatmentPlanId: string,
    input: CreatePaymentPlanInput,
    createdById?: string,
  ): Promise<PaymentPlanWithInstallments> {
    // DX-041: la validación y el reparto son los de la simulación.
    const terms = parseInstallmentTerms(input);
    if (
      input.totalToFinance !== undefined &&
      !isFiniteNonNegative(input.totalToFinance)
    ) {
      throw new BadRequestException(TOTAL_TO_FINANCE_MESSAGE);
    }

    // Throws NotFound if absent/soft-deleted/cross-tenant — never re-derived.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    // DX-109 (BE-013): un plan rechazado o cancelado no se financia. El
    // repositorio lo vuelve a comprobar con el plan bloqueado.
    if (!isPlanBillable(plan.status)) {
      throw new ConflictException(notBillableMessage(plan.status));
    }

    const existing = await this.repo.findActiveByPlan(treatmentPlanId);
    if (existing) {
      throw new ConflictException(ACTIVE_PAYMENT_PLAN_MESSAGE);
    }

    let totalToFinance: number;
    if (input.totalToFinance !== undefined) {
      totalToFinance = round2(input.totalToFinance);
    } else {
      // Default is the plan's full billable (gross), not the net balance:
      // prior abonos already count as paid against it, and read-time
      // paidTotal (GetPlanBalanceUseCase) is all-time paid, so financing the
      // net balance would double-count anything already paid.
      const balance = await this.getPlanBalance.execute(treatmentPlanId);
      totalToFinance = round2(balance.billable);
    }

    const digits = await this.currencyDigits.table([plan.currency]);
    if (!digits.has(plan.currency)) {
      throw new UnprocessableEntityException(
        PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE(plan.currency),
      );
    }
    const schedule = planInstallmentSchedule(
      terms,
      totalToFinance,
      digits.roundingDigits(plan.currency),
    );

    try {
      return await this.repo.create({
        treatmentPlanId,
        patientId: plan.patientId,
        currency: plan.currency,
        totalToFinance: schedule.totalToFinance,
        downPayment: schedule.downPayment,
        installmentsCount: schedule.installmentsCount,
        periodicity: schedule.periodicity,
        startDate: schedule.startDate,
        notes: input.notes,
        createdById,
        installments: schedule.installments,
        lockActor: input.lockActor ?? null,
      });
    } catch (error) {
      // Backstop for the check-then-act race above: two concurrent POSTs can
      // both pass findActiveByPlan before either inserts. The DB-level
      // partial unique index (payment_plans_active_unique) rejects the
      // loser with P2002, which we map to the same 409 the fast-path check
      // above returns.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(ACTIVE_PAYMENT_PLAN_MESSAGE);
      }
      throw error;
    }
  }
}
