import type { RegionalFormat } from '../../../shared/format/regional-format';
import type { ReminderCancellationPolicyVars } from '../../notifications/email/domain/email-message';

/**
 * DX-291: la variable `{politica_cancelacion}` del recordatorio a partir de
 * una versión de la política: horas, texto de la clínica e importe ya
 * formateado con el formato de la sede (sin importe, sin la frase del cargo).
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
): ReminderCancellationPolicyVars | null {
  if (!policy) return null;
  return {
    noticeHours: policy.noticeHours,
    text: policy.patientText,
    feeLabel:
      policy.suggestedFee !== null && policy.suggestedFee > 0 && policy.currency
        ? fmt.money(policy.suggestedFee, policy.currency)
        : null,
  };
}
