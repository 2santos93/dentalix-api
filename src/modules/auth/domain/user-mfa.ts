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
 *  - para los ADMIN de una clínica con `requireAdminMfa`;
 *  - para todos los miembros de una clínica con `requireAllMfa` (DX-021-bis).
 * Quien lo tiene obligatorio y aún no lo activó pasa por el alta forzada
 * antes de recibir ningún token con acceso a datos.
 */
export function isMfaRequired(input: {
  role: ClinicRole;
  isPlatformAdmin: boolean;
  requireAdminMfa: boolean;
  requireAllMfa: boolean;
}): boolean {
  if (input.isPlatformAdmin || input.requireAllMfa) return true;
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
  /**
   * DX-021-bis: alta de un superadmin. Empezarla exige además el código que
   * se le acaba de enviar al correo: la contraseña sola no enrola un móvil.
   */
  emailCodeRequired?: true;
}

/** DX-021-bis: las clínicas nuevas nacen exigiendo el MFA a sus ADMIN. */
export const NEW_CLINIC_REQUIRES_ADMIN_MFA = Symbol(
  'NEW_CLINIC_REQUIRES_ADMIN_MFA',
);

/** Política de una clínica. `requireAllMfa` implica `requireAdminMfa`. */
export interface ClinicMfaPolicy {
  requireAdminMfa: boolean;
  requireAllMfa: boolean;
}

/** Vida de un dispositivo de confianza (DX-021-bis). */
export const MFA_TRUSTED_DEVICE_DAYS = 30;

/** Por qué un ADMIN restablece la verificación de otro (código, no texto libre). */
export const MFA_RESET_REASONS = [
  'LOST_DEVICE',
  'DEVICE_REPLACED',
  'SECURITY_INCIDENT',
] as const;
export type MfaResetReason = (typeof MFA_RESET_REASONS)[number];

/** «Chrome en macOS» a partir del User-Agent: solo para reconocer el dispositivo. */
export function trustedDeviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const system = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && system) return `${browser} en ${system}`;
  return browser ?? system ?? 'Dispositivo desconocido';
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
  emailCodeInvalid:
    'El código del correo no es correcto. Revisa el último que te enviamos.',
  resetSelf:
    'No puedes restablecer tu propia verificación: usa tus códigos de recuperación.',
  resetNeedsOwnMfa:
    'Para restablecer la de otra persona, activa primero tu propia verificación en dos pasos.',
  resetPlatformAdmin:
    'Las cuentas de soporte de Dentalix no se restablecen desde una clínica.',
  resetOtherClinic:
    'Esta cuenta da acceso a otra clínica: la persona debe usar sus códigos de recuperación.',
  policyNeedsOwnMfa:
    'Activa primero tu propia verificación en dos pasos (Mi perfil → Seguridad) antes de exigirla a los administradores.',
} as const;
