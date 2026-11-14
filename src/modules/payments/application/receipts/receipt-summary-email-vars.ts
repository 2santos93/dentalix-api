import type { PaymentReceiptSummaryEmailVars } from '../../../notifications/email/domain/email-message';
import type { PaymentReceiptSummaryView } from '../../domain/receipt-summary';
import { documentText } from '../../../patients/domain/document-type';
import type { RegionalFormat } from '../../../../shared/format/regional-format';
import { moneyWithCode } from '../../../../shared/format/money-with-code';
import type { CurrencyTexts } from '../../../../shared/format/currency-text';

/**
 * DX-401: variables del email del resumen, sacadas SOLO de la vista: el email
 * dice lo mismo que la pantalla y el papel. `fmt`: el formato de la sede del
 * último recibo (G1-B); `currencyTexts`: el texto propio de cada moneda de la
 * clínica hoy (DX-517), con la misma función que el recibo (`moneyWithCode`).
 */
export function receiptSummaryEmailVars(
  summary: PaymentReceiptSummaryView,
  fmt: RegionalFormat,
  currencyTexts: CurrencyTexts | null,
): PaymentReceiptSummaryEmailVars {
  const { clinic, patient } = summary;
  const money = (amount: number, currency: string): string =>
    moneyWithCode(amount, currency, fmt, currencyTexts);
  return {
    patientName: patient.fullName,
    patientDocLabel: documentText(
      patient.documentTypeName,
      patient.documentMasked,
    ),
    periodLabel: `${fmt.civilDate(summary.from)} al ${fmt.civilDate(summary.to)}`,
    fiscalLine:
      clinic.legalName === null || clinic.taxId === null
        ? null
        : `${clinic.legalName} · Id. fiscal ${clinic.taxId}`,
    lines: summary.receipts.map((line) => ({
      receiptNumber: line.receiptNumber,
      dateLabel: fmt.civilDate(line.issuedOn),
      locationName: line.locationName,
      methodLabel: line.methodLabel,
      amountLabel: money(line.amount, line.currency),
      voided: line.voided,
    })),
    totalLabels: summary.totals.map((total) =>
      money(total.amount, total.currency),
    ),
    voidedCount: summary.voidedCount,
    notice: summary.notice,
  };
}
