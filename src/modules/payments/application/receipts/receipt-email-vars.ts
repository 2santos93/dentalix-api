import type { DocType, PaymentMethod } from '@prisma/client';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import type { PaymentReceiptEmailVars } from '../../../notifications/email/domain/email-message';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type { RegionalFormat } from '../../../../shared/format/regional-format';

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Efectivo',
  CARD: 'Tarjeta',
  TRANSFER: 'Transferencia',
  OTHER: 'Otro',
};

const DOC_TYPE_LABELS: Record<DocType, string> = {
  CC: 'CC',
  TI: 'TI',
  CE: 'CE',
  PASSPORT: 'Pasaporte',
  OTHER: 'Documento',
};

/** «Plan del …» o, en un abono contra el saldo migrado (DX-262), su concepto. */
function targetLabel(
  plan: PaymentReceiptView['snapshot']['plan'],
  opening: PaymentReceiptView['snapshot']['openingBalance'] | null,
  timeZone: string,
  fmt: RegionalFormat,
): string {
  if (!plan) {
    return opening
      ? `Saldo migrado · ${opening.concept} · corte ${fmt.civilDate(opening.asOfDate)}`
      : 'Saldo migrado';
  }
  const planDay = fmt.civilDate(
    civilDateIn(new Date(plan.createdAt), timeZone),
  );
  return plan.optionLabel
    ? `Plan del ${planDay} · ${plan.optionLabel}`
    : `Plan del ${planDay}`;
}

/**
 * Variables del email del recibo (DX-136), sacadas SOLO de la foto del
 * recibo: el email dice lo mismo que la pantalla y el papel. El documento va
 * enmascarado (la foto nunca lo tiene en claro) y nada clínico: ni notas, ni
 * tratamientos, solo el nombre del plan. `timeZone` es la de la sede del
 * recibo: el día del plan y el de la anulación son días civiles de esa sede
 * (no puede decir «anulado el 18» si allí aún es el 17). `fmt` es su formato
 * (G1-B): fechas e importes como los escribe esa sede.
 */
export function receiptEmailVars(
  receipt: PaymentReceiptView,
  timeZone: string,
  fmt: RegionalFormat,
): PaymentReceiptEmailVars {
  const { snapshot } = receipt;
  const { clinic, patient, payment, plan, planBalance } = snapshot;
  return {
    patientName: patient.fullName,
    reference: receipt.reference,
    legacy: receipt.legacy,
    locationName: snapshot.location.name,
    locationAddress: snapshot.location.address,
    fiscalLine: snapshot.fiscalDataPending
      ? null
      : `${clinic.legalName} · NIT/NIF ${clinic.taxId}`,
    patientDocLabel: patient.docNumberMasked
      ? `${DOC_TYPE_LABELS[patient.docType]} ${patient.docNumberMasked}`
      : null,
    amountLabel: fmt.money(payment.amount, payment.currency),
    paidOnLabel: fmt.civilDate(payment.paidOn),
    methodLabel: payment.method
      ? METHOD_LABELS[payment.method]
      : 'Sin especificar',
    planLabel: targetLabel(
      plan,
      snapshot.openingBalance ?? null,
      timeZone,
      fmt,
    ),
    toOpeningBalance: Boolean(snapshot.openingBalance),
    balanceLabel: planBalance
      ? fmt.money(planBalance.balance, planBalance.currency)
      : null,
    cashierName: snapshot.cashier?.fullName ?? null,
    voided:
      receipt.voidedAt && receipt.voidReason
        ? {
            dateLabel: fmt.civilDate(civilDateIn(receipt.voidedAt, timeZone)),
            reason: receipt.voidReason,
          }
        : null,
    legalNotice: snapshot.legalNotice,
  };
}
