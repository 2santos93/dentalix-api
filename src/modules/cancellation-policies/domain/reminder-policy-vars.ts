import type { RegionalFormat } from '../../../shared/format/regional-format';
import { moneyWithCode } from '../../../shared/format/money-with-code';
import type { CurrencyTexts } from '../../../shared/format/currency-text';
import type { ReminderCancellationPolicyVars } from '../../notifications/email/domain/email-message';

/**
 * DX-291: la variable `{politica_cancelacion}` del recordatorio a partir de
 * una versión de la política: horas, texto de la clínica e importe ya
 * formateado con el formato de la sede y el código ISO de la moneda (o el
 * texto propio de la clínica), nunca un símbolo (DX-528, como el recibo
 * DX-521) (sin importe, sin la frase del cargo).
 * `null` sin política. La usan el envío real y la vista previa de Ajustes,
 * así que salen iguales.
 */
export function reminderPolicyVars(
  policy: {
    noticeHours: number;
    patientText: string;
    suggestedFee: number | null;
    currency: string | null;
  } | null,
  fmt: RegionalFormat,
  /** DX-517: el texto propio de cada moneda de la clínica (vacío = el código). */
  currencyTexts?: CurrencyTexts | null,
): ReminderCancellationPolicyVars | null {
  if (!policy) return null;
  return {
    noticeHours: policy.noticeHours,
    text: policy.patientText,
    feeLabel:
      policy.suggestedFee !== null && policy.suggestedFee > 0 && policy.currency
        ? moneyWithCode(
            policy.suggestedFee,
            policy.currency,
            fmt,
            currencyTexts,
          )
        : null,
  };
}
