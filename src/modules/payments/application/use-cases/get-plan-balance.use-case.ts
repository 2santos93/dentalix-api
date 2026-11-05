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
import type {
  PlanAllocationRepository,
  PlanBalanceSnapshot,
} from '../../domain/ports/plan-allocation-repository.port';
import { itemBillableCents } from '../../domain/allocation-rules';
import type { PaymentWithRate } from '../payment-exchange-rate';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import {
  PlanBalanceCalculator,
  type PlanBalanceOptions,
} from '../plan-balance-calculator';
import {
  PLAN_CREDIT_READER,
  type PlanCreditReader,
} from '../../domain/ports/plan-credit-reader.port';
import { toCents } from '../../../../shared/money/money';

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
  /**
   * DX-054: el proveedor de tasas no respondió dentro del plazo del saldo
   * (`BALANCE_CONVERSION_BUDGET_MS`), se sabe que no contesta o su cupo está
   * agotado (DX-472): no consta que falte la tasa. Los abonos que esperaban su tasa salen en `paymentsWithoutRate` y no
   * suman. Volver a pedir el saldo lo completa cuando el proveedor responda.
   * `false` en el caso normal.
   */
  rateProviderTimedOut: boolean;
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
export interface PlanPayment extends PaymentWithRate {
  id: string;
}

/**
 * DX-472: lo que el saldo de un plan necesita, ya leído por quien llama en su
 * propia foto (el estado de cuenta lee todos los planes del paciente de una).
 */
export interface PlanBalanceInput {
  plan: { id: string; status: TreatmentPlanStatus; currency: string };
  /** Ítems vivos; `compute` se queda con los cobrables. */
  items: {
    status: TreatmentPlanItemStatus;
    price: number;
    discount: number;
  }[];
  /** Abonos VIVOS del plan. */
  payments: PlanPayment[];
  /** Base de imputación por abono: si la tiene, `paid` cuenta por ella. */
  baseOf: ReadonlyMap<string, number>;
  /** Σ de los asientos del saldo a favor del plan, en su moneda. */
  creditMovements: number;
  /**
   * DX-472-bis: lo ya sumado en la moneda del plan por quien llama (la
   * cartera lo lee de su resumen: abonos en esa moneda y los de otra con
   * base). Se suma a `paid`; `payments` trae solo lo que falta convertir.
   */
  paidKnown?: number;
  /**
   * DX-472-bis: el facturable ya sumado (Σ precio − Σ descuento de los ítems
   * cobrables, la misma cifra que `linesTotal`), en vez de `items`.
   */
  billable?: number;
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
  /**
   * Σ de los sobrantes de los abonos con base, NETO de lo devuelto o
   * traspasado que se les atribuye (DX-399-ter, la regla de `credit-netting`):
   * lo cobrado sin ítem que sigue a cuenta. La misma cifra que el informe
   * «Cobrado sin imputar» y la ventana «Ver imputación».
   */
  unallocated: number;
  /** Abonos vivos sin base (sin tasa o de moneda no soportada). */
  unconvertedPaymentsCount: number;
  /** Abonos cuya imputación fijó un ADMIN a mano. */
  manualPaymentIds: string[];
  /** En el orden del plan. */
  items: PlanItemBalance[];
}

/**
 * Computes the outstanding balance of a treatment plan: what's billable
 * (accepted + done items) minus what's actually been paid (active payments,
 * each converted to the plan's currency by its own paidAt date).
 */
@Injectable()
export class GetPlanBalanceUseCase {
  /** DX-472-bis: la cuenta del saldo, la misma que usan la cartera y el chip. */
  private readonly calculator: PlanBalanceCalculator;

  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    convertAmount: ConvertAmountUseCase,
    @Inject(PLAN_ALLOCATION_REPOSITORY)
    private readonly allocations: PlanAllocationRepository,
    // DX-253: sin lector (tests que no lo proveen), ningún asiento.
    @Optional()
    @Inject(PLAN_CREDIT_READER)
    private readonly credit?: PlanCreditReader,
  ) {
    this.calculator = new PlanBalanceCalculator(convertAmount);
  }

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
    const result = await this.computeOne(
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
      const cents = toCents(a.amount);
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

    // DX-399-ter: neto de lo que ya salió del saldo a favor, por la MISMA
    // cascada del informe y de la ventana (calculada en la foto del repositorio).
    let unallocatedCents = -snapshot.creditOutCents;
    for (const base of snapshot.bases) {
      unallocatedCents +=
        toCents(base.amount) - (allocatedByPayment.get(base.paymentId) ?? 0);
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
    return this.computeOne(plan, plan.items, payments);
  }

  /**
   * DX-472: el saldo de varios planes con la MISMA cuenta que `execute`, sobre
   * datos ya leídos, y UN solo plazo para todos (`PlanBalanceCalculator`).
   */
  computeMany(
    inputs: readonly PlanBalanceInput[],
    options?: PlanBalanceOptions,
  ): Promise<Map<string, GetPlanBalanceResult>> {
    return this.calculator.computeMany(inputs, options);
  }

  /**
   * DX-182: el saldo de un plan sobre su foto, leída por quien llama dentro
   * de su transacción (el abono, con el plan bloqueado), con la MISMA cuenta
   * que `execute` y `executeWithItems`. `options.offline`: la transacción
   * abierta no espera al proveedor de tasas.
   */
  async fromSnapshot(
    planId: string,
    snapshot: PlanBalanceSnapshot,
    creditMovements: number,
    options?: PlanBalanceOptions,
  ): Promise<GetPlanBalanceResult> {
    const balances = await this.calculator.computeMany(
      [
        {
          plan: { ...snapshot.plan, id: planId },
          items: snapshot.items,
          payments: snapshot.payments,
          baseOf: new Map(
            snapshot.bases.map((b) => [b.paymentId, b.amount] as const),
          ),
          creditMovements,
        },
      ],
      options,
    );
    return balances.get(planId)!;
  }

  private async computeOne(
    plan: PlanBalanceInput['plan'],
    planItems: PlanBalanceInput['items'],
    payments: PlanPayment[],
    baseOf: ReadonlyMap<string, number> = new Map(),
  ): Promise<GetPlanBalanceResult> {
    const creditMovements = this.credit
      ? await this.credit.netCredit(plan.id, plan.currency)
      : 0;
    const balances = await this.calculator.computeMany([
      { plan, items: planItems, payments, baseOf, creditMovements },
    ]);
    return balances.get(plan.id)!;
  }
}
