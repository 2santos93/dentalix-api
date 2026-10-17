export const STAFF_LOGIN_LOCKS = Symbol('STAFF_LOGIN_LOCKS');

/**
 * Bloqueo del inicio de sesión de un miembro por intentos fallidos (DX-048).
 * Lo implementa `LoginLockoutService` (módulo auth); se indexa por el email,
 * que se convierte en hash antes de llegar a la BD.
 */
export interface StaffLoginLocks {
  /** Hasta cuándo no puede entrar, o `null` si no está en espera. */
  blockedUntil(email: string): Promise<Date | null>;
  /** Borra la espera y los fallos acumulados. */
  unlock(email: string): Promise<void>;
}
