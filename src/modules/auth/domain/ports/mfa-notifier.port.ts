import type { MfaNoticeKind } from '../../../notifications/email/domain/email-message';

export const MFA_NOTIFIER = Symbol('MFA_NOTIFIER');

export const MFA_ENROLLMENT_CODE_INTERVAL_SECONDS = 60;

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
   * Código del alta de un superadmin: cada intento de entrar tiene el suyo. Como
   * mucho uno por cuenta y cliente (IP, /64 en IPv6) cada
   * `MFA_ENROLLMENT_CODE_INTERVAL_SECONDS`, y ningún tope que un tercero pueda
   * agotar. `false`: no salió por ese plazo. Si no se puede encolar, lanza.
   */
  sendEnrollmentCode(input: {
    userId: string;
    ip: string | null;
    to: string;
    code: string;
    ref: string;
    expiresInMinutes: number;
  }): Promise<boolean>;
}
