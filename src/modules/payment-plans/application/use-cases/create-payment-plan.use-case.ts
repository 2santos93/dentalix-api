import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';
import { PaymentPlanWithInstallments } from '../../domain/entities/payment-plan.entity';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import {
  generateSchedule,
  Periodicity,
} from '../schedule/generate-schedule';

const PERIODICITIES: ReadonlySet<Periodicity> = new Set([
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
]);

export interface CreatePaymentPlanInput {
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: string | Date;
  totalToFinance?: number;
  notes?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

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
  ) {}

  async execute(
    treatmentPlanId: string,
    input: CreatePaymentPlanInput,
    createdById?: string,
  ): Promise<PaymentPlanWithInstallments> {
    if (!Number.isInteger(input.installmentsCount) || input.installmentsCount < 1) {
      throw new BadRequestException('installmentsCount must be an integer >= 1');
    }
    if (!isFiniteNonNegative(input.downPayment)) {
      throw new BadRequestException('downPayment must be a finite number >= 0');
    }
    if (!PERIODICITIES.has(input.periodicity)) {
      throw new BadRequestException('periodicity must be WEEKLY, BIWEEKLY or MONTHLY');
    }
    const startDate =
      input.startDate instanceof Date ? input.startDate : new Date(input.startDate);
    if (Number.isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid date');
    }
    if (
      input.totalToFinance !== undefined &&
      !isFiniteNonNegative(input.totalToFinance)
    ) {
      throw new BadRequestException('totalToFinance must be a finite number >= 0');
    }

    // Throws NotFound if absent/soft-deleted/cross-tenant — never re-derived.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);

    const existing = await this.repo.findActiveByPlan(treatmentPlanId);
    if (existing) {
      throw new ConflictException(
        'This treatment plan already has an active payment plan',
      );
    }

    let totalToFinance: number;
    if (input.totalToFinance !== undefined) {
      totalToFinance = round2(input.totalToFinance);
    } else {
      const balance = await this.getPlanBalance.execute(treatmentPlanId);
      totalToFinance = round2(balance.balance);
    }

    if (totalToFinance <= 0) {
      throw new BadRequestException('totalToFinance must be greater than 0');
    }
    const downPayment = round2(input.downPayment);
    if (downPayment > totalToFinance) {
      throw new BadRequestException('downPayment cannot exceed totalToFinance');
    }

    const installments = generateSchedule({
      totalToFinance,
      downPayment,
      installmentsCount: input.installmentsCount,
      periodicity: input.periodicity,
      startDate,
    });

    return this.repo.create({
      treatmentPlanId,
      patientId: plan.patientId,
      currency: plan.currency,
      totalToFinance,
      downPayment,
      installmentsCount: input.installmentsCount,
      periodicity: input.periodicity,
      startDate,
      notes: input.notes,
      createdById,
      installments,
    });
  }
}
