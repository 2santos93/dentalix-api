import type {
  BalanceOpeningRow,
  StatementPaymentPlanRow,
  StatementPlanRow,
} from '../../../account-statement/domain/entities/account-statement.entity';
import type {
  CollectionChannel,
  CollectionOutcome,
  PaymentPromiseStatus,
} from '@prisma/client';
import type { AgingBuckets } from '../aging';
import type { FrozenExchangeRate } from '../../../payments/domain/payment-exchange-rate';

/*
 * Cartera por antigüedad (DX-145): lo que la clínica tiene por cobrar, por
 * paciente y moneda, repartido en tramos de antigüedad. Sin datos clínicos: ni
 * ítems, ni dientes, ni procedimientos; solo cifras, fechas y el contacto del
 * paciente para llamarlo.
 */

// ---------------------------------------------------------------------------
// Entrada: lo que el repositorio lee de cada paciente.
// ---------------------------------------------------------------------------

/** Un plan con su facturable y la fecha desde la que envejece su saldo. */
export interface AgingPlanRow extends StatementPlanRow {
  /**
   * Desde cuándo se cuenta el saldo del plan que NO está en un plan de cuotas:
   * la aceptación firmada, o si no la hay, la presentación, o si tampoco, la
   * creación del plan. Aún no hay fecha de realización por ítem (DX-050), así
   * que esta antigüedad es siempre APROXIMADA (`ageApproximate`).
   */
  agingFrom: Date;
  /**
   * DX-472-bis: lo abonado en OTRA moneda que la del plan, para contarlo
   * convertido como el estado de cuenta. Ausente si el plan no tiene abonos
   * en otra moneda, o en una fila escrita antes de DX-472-bis (entonces esos
   * abonos van, sin convertir, a `paid` y a saldo a favor, como antes).
   */
  otherCurrency?: PlanOtherCurrencyPaid;
}

/** DX-472-bis: lo abonado a un plan en otra moneda, según `patient_ledgers`. */
export interface PlanOtherCurrencyPaid {
  /** Σ de sus bases (DX-051): ya en la moneda del plan, inmutable. */
  based: number;
  /** Los que aún no tienen base: se convierten como en el saldo del plan. */
  pending: LedgerPendingPayment[];
}

/** Un abono en otra moneda aún sin base, con su tasa congelada si la tiene. */
export interface LedgerPendingPayment {
  id: string;
  currency: string;
  amount: number;
  paidAt: Date;
  /** Sede del abono: su zona da el día civil de la tasa (DX-097). */
  locationId: string;
  exchangeRateCurrency: string | null;
  frozenRate: FrozenExchangeRate | null;
}

/**
 * Abonos VIVOS de un plan (o de un saldo migrado, DX-262) en una moneda: ya
 * sumados o sueltos (computeBalances los suma).
 */
export interface PaidSum {
  treatmentPlanId: string | null;
  openingBalanceId?: string | null;
  currency: string;
  amount: number;
}

/** Todo lo financiero de un paciente que la cartera necesita. */
export interface PatientLedger {
  patientId: string;
  /** Sede de la deuda (ver PrismaReceivablesRepository); `null` = sin sede. */
  locationId: string | null;
  plans: AgingPlanRow[];
  paid: PaidSum[];
  /** Planes de pago vivos (no cancelados) de planes vivos. */
  paymentPlans: StatementPaymentPlanRow[];
  /**
   * Saldos migrados vivos (DX-262): envejecen desde su fecha de corte
   * (aproximada si el archivo no la traía).
   */
  openings?: BalanceOpeningRow[];
}

/** Datos de contacto y último abono de un paciente de la página. */
export interface DebtorDetails {
  patientId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  lastPayment: {
    paidAt: Date;
    /** IANA de la sede del abono: su día civil es el de esa sede. */
    timeZone: string;
    amount: number;
    currency: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Salida del cálculo por paciente.
// ---------------------------------------------------------------------------

export interface PatientAgingCurrency {
  currency: string;
  /** Saldo neto = `debt − credit` = el `balance` del estado de cuenta. */
  balance: number;
  /** Lo que se debe (Σ de los tramos). */
  debt: number;
  /** Saldo a favor: abonos de más o en otra moneda. Nunca resta de los tramos. */
  credit: number;
  buckets: AgingBuckets;
  /** Días de la deuda exigible más antigua; `null` si nada está vencido. */
  oldestAgeDays: number | null;
  /** Alguna parte de la deuda envejece desde una fecha aproximada. */
  ageApproximate: boolean;
  nextInstallment: { dueDate: Date; amount: number } | null;
  /**
   * DX-472-ter: lo mismo que los avisos de la fila, solo de los planes de
   * esta moneda (la línea del CSV dice cuál está incompleta).
   */
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
}

export interface PatientAging {
  /** Solo las monedas con deuda o saldo a favor, por código. */
  currencies: PatientAgingCurrency[];
  oldestAgeDays: number | null;
  ageApproximate: boolean;
  /**
   * DX-472-bis: abonos en otra moneda que no suman porque no tienen tasa
   * (o porque el proveedor no respondió): el saldo de la fila es incompleto,
   * como el del estado de cuenta.
   */
  paymentsWithoutRateCount: number;
  /**
   * DX-472-bis: el proveedor de tasas no respondió a tiempo para algún abono
   * de la fila. Su deuda no se da por vencida (va a «por vencer») mientras
   * tanto, igual que las cuotas del estado de cuenta.
   */
  rateProviderTimedOut: boolean;
}

// ---------------------------------------------------------------------------
// Cobranza de la fila (DX-150).
// ---------------------------------------------------------------------------

/** La última gestión de cobro del paciente (sin su texto: va en la ficha). */
export interface DebtorLastNote {
  channel: CollectionChannel;
  outcome: CollectionOutcome;
  createdAt: Date;
}

/** El último compromiso de pago del paciente (el vigente si está OPEN). */
export interface DebtorPromise {
  id: string;
  amount: number;
  currency: string;
  /** Día civil (YYYY-MM-DD) en la zona de la sede del compromiso. */
  dueDate: string;
  status: PaymentPromiseStatus;
  /** DX-215: se reabrió al anular el abono que lo cumplía (última vez). */
  reopenedAt: Date | null;
}

export interface DebtorCollections {
  lastNote: DebtorLastNote | null;
  promise: DebtorPromise | null;
}
