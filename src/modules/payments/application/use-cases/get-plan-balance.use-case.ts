import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { TreatmentPlanItemStatus, TreatmentPlanStatus } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { isPlanBillable } from '../../../treatment-plans/domain/plan-status-machine';
import { PLAN_ALLOCATION_REPOSITORY } from '../../domain/ports/plan-allocation-repository.port';
import type { PlanAllocationRepository } from '../../domain/ports/plan-allocation-repository.port';
import { itemBillableCents } from '../../domain/allocation-rules';
import {
  paymentAmountIn,
  type PaymentWithRate,
} from '../payment-exchange-rate';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import {
  PLAN_CREDIT_READER,
  type PlanCreditReader,
} from '../../domain/ports/plan-credit-reader.port';

export interface GetPlanBalanceResult {
  planCurrency: string;
  /** 0 if the plan is not billable (REJECTED/CANCELLED, DX-109); otherwise
   * Σ (item.price − item.discount) for active items with status ACCEPTED|DONE (PROPOSED
   * items are not yet billable — see docs/plans/2026-07-24-payments-pivot.md
   * "Modelo"). Rounded to 2 decimals. */
  billable: number;
  /** Σ of every active payment for the plan, each converted to
   * `planCurrency` at ITS OWN `paidAt` date (never today's rate). Rounded
   * to 2 decimals. */
  paid: number;
  /** `billable - paid - creditMovements`, rounded to 2 decimals. */
  balance: number;
  /**
   * DX-253: Σ traspasos y devoluciones de saldo a favor del plan en su
   * moneda, con signo. No cambia los abonos ni `paid`.
   */
  creditMovements: number;
  /** Number of active payments for the plan. */
  paymentsCount: number;
  /**
   * DX-375: abonos vivos «sin tasa»: en otra moneda y sin tasa de su día
   * todavía, así que no cuentan en `paid` (el saldo queda incompleto) hasta
   * que se registre la tasa y el barrido la congele.
   */
  paymentsWithoutRate: PaymentWithoutRate[];
}

/** Un abono «sin tasa» del saldo (DX-375): nunca datos del paciente. */
export interface PaymentWithoutRate {
  paymentId: string;
  amount: number;
  currency: string;
  /** Día civil del abono en su sede: el de la tasa que falta. */
  paidOn: string;
}

/** Lo que la conversión necesita de un abono (el día civil ya resuelto). */
interface PlanPayment extends PaymentWithRate {
  id: string;
}

/** Cobrado y pendiente de un ítem del plan (DX-051). */
export interface PlanItemBalance {
  itemId: string;
  toothNumber: string;
  procedureName: string;
  status: TreatmentPlanItemStatus;
  billable: number;
  paid: number;
  balance: number;
}

export interface GetPlanBalanceWithItemsResult extends GetPlanBalanceResult {
  /** Σ de las imputaciones de los abonos vivos del plan. */
  allocated: number;
  /** Σ de los sobrantes de los abonos con base: lo cobrado sin ítem. */
  unallocated: number;
  /** Abonos vivos sin base (sin tasa o de moneda no soportada). */
  unconvertedPaymentsCount: number;
  /** Abonos cuya imputación fijó un ADMIN a mano. */
  manualPaymentIds: string[];
  /** En el orden del plan. */
  items: PlanItemBalance[];
}

// Same rounding policy as CreateSaleUseCase/ConvertAmountUseCase: monetary
// sums are rounded to 2 decimals to avoid floating point drift.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const BILLABLE_STATUSES: ReadonlySet<TreatmentPlanItemStatus> = new Set([
  TreatmentPlanItemStatus.ACCEPTED,
  TreatmentPlanItemStatus.DONE,
]);

/**
 * Computes the outstanding balance of a treatment plan: what's billable
 * (accepted + done items) minus what's actually been paid (active payments,
 * each converted to the plan's currency by its own paidAt date).
 */
@Injectable()
export class GetPlanBalanceUseCase {
  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly convertAmount: ConvertAmountUseCase,
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly allocations: PlanAllocationRepository,
    // DX-253: sin lector (tests que no lo proveen), ningún asiento.
    @Optional()
    @Inject(PLAN_CREDIT_READER)
    private readonly credit?: PlanCreditReader,
  ) {}

  /**
   * `execute` más el cobrado y pendiente por ítem (DX-051, R14). El plan, sus
   * ítems, los abonos y los hechos de imputación salen de UNA lectura
   * `RepeatableRead`; la conversión de moneda se hace fuera de ella, sobre
   * esos datos. Así lo imputado y lo facturable son de la misma foto.
   */
  async executeWithItems(
    treatmentPlanId: string,
  ): Promise<GetPlanBalanceWithItemsResult> {
    const snapshot =
      await this.allocations.readPlanBalanceSnapshot(treatmentPlanId);
    if (!snapshot) throw new NotFoundException('Treatment plan not found');
    const { plan, payments } = snapshot;
    // BE-050: un abono con base de imputación cuenta en `paid` por su base
    // (convertida con su tasa congelada e inmutable), así lo cobrado y el
    // desglose por ítem salen de la MISMA cifra y no descuadran nunca.
    const baseOf = new Map(
      snapshot.bases.map((b) => [b.paymentId, b.amount] as const),
    );
    const result = await this.compute(
      { ...plan, id: treatmentPlanId },
      snapshot.items,
      payments,
      baseOf,
    );
    const billablePlan = isPlanBillable(plan.status);

    const paidByItem = new Map<string, number>();
    const allocatedByPayment = new Map<string, number>();
    let allocatedCents = 0;
    for (const a of snapshot.allocations) {
      const cents = Math.round(a.amount * 100);
      paidByItem.set(a.itemId, (paidByItem.get(a.itemId) ?? 0) + cents);
      allocatedByPayment.set(
        a.paymentId,
        (allocatedByPayment.get(a.paymentId) ?? 0) + cents,
      );
      allocatedCents += cents;
    }

    const items: PlanItemBalance[] = snapshot.items.map((item) => {
      const billableCents = itemBillableCents(
        { ...item, deletedAt: null },
        billablePlan,
      );
      const paidCents = paidByItem.get(item.id) ?? 0;
      return {
        itemId: item.id,
        toothNumber: item.toothNumber,
        procedureName: item.procedureName,
        status: item.status,
        billable: billableCents / 100,
        paid: paidCents / 100,
        balance: (billableCents - paidCents) / 100,
      };
    });

    let unallocatedCents = 0;
    for (const base of snapshot.bases) {
      unallocatedCents +=
        Math.round(base.amount * 100) -
        (allocatedByPayment.get(base.paymentId) ?? 0);
    }
    const withBase = new Set(snapshot.bases.map((b) => b.paymentId));
    const unconvertedPaymentsCount = payments.filter(
      (p) => !withBase.has(p.id),
    ).length;

    return {
      ...result,
      allocated: allocatedCents / 100,
      unallocated: unallocatedCents / 100,
      unconvertedPaymentsCount,
      manualPaymentIds: snapshot.bases
        .filter((b) => b.manual)
        .map((b) => b.paymentId),
      items,
    };
  }

  async execute(treatmentPlanId: string): Promise<GetPlanBalanceResult> {
    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    const payments = await this.repo.listByPlan(treatmentPlanId);
    return this.compute(plan, plan.items, payments);
  }

  private async compute(
    plan: { id: string; status: TreatmentPlanStatus; currency: string },
    planItems: {
      status: TreatmentPlanItemStatus;
      price: number;
      discount: number;
    }[],
    payments: PlanPayment[],
    baseOf: ReadonlyMap<string, number> = new Map(),
  ): Promise<GetPlanBalanceResult> {
    // DX-109 (BE-001): un plan no cobrable (rechazado o cancelado) no debe
    // nada, la misma regla que el estado de cuenta; sus abonos siguen en
    // `paid`.
    const billable = !isPlanBillable(plan.status)
      ? 0
      : round2(
          planItems
            .filter((item) => BILLABLE_STATUSES.has(item.status))
            .reduce((sum, item) => sum + item.price - item.discount, 0),
        );

    let paid = 0;
    const paymentsWithoutRate: PaymentWithoutRate[] = [];
    // DX-374: un convertidor por cálculo, que lee la fuente de la clínica y
    // las tasas de cada día una sola vez (no una lectura por abono). Con la
    // tasa congelada (DX-375) ni siquiera se usa: solo los abonos anteriores
    // aún sin congelar se convierten con la tasa de su día.
    const convert = this.convertAmount.memoized();

    for (const payment of payments) {
      // IMP-4a/4b: cada abono se convierte por su propio importe (nunca
      // reutilizando un `rateUsed`, que depende del importe), y uno sin tasa
      // no tumba el saldo: no cuenta en `paid` y se informa «sin tasa»
      // (`paymentsCount` no cambia). Cualquier otro fallo se propaga.
      const converted =
        baseOf.get(payment.id) ??
        (await paymentAmountIn(convert, payment, plan.currency));
      if (converted === null) {
        paymentsWithoutRate.push({
          paymentId: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          paidOn: payment.paidOn,
        });
        continue;
      }
      paid += converted;
    }

    const creditMovements = this.credit
      ? round2(await this.credit.netCredit(plan.id, plan.currency))
      : 0;
    return {
      planCurrency: plan.currency,
      billable,
      paid: round2(paid),
      creditMovements,
      balance: round2(billable - paid - creditMovements),
      paymentsCount: payments.length,
      paymentsWithoutRate,
    };
  }
}
