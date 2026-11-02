import { ClinicRole } from '@prisma/client';

/**
 * DX-021: verificación en dos pasos (TOTP) de los miembros de una clínica.
 *
 * El MFA es del USUARIO (`users` es global): las columnas, el cifrado
 * (`MfaSecretCipher`), el TOTP (`totp.ts`) y el bloqueo por intentos
 * (`LoginLockoutService.claimMfaAttempt`) son los del MFA del superadmin
 * (SEC-008). Activado, se pide en el login de TODAS sus clínicas.
 *
 * Es obligatorio:
 *  - para el superadmin de plataforma (SEC-008) también cuando entra como
 *    MIEMBRO de una clínica (el acceso sin membresía ya es break-glass);
 *  - para los ADMIN de una clínica con `requireAdminMfa`.
 * Quien lo tiene obligatorio y aún no lo activó pasa por el alta forzada
 * antes de recibir ningún token con acceso a datos.
 */
export function isMfaRequired(input: {
  role: ClinicRole;
  isPlatformAdmin: boolean;
  requireAdminMfa: boolean;
}): boolean {
  if (input.isPlatformAdmin) return true;
  return input.role === ClinicRole.ADMIN && input.requireAdminMfa;
}

/**
 * Para qué sirve un token de paso intermedio del login. Ninguno da acceso a
 * datos: se firman con otra clave que el access token, así que JwtAuthGuard
 * los rechaza.
 */
export type MfaChallengePurpose = 'MFA_VERIFY' | 'MFA_ENROLL';

/** Vida del token intermedio: el de código, 5 min; el del alta, 10 (hay que escanear el QR). */
export const MFA_CHALLENGE_TTL_SECONDS: Record<MfaChallengePurpose, number> = {
  MFA_VERIFY: 5 * 60,
  MFA_ENROLL: 10 * 60,
};

/** Respuesta del login cuando falta el segundo factor. */
export interface MfaChallenge {
  /** `MFA_REQUIRED`: pide el código; `MFA_ENROLLMENT_REQUIRED`: alta forzada. */
  mfa: 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';
  mfaToken: string;
  expiresAt: Date;
}

export const MFA_MESSAGES = {
  invalidCode:
    'El código no es correcto o ya se usó. Espera al siguiente código de la app e intenta de nuevo.',
  invalidRecoveryCode: 'El código de recuperación no es correcto o ya se usó.',
  challengeExpired: 'El paso de verificación caducó. Vuelve a iniciar sesión.',
  alreadyEnabled: 'La verificación en dos pasos ya está activa en esta cuenta.',
  notEnabled: 'La verificación en dos pasos no está activa en esta cuenta.',
  noPendingEnrollment:
    'Primero inicia la activación de la verificación en dos pasos.',
  wrongPassword: 'La contraseña no es correcta.',
  platformAdminCannotDisable:
    'Las cuentas de soporte de Dentalix deben mantener la verificación en dos pasos.',
  requiredByClinic:
    'Esta clínica exige la verificación en dos pasos a sus administradores: no puedes desactivarla.',
  policyNeedsOwnMfa:
    'Activa primero tu propia verificación en dos pasos (Mi perfil → Seguridad) antes de exigirla a los administradores.',
} as const;
