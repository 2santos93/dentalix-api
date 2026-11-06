import type { Prisma } from '@prisma/client';

export const PASSWORD_RESET_NOTIFIER = Symbol('PASSWORD_RESET_NOTIFIER');

export interface PasswordResetEmail {
  tenantId: string;
  userId: string;
  to: string;
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

/**
 * DX-149-ter: el email del enlace, listo para encolarlo DENTRO de la
 * transacción que emite el token (DX-463): `insert(tx)` dentro, `kick()`
 * después del COMMIT.
 */
export interface PreparedPasswordResetEmail {
  /**
   * Cancela el email aún pendiente con un enlace anterior y encola el nuevo,
   * con el tope del destinatario contado bajo su candado (solo ese, no el de
   * la clínica). Si el tope no deja, lanza PasswordResetThrottledError y la
   * transacción se deshace.
   */
  insert(tx: Prisma.TransactionClient): Promise<void>;
  /** Despierta al despachador: solo tras el COMMIT. */
  kick(): void;
}

export interface PasswordResetNotifier {
  /**
   * ¿Se puede mandar otro email a `to` desde la clínica sin pasar los topes
   * anti-abuso de DX-088 (enfriamiento y máximos diarios)? Nunca lanza por el
   * tope: quien pide no debe saber si se envió. Es el aviso temprano, sin
   * candado; el que manda es el de `insert`.
   */
  withinQuota(tenantId: string, to: string): Promise<boolean>;

  /**
   * DX-149-quater: máximo de restablecimientos al día POR USUARIO, sumando
   * todas sus clínicas. Es el mismo número que el tope diario por
   * destinatario de una clínica (`MAIL_RECIPIENT_DAILY_LIMIT`, 5): una
   * persona en varias clínicas no recibe más que si estuviera en una sola.
   */
  userDailyLimit(): number;

  /** Renderiza y cifra el email (con la marca de la clínica), sin encolarlo. */
  prepare(email: PasswordResetEmail): Promise<PreparedPasswordResetEmail>;
}
