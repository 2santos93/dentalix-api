export const REGISTRATION_NOTIFIER = Symbol('REGISTRATION_NOTIFIER');

/**
 * Emails del registro de clínicas (DX-029). Son de plataforma: sin clínica, y
 * con tope por destinatario (DX-144, SEC-034): el alta es pública y no puede
 * servir para mandar emails de Dentalix a cualquier buzón sin límite.
 */
export interface RegistrationNotifier {
  /**
   * Segundos mínimos entre dos emails del registro al mismo destinatario. Un
   * registro pendiente más joven que esto no se reemplaza.
   */
  readonly recipientCooldownSeconds: number;

  /** ¿Cabe ahora otro email del registro a `to`? No envía nada. */
  withinRecipientQuota(to: string): Promise<boolean>;

  /**
   * Enlace para verificar el email y crear la clínica. Sin nada escrito por
   * el solicitante. `false` si el tope lo frenó (carrera entre réplicas).
   */
  sendVerification(input: {
    to: string;
    verifyUrl: string;
    expiresInHours: number;
  }): Promise<boolean>;

  /**
   * Aviso al titular de un email que ya tenía cuenta. Sin token. `false` si
   * el tope lo frenó.
   */
  sendExistingAccountNotice(input: {
    to: string;
    userName: string;
    loginUrl: string;
  }): Promise<boolean>;
}
