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
import {
  type AmountConverter,
  ConvertAmountUseCase,
} from '../../../exchange/application/use-cases/convert-amount.use-case';
import { ExchangeRateProviderNotRespondingError } from '../../../exchange/domain/ports/exchange-rate-provider.port';
import {
  CONVERSION_TIMED_OUT,
  conversionDeadline,
  type ConversionDeadline,
} from '../conversion-deadline';
import {
  PLAN_CREDIT_READER,
  type PlanCreditReader,
} from '../../domain/ports/plan-credit-reader.port';
import { round2, toCents } from '../../../../shared/money/money';
import { linesTotal } from '../../../../shared/money/line-rounding';

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
   * (`BALANCE_CONVERSION_BUDGET_MS`) o ya se sabe que no contesta (DX-472):
   * los abonos que esperaban su tasa salen en `paymentsWithoutRate` y no
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
}

/** Las conversiones de UN cálculo: un convertidor y un plazo compartidos. */
interface ConversionRun {
  convert: AmountConverter;
  deadline: ConversionDeadline;
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

    let unallocatedCents = 0;
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
   * datos ya leídos, y UN solo plazo para todos: un estado de cuenta con varios
   * planes tampoco espera más de `BALANCE_CONVERSION_BUDGET_MS` al proveedor.
   */
  async computeMany(
    inputs: readonly PlanBalanceInput[],
  ): Promise<Map<string, GetPlanBalanceResult>> {
    const run = this.conversionRun();
    const balances = new Map<string, GetPlanBalanceResult>();
    try {
      for (const input of inputs) {
        balances.set(
          input.plan.id,
          await this.compute(
            input.plan,
            input.items,
            input.payments,
            input.baseOf,
            run,
            input.creditMovements,
          ),
        );
      }
    } finally {
      run.deadline.dispose();
    }
    return balances;
  }

  private async computeOne(
    plan: PlanBalanceInput['plan'],
    planItems: PlanBalanceInput['items'],
    payments: PlanPayment[],
    baseOf: ReadonlyMap<string, number> = new Map(),
  ): Promise<GetPlanBalanceResult> {
    const run = this.conversionRun();
    try {
      return await this.compute(plan, planItems, payments, baseOf, run);
    } finally {
      run.deadline.dispose();
    }
  }

  private conversionRun(): ConversionRun {
    // DX-374: un convertidor por cálculo, que lee la fuente de la clínica y
    // las tasas de cada día una sola vez (no una lectura por abono). Con la
    // tasa congelada (DX-375) ni siquiera se usa: solo los abonos anteriores
    // aún sin congelar se convierten con la tasa de su día.
    const memoized = this.convertAmount.memoized();
    // DX-054: un proveedor lento o colgado no retiene el saldo: todas las
    // conversiones en vivo comparten un plazo y lo que no llegue sale «sin
    // tasa», como un abono que el proveedor no puede convertir.
    const deadline = conversionDeadline();
    // Vencido el plazo no se lanza ni una petición más a un proveedor que ya
    // no responde a tiempo: la conversión en vivo queda pendiente y `race`
    // la da por vencida al instante. Lo que no pide tasa (misma moneda, tasa
    // congelada) no pasa por aquí y sigue sumando.
    const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
    // DX-472: un proveedor que ya dijo que no contesta (el plazo de la llamada
    // pasó, o sigue en su caché negativa) es lo mismo: el saldo avisa de que
    // se reintente; no es un abono «sin tasa».
    const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
      if (deadline.timedOut) return never();
      try {
        return await work();
      } catch (error) {
        if (!(error instanceof ExchangeRateProviderNotRespondingError)) {
          throw error;
        }
        deadline.expire();
        return never();
      }
    };
    return {
      deadline,
      convert: {
        execute: (input) => guarded(() => memoized.execute(input)),
        quote: (input) => guarded(() => memoized.quote(input)),
      },
    };
  }

  private async compute(
    plan: PlanBalanceInput['plan'],
    planItems: PlanBalanceInput['items'],
    payments: PlanPayment[],
    baseOf: ReadonlyMap<string, number>,
    { convert, deadline }: ConversionRun,
    knownCreditMovements?: number,
  ): Promise<GetPlanBalanceResult> {
    // DX-109 (BE-001): un plan no cobrable (rechazado o cancelado) no debe
    // nada, la misma regla que el estado de cuenta; sus abonos siguen en
    // `paid`.
    const billable = !isPlanBillable(plan.status)
      ? 0
      : // DX-340: suma exacta de las líneas cobrables (regla única).
        linesTotal(
          planItems.filter((item) => BILLABLE_STATUSES.has(item.status)),
        );

    let paid = 0;
    const paymentsWithoutRate: PaymentWithoutRate[] = [];
    let rateProviderTimedOut = false;
    for (const payment of payments) {
      // IMP-4a/4b: cada abono se convierte por su propio importe (nunca
      // reutilizando un `rateUsed`, que depende del importe), y uno sin tasa
      // no tumba el saldo: no cuenta en `paid` y se informa «sin tasa»
      // (`paymentsCount` no cambia). Cualquier otro fallo se propaga.
      const base = baseOf.get(payment.id);
      const converted =
        base ??
        (await deadline.race(paymentAmountIn(convert, payment, plan.currency)));
      if (converted === CONVERSION_TIMED_OUT) rateProviderTimedOut = true;
      if (converted === null || converted === CONVERSION_TIMED_OUT) {
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

    const creditMovements = round2(
      knownCreditMovements ??
        (this.credit ? await this.credit.netCredit(plan.id, plan.currency) : 0),
    );
    return {
      planCurrency: plan.currency,
      billable,
      paid: round2(paid),
      creditMovements,
      balance: round2(billable - paid - creditMovements),
      paymentsCount: payments.length,
      paymentsWithoutRate,
      rateProviderTimedOut,
    };
  }
}
