export const PASSWORD_RESET_NOTIFIER = Symbol('PASSWORD_RESET_NOTIFIER');

export interface PasswordResetEmail {
  tenantId: string;
  userId: string;
  to: string;
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface PasswordResetNotifier {
  /**
   * ¿Se puede mandar otro email a `to` desde la clínica sin pasar los topes
   * anti-abuso de DX-088 (enfriamiento y máximos diarios)? Nunca lanza por el
   * tope: quien pide no debe saber si se envió.
   */
  withinQuota(tenantId: string, to: string): Promise<boolean>;

  /**
   * Cancela el email aún pendiente con un enlace anterior y encola el nuevo
   * en el outbox (con la marca de la clínica). No espera al proveedor.
   */
  send(email: PasswordResetEmail): Promise<void>;
}
