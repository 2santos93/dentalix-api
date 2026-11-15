/**
 * DX-468: copia INFORMATIVA de una receta emitida para el paciente (o el
 * responsable de un menor), por un enlace caducable. No es la receta
 * electrónica oficial: para retirar el medicamento vale la impresa y firmada.
 *
 * El token es el de los demás enlaces públicos (`shared/public-links`, como
 * la copia del PDF firmado de DX-443): 256 bits que viajan solo en el
 * mensaje; en la BD, su SHA-256. A diferencia de DX-443 no se gasta al
 * abrirlo: sirve hasta que caduca (30 días por defecto), se reenvía (el
 * anterior deja de servir) o se archiva al paciente (DX-461).
 */

const DAY = 24 * 60 * 60_000;

/** Ruta pública de la web (`/receta/copia/<token>`). */
export const PRESCRIPTION_COPY_PUBLIC_PATH = '/receta/copia';

export const PRESCRIPTION_COPY_CONFIG = Symbol('PRESCRIPTION_COPY_CONFIG');

export interface PrescriptionCopyConfig {
  /** Días que vale el enlace desde que se envía. */
  ttlDays: number;
}

export const PRESCRIPTION_COPY_DEFAULT_TTL_DAYS = 30;
const TTL_ENV = 'PRESCRIPTION_COPY_LINK_TTL_DAYS';
const MAX_TTL_DAYS = 90;

/** Lee la caducidad del entorno; un valor inválido hace fallar el arranque. */
export function loadPrescriptionCopyConfig(
  get: (key: string) => string | undefined,
): PrescriptionCopyConfig {
  const raw = get(TTL_ENV)?.trim();
  if (raw === undefined || raw === '') {
    return { ttlDays: PRESCRIPTION_COPY_DEFAULT_TTL_DAYS };
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_TTL_DAYS) {
    throw new Error(
      `${TTL_ENV} tiene que ser un entero entre 1 y ${MAX_TTL_DAYS} (días que vale el enlace de la copia de la receta).`,
    );
  }
  return { ttlDays: value };
}

export function prescriptionCopyExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * DAY);
}

/** `base` = `<protocolo>://<host de la clínica>` (TenantLinkBaseService). */
export function buildPrescriptionCopyUrl(base: string, token: string): string {
  return `${base}${PRESCRIPTION_COPY_PUBLIC_PATH}/${token}`;
}

/** Por dónde se envía: email (outbox) o WhatsApp (`wa.me` desde la web). */
export const PRESCRIPTION_COPY_CHANNELS = ['EMAIL', 'WHATSAPP'] as const;
export type PrescriptionCopyChannel =
  (typeof PRESCRIPTION_COPY_CHANNELS)[number];

/**
 * Lo que ve quien abre el enlace:
 * - `AVAILABLE`: vivo y la receta sigue emitida.
 * - `EXPIRED`: el token existe pero caducó (410 con su código: «pide que te
 *   la reenvíen»). Con 256 bits no hay enumeración que proteger.
 * - `GONE`: invalidado al reenviar o al archivar al paciente, inventado o de
 *   otra clínica: el mismo 404 genérico.
 */
export type PrescriptionCopyLinkState = 'AVAILABLE' | 'EXPIRED' | 'GONE';

export function prescriptionCopyLinkState(
  link: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): PrescriptionCopyLinkState {
  if (link.revokedAt !== null) return 'GONE';
  if (link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'AVAILABLE';
}

/** 404 genérico: token inventado, de otra clínica o invalidado (igual). */
export const PRESCRIPTION_COPY_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';
/** 410 de un enlace caducado. */
export const PRESCRIPTION_COPY_EXPIRED_MESSAGE =
  'Este enlace caducó. Si necesitas otra copia de la receta, pídesela a la clínica.';
export const PRESCRIPTION_COPY_EXPIRED_CODE = 'PRESCRIPTION_COPY_LINK_EXPIRED';

/** Motivos de auditoría (VIEW / SEND de PRESCRIPTION). */
export const PRESCRIPTION_COPY_OPENED_REASON = 'PRESCRIPTION_COPY_OPENED';
export const PRESCRIPTION_COPY_SENT_REASON = 'PRESCRIPTION_COPY_SENT';

/**
 * Pie de la copia por defecto (Ajustes › Recetas lo cambia por clínica). Lo
 * que dice: la copia no sirve para retirar el medicamento.
 */
export const DEFAULT_PRESCRIPTION_COPY_FOOTER =
  'Copia para el paciente. Para retirar el medicamento presente la receta impresa y firmada.';
export const PRESCRIPTION_COPY_FOOTER_MAX = 300;

/** El pie que se pinta: el de la clínica o, sin él, el de plataforma. */
export function prescriptionCopyFooter(clinicFooter: string | null): string {
  const text = clinicFooter?.trim();
  return text ? text : DEFAULT_PRESCRIPTION_COPY_FOOTER;
}

/**
 * Teléfono para mostrar en la ficha sin el número entero: los 4 últimos
 * dígitos («••• 4567»). Nunca el número completo en la respuesta del envío.
 */
export function maskPhoneDigits(digits: string): string {
  return `••• ${digits.slice(-4)}`;
}
