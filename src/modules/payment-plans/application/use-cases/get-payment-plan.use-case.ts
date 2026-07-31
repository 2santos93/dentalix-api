import { Injectable, NotFoundException } from '@nestjs/common';
import {
  PaymentPlanStatus,
  PaymentPlanWithInstallments,
} from '../../domain/entities/payment-plan.entity';
import { GetPlanBalanceUseCase } from '../../../payments/application/use-cases/get-plan-balance.use-case';
import { PAYMENT_PLAN_REPOSITORY } from '../../domain/ports/payment-plan-repository.port';
import type { PaymentPlanRepository } from '../../domain/ports/payment-plan-repository.port';
import { Periodicity } from '../schedule/generate-schedule';
import {
  deriveStatuses,
  InstallmentStatus,
  ScheduleTramo,
} from '../schedule/derive-statuses';
import { Inject } from '@nestjs/common';

export interface DerivedInstallmentView {
  sequence: number;
  dueDate: Date;
  amount: number;
  covered: number;
  status: InstallmentStatus;
}

export interface TramoView {
  amount: number;
  dueDate: Date;
  covered: number;
  status: InstallmentStatus;
}

export interface GetPaymentPlanResult {
  id: string;
  treatmentPlanId: string;
  currency: string;
  status: PaymentPlanStatus;
  totalToFinance: number;
  downPayment: number;
  financedAmount: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  paidTotal: number;
  remaining: number;
  downPaymentStatus: TramoView | null;
  installments: DerivedInstallmentView[];
  nextDue: { sequence: number | null; dueDate: Date; amount: number } | null;
  overdueCount: number;
  overdueAmount: number;
  isFullyPaid: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Injectable clock so specs pass a fixed "today"; production uses the real one.
export type Clock = () => Date;
export const CLOCK = Symbol('CLOCK');

@Injectable()
export class GetPaymentPlanUseCase {
  constructor(
    @Inject(PAYMENT_PLAN_REPOSITORY)
    private readonly repo: PaymentPlanRepository,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
    @Inject(CLOCK)
    private readonly now: Clock,
  ) {}

  async execute(treatmentPlanId: string): Promise<GetPaymentPlanResult> {
    const plan = await this.repo.findActiveByPlan(treatmentPlanId);
    if (!plan) {
      throw new NotFoundException('No active payment plan for this treatment plan');
    }

    // Reuse the exact multi-currency "paid" total (converted to plan currency
    // by each payment's own paidAt date) instead of re-implementing it.
    const balance = await this.getPlanBalance.execute(treatmentPlanId);
    const paidTotal = round2(balance.paid);

    const tramos = this.buildTramos(plan);
    const derived = deriveStatuses(tramos, paidTotal, this.now());

    const financedAmount = round2(plan.totalToFinance - plan.downPayment);
    const remaining = round2(Math.max(plan.totalToFinance - paidTotal, 0));

    const hasDown = plan.downPayment > 0;
    const downDerived = hasDown ? derived[0] : null;
    const instDerived = hasDown ? derived.slice(1) : derived;

    const installments: DerivedInstallmentView[] = instDerived.map((t) => ({
      sequence: t.sequence as number,
      dueDate: t.dueDate,
      amount: t.amount,
      covered: t.covered,
      status: t.status,
    }));

    const overdue = derived.filter((t) => t.status === 'OVERDUE');
    const nextDueTramo = derived.find((t) => t.status !== 'PAID') ?? null;

    return {
      id: plan.id,
      treatmentPlanId: plan.treatmentPlanId,
      currency: plan.currency,
      status: plan.status,
      totalToFinance: plan.totalToFinance,
      downPayment: plan.downPayment,
      financedAmount,
      installmentsCount: plan.installmentsCount,
      periodicity: plan.periodicity,
      startDate: plan.startDate,
      paidTotal,
      remaining,
      downPaymentStatus: downDerived
        ? {
            amount: downDerived.amount,
            dueDate: downDerived.dueDate,
            covered: downDerived.covered,
            status: downDerived.status,
          }
        : null,
      installments,
      nextDue: nextDueTramo
        ? {
            sequence: nextDueTramo.sequence,
            dueDate: nextDueTramo.dueDate,
            amount: nextDueTramo.amount,
          }
        : null,
      overdueCount: overdue.length,
      overdueAmount: round2(
        overdue.reduce((s, t) => s + (t.amount - t.covered), 0),
      ),
      isFullyPaid: remaining <= 0,
    };
  }

  private buildTramos(plan: PaymentPlanWithInstallments): ScheduleTramo[] {
    const tramos: ScheduleTramo[] = [];
    if (plan.downPayment > 0) {
      tramos.push({
        kind: 'DOWN_PAYMENT',
        sequence: null,
        dueDate: plan.startDate,
        amount: plan.downPayment,
      });
    }
    for (const inst of [...plan.installments].sort((a, b) => a.sequence - b.sequence)) {
      tramos.push({
        kind: 'INSTALLMENT',
        sequence: inst.sequence,
        dueDate: inst.dueDate,
        amount: inst.amount,
      });
    }
    return tramos;
  }
}
