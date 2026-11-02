import type { MfaNoticeKind } from '../../../notifications/email/domain/email-message';

export const MFA_NOTIFIER = Symbol('MFA_NOTIFIER');

/** DX-021-bis: los correos de la verificación en dos pasos. */
export interface MfaNotifier {
  /**
   * Aviso a su dueño. `tenantId`: la clínica que firma; `null`, Dentalix.
   * Nunca lanza: un aviso caído no bloquea un login ni un restablecimiento.
   */
  notice(input: {
    tenantId: string | null;
    to: string;
    kind: MfaNoticeKind;
    recoveryCodesRemaining?: number;
  }): Promise<void>;
  /**
   * Código del alta de un superadmin: como mucho uno cada 10 min, sin más tope.
   * Si no se puede encolar, lanza: el login no dice que se envió.
   */
  sendEnrollmentCode(input: {
    to: string;
    code: string;
    expiresInMinutes: number;
  }): Promise<void>;
}
