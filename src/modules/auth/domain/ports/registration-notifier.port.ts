export const REGISTRATION_NOTIFIER = Symbol('REGISTRATION_NOTIFIER');

/** Emails del registro de clínicas (DX-029). Son de plataforma: sin clínica. */
export interface RegistrationNotifier {
  /** Enlace para verificar el email y crear la clínica. */
  sendVerification(input: {
    to: string;
    userName: string;
    verifyUrl: string;
    expiresInHours: number;
  }): Promise<void>;

  /** Aviso al titular de un email que ya tenía cuenta. Sin token. */
  sendExistingAccountNotice(input: {
    to: string;
    userName: string;
    loginUrl: string;
  }): Promise<void>;
}
