import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  isWellFormedPasswordResetToken,
} from './password-reset-token';

/**
 * Enlace de verificación del registro de una clínica (DX-029). Mismo formato
 * que el de restablecer contraseña: 32 bytes aleatorios en base64url que solo
 * viajan en el email; en la BD queda su SHA-256.
 */
export const REGISTRATION_TTL_HOURS = 24;

/** Ruta pública de la web (src/app/(auth)/register/verificar/[token]). */
export const REGISTRATION_VERIFY_PATH = '/register/verificar';

/** Página a la que lleva el aviso al titular de un email ya registrado. */
export const REGISTRATION_NOTICE_PATH = '/login';

export const generateRegistrationToken = generatePasswordResetToken;
export const hashRegistrationToken = hashPasswordResetToken;
export const isWellFormedRegistrationToken = isWellFormedPasswordResetToken;

export function registrationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + REGISTRATION_TTL_HOURS * 60 * 60 * 1000);
}
