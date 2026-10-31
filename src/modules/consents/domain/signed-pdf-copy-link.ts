import { createHash, randomBytes } from 'node:crypto';

/**
 * DX-443: copia del PDF firmado (DX-422) para el paciente o su responsable,
 * por un enlace de un solo uso. Mismo esquema que los demás enlaces públicos
 * (DX-005, DX-435): 32 bytes aleatorios en base64url que viajan SOLO en el
 * email, y su SHA-256 en la BD.
 */

const HOUR = 60 * 60_000;
const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Ruta pública de la web (`/copia/<token>`). */
export const SIGNED_PDF_COPY_PUBLIC_PATH = '/copia';

export const SIGNED_PDF_COPY_CONFIG = Symbol('SIGNED_PDF_COPY_CONFIG');

export interface SignedPdfCopyConfig {
  /** Horas que vale el enlace desde que se envía. */
  ttlHours: number;
}

export const SIGNED_PDF_COPY_DEFAULT_TTL_HOURS = 7 * 24;
const TTL_ENV = 'SIGNED_PDF_COPY_LINK_TTL_HOURS';
const MAX_TTL_HOURS = 30 * 24;

/** Lee la caducidad del entorno; un valor inválido hace fallar el arranque. */
export function loadSignedPdfCopyConfig(
  get: (key: string) => string | undefined,
): SignedPdfCopyConfig {
  const raw = get(TTL_ENV)?.trim();
  if (raw === undefined || raw === '') {
    return { ttlHours: SIGNED_PDF_COPY_DEFAULT_TTL_HOURS };
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_TTL_HOURS) {
    throw new Error(
      `${TTL_ENV} tiene que ser un entero entre 1 y ${MAX_TTL_HOURS} (horas que vale el enlace de la copia del PDF firmado).`,
    );
  }
  return { ttlHours: value };
}

/** Token del enlace en texto plano: viaja SOLO en la URL, nunca se guarda. */
export function generateSignedPdfCopyToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashSignedPdfCopyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token (enumeración, enlaces truncados). */
export function isWellFormedSignedPdfCopyToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export function signedPdfCopyExpiresAt(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * HOUR);
}

/** `base` = `<protocolo>://<host de la clínica>` (TenantLinkBaseService). */
export function buildSignedPdfCopyUrl(base: string, token: string): string {
  return `${base}${SIGNED_PDF_COPY_PUBLIC_PATH}/${token}`;
}

/**
 * Lo que ve quien abre el enlace. `GONE` no se distingue de un token
 * inventado o de otra clínica: 404 genérico (caducado o invalidado al
 * reenviar). Usado, mientras no caduque: «enlace usado».
 */
export type PublicSignedPdfCopyState = 'AVAILABLE' | 'USED' | 'GONE';

export function publicSignedPdfCopyState(
  link: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): PublicSignedPdfCopyState {
  if (link.revokedAt !== null) return 'GONE';
  if (link.expiresAt.getTime() <= now.getTime()) return 'GONE';
  return link.usedAt === null ? 'AVAILABLE' : 'USED';
}

export const SIGNED_PDF_COPY_MESSAGES: Record<
  Exclude<PublicSignedPdfCopyState, 'GONE'>,
  string
> = {
  AVAILABLE: 'Tu copia del documento firmado está lista para descargar',
  USED: 'Este enlace ya se usó',
};

/** 404 genérico: token inventado, de otra clínica, caducado o invalidado (igual). */
export const SIGNED_PDF_COPY_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';
/** 410 al intentar descargar con un enlace ya usado. */
export const SIGNED_PDF_COPY_USED_MESSAGE =
  'Este enlace ya se usó. Si necesitas otra copia, pídesela a la clínica.';
export const SIGNED_PDF_COPY_USED_CODE = 'SIGNED_PDF_COPY_LINK_USED';

/** Motivo de auditoría de la descarga pública (origen PUBLIC_LINK). */
export const SIGNED_PDF_COPY_DOWNLOADED_REASON = 'SIGNED_PDF_COPY_DOWNLOADED';
