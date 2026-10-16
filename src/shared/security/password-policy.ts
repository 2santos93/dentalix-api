/**
 * Política de contraseña de Dentalix: la MISMA en el registro, el cambio de
 * contraseña (DX-024), aceptar una invitación y restablecerla (DX-010).
 * Longitud mínima 8 (NIST SP 800-63B) y máxima 200 (acota el coste del hash).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * Motivo en español por el que `password` no cumple la política, o `null` si
 * la cumple. Para las validaciones fuera de un DTO (defensa en profundidad).
 */
export function passwordPolicyViolation(password: unknown): string | null {
  if (typeof password !== 'string') {
    return 'La contraseña es obligatoria.';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `La contraseña no puede tener más de ${PASSWORD_MAX_LENGTH} caracteres.`;
  }
  return null;
}
