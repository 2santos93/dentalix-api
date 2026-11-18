import { createHash, timingSafeEqual } from 'node:crypto';
import type { PatientAccessScope } from '@prisma/client';

/**
 * DX-101: enlace de SOLO LECTURA del paciente (o de su responsable) a sus
 * citas, presupuestos y estado de cuenta. El token (32 bytes, base64url) solo
 * viaja en la URL; la BD guarda su SHA-256 (`shared/public-links`). Para
 * abrirlo hace falta además la fecha de nacimiento del paciente.
 */

export const PATIENT_ACCESS_SCOPES = [
  'APPOINTMENTS',
  'PLANS',
  'ACCOUNT',
] as const satisfies readonly PatientAccessScope[];

/** Ruta de la página pública de la web: `<host>/mi-clinica/<token>`. */
export const PATIENT_ACCESS_PUBLIC_PATH = '/mi-clinica';

export const PATIENT_ACCESS_DEFAULT_TTL_DAYS = 14;
export const PATIENT_ACCESS_MIN_TTL_DAYS = 1;
export const PATIENT_ACCESS_MAX_TTL_DAYS = 30;

/** Fallos de fecha que bloquean el enlace (el quinto bloquea). */
export const PATIENT_ACCESS_MAX_ATTEMPTS = 5;
export const PATIENT_ACCESS_LOCK_MINUTES = 30;
/** Vida de la sesión del navegador tras verificar. */
export const PATIENT_ACCESS_SESSION_MINUTES = 30;
/**
 * Suelo de tiempo de toda respuesta de fallo de la verificación: exista o no
 * el token, esté vivo o no y sea cual sea la fecha, el fallo tarda lo mismo.
 */
export const PATIENT_ACCESS_FAILURE_FLOOR_MS = 400;

// --- Mensajes (español) ------------------------------------------------------

export const PATIENT_ACCESS_INVALID_CODE = 'PATIENT_ACCESS_INVALID';
/** La ÚNICA respuesta de un fallo: no dice si el token existe ni por qué falla. */
export const PATIENT_ACCESS_INVALID_MESSAGE = 'Datos incorrectos';
export const PATIENT_ACCESS_LOCKED_CODE = 'PATIENT_ACCESS_LOCKED';
export const PATIENT_ACCESS_LOCKED_MESSAGE =
  'Demasiados intentos. Por seguridad, el enlace queda bloqueado 30 minutos.';
export const PATIENT_ACCESS_SESSION_REQUIRED_CODE =
  'PATIENT_ACCESS_SESSION_REQUIRED';
export const PATIENT_ACCESS_SESSION_REQUIRED_MESSAGE =
  'Tu sesión caducó: vuelve a escribir tu fecha de nacimiento.';
export const PATIENT_ACCESS_GONE_CODE = 'PATIENT_ACCESS_GONE';
export const PATIENT_ACCESS_GONE_MESSAGE =
  'Este enlace ya no está disponible. Pide uno nuevo a la clínica.';
export const PATIENT_ACCESS_NO_BIRTH_DATE_MESSAGE =
  'El paciente no tiene fecha de nacimiento registrada: añádela en su ficha antes de compartir el enlace (es lo que se le pedirá para abrirlo).';
export const PATIENT_ACCESS_NO_HOST_MESSAGE =
  'No se pudo armar el enlace desde esta dirección: entra por la dirección de la clínica.';
export const PATIENT_ACCESS_LINK_NOT_FOUND_MESSAGE = 'Enlace no encontrado';
export const PATIENT_ACCESS_APPOINTMENT_NOT_FOUND_MESSAGE =
  'Cita no encontrada';

// --- Motivos de auditoría ----------------------------------------------------

export const PATIENT_ACCESS_LINK_CREATED_REASON = 'PATIENT_ACCESS_LINK_CREATED';
export const PATIENT_ACCESS_LINK_REVOKED_REASON = 'PATIENT_ACCESS_LINK_REVOKED';
export const PATIENT_ACCESS_VERIFIED_REASON = 'PATIENT_ACCESS_VERIFIED';
export const PATIENT_ACCESS_LOCKED_REASON = 'PATIENT_ACCESS_LOCKED';

// --- Reglas puras ------------------------------------------------------------

export function buildPatientAccessUrl(base: string, token: string): string {
  return `${base}${PATIENT_ACCESS_PUBLIC_PATH}/${token}`;
}

export function patientAccessExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60_000);
}

/** Apartados sin repetir, en el orden canónico (citas, presupuestos, cuenta). */
export function normalizeScopes(
  scopes: readonly PatientAccessScope[],
): PatientAccessScope[] {
  const set = new Set(scopes);
  return PATIENT_ACCESS_SCOPES.filter((s) => set.has(s));
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * La fecha que escribe el paciente, como día civil AAAA-MM-DD, o `null` si no
 * es una fecha real (el 30 de febrero no existe).
 */
export function normalizeBirthDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CIVIL_DATE.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return `${y}-${m}-${d}`;
}

/** Día civil de la fecha de nacimiento guardada (medianoche UTC). */
export function storedBirthDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Fecha dada contra la guardada, en TIEMPO CONSTANTE: se comparan los SHA-256
 * (misma longitud siempre) con `timingSafeEqual`, así el tiempo no depende de
 * cuántos caracteres coinciden. Sin fecha guardada (token desconocido) se
 * compara igual contra un valor que nunca casa.
 */
export function birthDateMatches(
  given: string | null,
  stored: string | null,
): boolean {
  const a = createHash('sha256')
    .update(`dob:${given ?? '\u0000given'}`)
    .digest();
  const b = createHash('sha256')
    .update(`dob:${stored ?? '\u0000stored'}`)
    .digest();
  const equal = timingSafeEqual(a, b);
  return equal && given !== null && stored !== null;
}

export interface AttemptState {
  failedAttempts: number;
  lockedUntil: Date | null;
}

export type VerifyDecision =
  | { kind: 'LOCKED'; lockedUntil: Date }
  | { kind: 'OK'; failedAttemptsBefore: number }
  | { kind: 'WRONG'; failedAttempts: number }
  | { kind: 'LOCK'; failedAttempts: number; lockedUntil: Date };

/**
 * Lo que hace una verificación sobre el contador de un enlace (con la fila
 * bloqueada). Un bloqueo vencido empieza de cero; durante el bloqueo, 429
 * aunque la fecha sea buena; el acierto vuelve el contador a cero; el quinto
 * fallo bloquea 30 minutos.
 */
export function decideVerification(
  state: AttemptState,
  matches: boolean,
  now: Date,
): VerifyDecision {
  if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
    return { kind: 'LOCKED', lockedUntil: state.lockedUntil };
  }
  const before = state.lockedUntil ? 0 : state.failedAttempts;
  if (matches) return { kind: 'OK', failedAttemptsBefore: before };
  const failedAttempts = before + 1;
  if (failedAttempts >= PATIENT_ACCESS_MAX_ATTEMPTS) {
    return {
      kind: 'LOCK',
      failedAttempts: PATIENT_ACCESS_MAX_ATTEMPTS,
      lockedUntil: new Date(
        now.getTime() + PATIENT_ACCESS_LOCK_MINUTES * 60_000,
      ),
    };
  }
  return { kind: 'WRONG', failedAttempts };
}

/** Segundos hasta el fin del bloqueo, redondeados hacia arriba (≥ 1). */
export function retryAfterSeconds(lockedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

/** ¿Sigue vivo el enlace (ni revocado ni caducado)? El bloqueo no cuenta. */
export function isLinkLive(
  link: { revokedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return link.revokedAt === null && link.expiresAt.getTime() > now.getTime();
}

const SCOPE_WORDS: Record<PatientAccessScope, string> = {
  APPOINTMENTS: 'tus citas',
  PLANS: 'tus presupuestos',
  ACCOUNT: 'tu estado de cuenta',
};

/** «tus citas, tus presupuestos y tu estado de cuenta» según lo compartido. */
export function scopesSentence(scopes: readonly PatientAccessScope[]): string {
  const words = normalizeScopes(scopes).map((s) => SCOPE_WORDS[s]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} y ${words[words.length - 1]}`;
}

/**
 * Texto de WhatsApp: el nombre de pila, la clínica y qué se comparte, sin
 * importes ni tratamientos (el mensaje puede verlo otra persona).
 */
export function patientAccessWhatsAppMessage(input: {
  firstName: string | null;
  clinicName: string;
  scopes: readonly PatientAccessScope[];
  url: string;
  expiresAtLabel: string;
}): string {
  const greeting = input.firstName ? `Hola ${input.firstName}` : 'Hola';
  return `${greeting}, te saludamos de ${input.clinicName}. En este enlace personal puedes ver ${scopesSentence(input.scopes)}; para abrirlo te pediremos la fecha de nacimiento del paciente. Vale hasta el ${input.expiresAtLabel}: ${input.url}`;
}
