import { UnauthorizedException } from '@nestjs/common';

/**
 * SEC-008: acceso "break-glass" del superadmin de plataforma a una clínica en
 * la que no es miembro (soporte). Reglas:
 *  - exige MFA (TOTP) enrolado desde la sesión de plataforma y un código
 *    válido no reutilizado, más un motivo de 10 a 500 caracteres;
 *  - el token es solo de acceso (sin refresh), con `breakGlass: true` y una
 *    vida de BREAK_GLASS_TTL_MINUTES (por defecto 30, máximo 60);
 *  - cada acceso deja una fila inmutable en `platform_access_audit`, que el
 *    ADMIN de la clínica ve en «Accesos de soporte».
 */

export const BREAK_GLASS_MIN_TTL_MINUTES = 5;
export const BREAK_GLASS_MAX_TTL_MINUTES = 60;
export const BREAK_GLASS_DEFAULT_TTL_MINUTES = 30;

export const BREAK_GLASS_REASON_MIN = 10;
export const BREAK_GLASS_REASON_MAX = 500;

/** Duración del token break-glass según el entorno (ya validado al arrancar). */
export function breakGlassTtlMinutes(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) &&
    value >= BREAK_GLASS_MIN_TTL_MINUTES &&
    value <= BREAK_GLASS_MAX_TTL_MINUTES
    ? value
    : BREAK_GLASS_DEFAULT_TTL_MINUTES;
}

/**
 * Códigos que la web usa para mostrar el paso siguiente. Solo se devuelven
 * DESPUÉS de comprobar la contraseña de un superadmin: quien no la conoce
 * recibe siempre el 401 genérico, así que no revelan si el email existe.
 */
export type BreakGlassCode = 'MFA_NOT_ENROLLED' | 'BREAK_GLASS_REQUIRED';

const MESSAGES: Record<BreakGlassCode, string> = {
  MFA_NOT_ENROLLED:
    'Para entrar a una clínica como soporte debes activar antes la verificación en dos pasos desde el área de plataforma.',
  BREAK_GLASS_REQUIRED:
    'Acceso de soporte: indica el código de tu app de autenticación y el motivo del acceso. La clínica verá este acceso.',
};

export function breakGlassChallenge(
  code: BreakGlassCode,
): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code,
    message: MESSAGES[code],
  });
}
