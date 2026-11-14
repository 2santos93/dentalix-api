/**
 * DX-149-ter: el restablecimiento no se emite. Dentro de la transacción del
 * token, o el recuento bajo candado alcanzó un tope del email (`QUOTA`), o el
 * candado siguió ocupado más allá del `lock_timeout` (`LOCK_TIMEOUT`), o
 * (DX-149-quater) la persona ya recibió su máximo de restablecimientos del
 * día sumando todas sus clínicas (`USER_QUOTA`). La
 * transacción se deshace entera: ni token nuevo ni email. Nunca llega a la
 * respuesta pública (sin enumeración): el caso de uso lo cuenta como
 * THROTTLED.
 */
export class PasswordResetThrottledError extends Error {
  readonly name = 'PasswordResetThrottledError';

  constructor(readonly reason: 'QUOTA' | 'LOCK_TIMEOUT' | 'USER_QUOTA') {
    super(`password reset throttled: ${reason}`);
  }
}
