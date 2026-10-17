import type { DocType, PaymentMethod } from '@prisma/client';
import type { PaymentReceiptView } from '../../domain/entities/payment-receipt.entity';
import type { PaymentReceiptEmailVars } from '../../../notifications/email/domain/email-message';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';

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

/** `YYYY-MM-DD` → `DD/MM/YYYY` (día civil, sin zona). */
const civilLabel = (day: string): string => {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
};

/** Mismo formato que la web (`formatCurrency`): el email dice lo mismo que la pantalla. */
function money(amount: number, currency: string): string {
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Variables del email del recibo (DX-136), sacadas SOLO de la foto del
 * recibo: el email dice lo mismo que la pantalla y el papel. El documento va
 * enmascarado (la foto nunca lo tiene en claro) y nada clínico: ni notas, ni
 * tratamientos, solo el nombre del plan. `timeZone` es la de la sede del
 * recibo: el día del plan y el de la anulación son días civiles de esa sede
 * (una sede de España no puede decir «anulado el 18» si allí aún es el 17).
 */
export function receiptEmailVars(
  receipt: PaymentReceiptView,
  timeZone: string = DEFAULT_BUSINESS_HOURS_TIMEZONE,
): PaymentReceiptEmailVars {
  const { snapshot } = receipt;
  const { clinic, patient, payment, plan, planBalance } = snapshot;
  const planDay = civilDateIn(new Date(plan.createdAt), timeZone);
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
    amountLabel: money(payment.amount, payment.currency),
    paidOnLabel: civilLabel(payment.paidOn),
    methodLabel: payment.method
      ? METHOD_LABELS[payment.method]
      : 'Sin especificar',
    planLabel: plan.optionLabel
      ? `Plan del ${civilLabel(planDay)} · ${plan.optionLabel}`
      : `Plan del ${civilLabel(planDay)}`,
    balanceLabel: planBalance
      ? money(planBalance.balance, planBalance.currency)
      : null,
    cashierName: snapshot.cashier?.fullName ?? null,
    voided:
      receipt.voidedAt && receipt.voidReason
        ? {
            dateLabel: civilLabel(civilDateIn(receipt.voidedAt, timeZone)),
            reason: receipt.voidReason,
          }
        : null,
    legalNotice: snapshot.legalNotice,
  };
}
