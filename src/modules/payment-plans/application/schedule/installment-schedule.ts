import { BadRequestException } from '@nestjs/common';
import { TreatmentPlanItemStatus } from '@prisma/client';
import { round2 } from '../../../../shared/money/money';
import type { RoundingDigits } from '../../../../shared/money/line-rounding';
import {
  DOWN_PAYMENT_EXCEEDS_MESSAGE,
  DOWN_PAYMENT_MESSAGE,
  TOTAL_TO_FINANCE_POSITIVE_MESSAGE,
} from '../../../../shared/money/currency-messages';
import { billableTotal } from '../../../payments/application/plan-balance-calculator';
import {
  generateSchedule,
  type GeneratedInstallment,
  type Periodicity,
} from './generate-schedule';

/**
 * DX-041: las condiciones de un plan de cuotas tal como llegan (del alta, de
 * la simulación o de la aceptación con cuotas). La validación y el reparto
 * viven AQUÍ y solo aquí: la simulación devuelve exactamente lo que el alta
 * guardaría con los mismos datos.
 */
export interface InstallmentTermsInput {
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: string | Date;
}

export interface InstallmentTerms {
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
}

export interface InstallmentSchedule {
  totalToFinance: number;
  downPayment: number;
  installmentsCount: number;
  periodicity: Periodicity;
  startDate: Date;
  installments: GeneratedInstallment[];
}

export const MAX_INSTALLMENTS = 600;

const PERIODICITIES: ReadonlySet<Periodicity> = new Set([
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
]);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Comprueba las condiciones (400 en español) y fija la fecha de inicio. */
export function parseInstallmentTerms(
  input: InstallmentTermsInput,
): InstallmentTerms {
  if (
    !Number.isInteger(input.installmentsCount) ||
    input.installmentsCount < 1 ||
    input.installmentsCount > MAX_INSTALLMENTS
  ) {
    throw new BadRequestException(
      `El número de cuotas debe estar entre 1 y ${MAX_INSTALLMENTS}.`,
    );
  }
  if (!isFiniteNonNegative(input.downPayment)) {
    throw new BadRequestException(DOWN_PAYMENT_MESSAGE);
  }
  if (!PERIODICITIES.has(input.periodicity)) {
    throw new BadRequestException(
      'La periodicidad debe ser semanal (WEEKLY), quincenal (BIWEEKLY) o mensual (MONTHLY).',
    );
  }
  const startDate =
    input.startDate instanceof Date
      ? input.startDate
      : new Date(input.startDate);
  if (Number.isNaN(startDate.getTime())) {
    throw new BadRequestException('La fecha de inicio no es válida.');
  }
  return {
    downPayment: input.downPayment,
    installmentsCount: input.installmentsCount,
    periodicity: input.periodicity,
    startDate,
  };
}

/**
 * Las cuotas y fechas de un plan de cuotas: la inicial más las cuotas suman
 * exactamente `totalToFinance` y el ajuste de redondeo va en la última
 * (`generateSchedule`, en unidades de la moneda, DX-488).
 */
export function planInstallmentSchedule(
  terms: InstallmentTerms,
  totalToFinance: number,
  roundingDigits: RoundingDigits,
): InstallmentSchedule {
  const total = round2(totalToFinance);
  if (total <= 0) {
    throw new BadRequestException(TOTAL_TO_FINANCE_POSITIVE_MESSAGE);
  }
  const downPayment = round2(terms.downPayment);
  if (downPayment > total) {
    throw new BadRequestException(DOWN_PAYMENT_EXCEEDS_MESSAGE);
  }
  return {
    totalToFinance: total,
    downPayment,
    installmentsCount: terms.installmentsCount,
    periodicity: terms.periodicity,
    startDate: terms.startDate,
    installments: generateSchedule({
      totalToFinance: total,
      downPayment,
      installmentsCount: terms.installmentsCount,
      periodicity: terms.periodicity,
      startDate: terms.startDate,
      roundingDigits,
    }),
  };
}

/**
 * DX-041: lo que el plan tendrá facturable una vez aceptado, con la cuenta
 * del saldo (`billableTotal`): aceptar pasa los propuestos a aceptados, así
 * que cuentan como tales. Es la cifra que `POST …/payment-plan` financia por
 * defecto tras la aceptación.
 */
export function billableOnAcceptance(
  items: readonly {
    status: TreatmentPlanItemStatus;
    price: number;
    discount: number;
  }[],
): number {
  return billableTotal(
    items.map((item) =>
      item.status === TreatmentPlanItemStatus.PROPOSED
        ? { ...item, status: TreatmentPlanItemStatus.ACCEPTED }
        : item,
    ),
  );
}
