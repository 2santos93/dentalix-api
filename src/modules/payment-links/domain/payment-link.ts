import { createHash, randomBytes } from 'node:crypto';
import { addCivilDays } from '../../../shared/time/civil-day';

/**
 * DX-569: el enlace por el que el paciente reporta un pago. Mismo esquema que
 * los demás enlaces públicos (DX-005, DX-435, DX-443): 32 bytes aleatorios en
 * base64url que viajan SOLO en el mensaje, y su SHA-256 en la BD.
 */

const DAY = 24 * 60 * 60_000;
const TOKEN_BYTES = 32;
// 32 bytes en base64url sin relleno = 43 caracteres URL-safe.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Ruta pública de la web (`/pago/<token>`). */
export const PAYMENT_LINK_PUBLIC_PATH = '/pago';
/** El enlace vale 7 días desde que se crea (D3). */
export const PAYMENT_LINK_TTL_DAYS = 7;
/** Subidas de comprobante que se autorizan como mucho por enlace (D6). */
export const PAYMENT_LINK_MAX_PROOF_UPLOADS = 3;
/** Días antes de crear el enlace que admite la fecha del pago (D5). */
export const PAYMENT_REPORT_PAID_ON_SLACK_DAYS = 2;

export const REPORT_REFERENCE_MAX = 60;
export const REPORT_NOTE_MAX = 280;
export const REJECT_REASON_MAX = 280;

/** Token del enlace en texto plano: viaja SOLO en la URL, nunca se guarda. */
export function generatePaymentLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hash estable del token, para guardar y buscar sin el texto plano. */
export function hashPaymentLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Descarta en el acto lo que no puede ser un token (enumeración, enlaces truncados). */
export function isWellFormedPaymentLinkToken(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export function paymentLinkExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PAYMENT_LINK_TTL_DAYS * DAY);
}

/** `base` = `<protocolo>://<host de la clínica>` ya validado. */
export function buildPaymentLinkUrl(base: string, token: string): string {
  return `${base}${PAYMENT_LINK_PUBLIC_PATH}/${token}`;
}

/** Concepto genérico (D4): nunca el nombre de un tratamiento. */
export type PaymentLinkConcept = 'INSTALLMENT' | 'BALANCE';

export const PAYMENT_LINK_CONCEPT_LABELS: Record<PaymentLinkConcept, string> = {
  INSTALLMENT: 'Cuota del plan de pagos',
  BALANCE: 'Saldo pendiente',
};

/** Canal por el que se envía el enlace; sin canal, solo se copia la URL. */
export type PaymentLinkChannel = 'EMAIL' | 'WHATSAPP';

/**
 * Estado derivado de un enlace (D3): usado (ya tiene reporte), anulado
 * (otro enlace del mismo destino o el archivado del paciente), caducado o
 * vivo. Usado gana: un enlace con reporte nunca se anula (CHECK).
 */
export type PaymentLinkStatus = 'LIVE' | 'USED' | 'EXPIRED' | 'REVOKED';

export function paymentLinkStatus(
  link: { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null },
  now: Date,
): PaymentLinkStatus {
  if (link.usedAt !== null) return 'USED';
  if (link.revokedAt !== null) return 'REVOKED';
  if (link.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'LIVE';
}

/**
 * La ventana de la fecha del pago (D5): desde el día de creación del enlace
 * menos 2 días hasta hoy, los dos en la sede del enlace. `null` si vale.
 */
export function paidOnError(
  paidOn: string,
  window: { linkCreatedOn: string; today: string },
): string | null {
  const earliest = addCivilDays(
    window.linkCreatedOn,
    -PAYMENT_REPORT_PAID_ON_SLACK_DAYS,
  );
  if (paidOn > window.today) return PAID_ON_FUTURE_MESSAGE;
  if (paidOn < earliest) return PAID_ON_TOO_OLD_MESSAGE;
  return null;
}

export const PAID_ON_FUTURE_MESSAGE =
  'La fecha del pago no puede ser posterior a hoy.';
export const PAID_ON_TOO_OLD_MESSAGE =
  'La fecha del pago es anterior a este enlace. Si pagaste antes, consúltalo con la clínica.';

/**
 * Mensaje de WhatsApp con el enlace (D3). A propósito NO recibe importes,
 * tratamientos ni nada de salud: la notificación se lee en la pantalla
 * bloqueada.
 */
export function paymentLinkWhatsAppMessage(input: {
  firstName: string | null;
  clinicName: string;
  url: string;
}): string {
  const greeting = input.firstName ? `Hola ${input.firstName}` : 'Hola';
  return `${greeting}, te saludamos de ${input.clinicName}. Aquí tienes los datos para hacer tu pago y avisarnos cuando lo hagas (el enlace es personal): ${input.url}`;
}

/** Solo el nombre de pila (D4): nunca los apellidos. */
export function firstNameOnly(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

// --- Mensajes (en español; los 404 no distinguen el motivo) ---------------

export const PAYMENT_LINK_NOT_FOUND_MESSAGE =
  'El enlace no existe o ya no es válido.';
export const PAYMENT_LINK_USED_MESSAGE = 'Ya recibimos tu reporte de pago.';
export const PAYMENT_LINK_USED_CODE = 'PAYMENT_LINK_USED';
export const PAYMENT_LINK_TARGET_REQUIRED_MESSAGE =
  'Elige a qué se cobra: un plan de tratamiento o el saldo migrado.';
export const PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE =
  'El plan no existe o no es de este paciente.';
export const PAYMENT_LINK_BALANCE_NOT_FOUND_MESSAGE =
  'El saldo migrado no existe o no es de este paciente.';
export const PAYMENT_LINK_CURRENCY_MESSAGE =
  'La moneda del enlace es la de lo que se cobra.';
export const PAYMENT_LINK_NO_EMAIL_MESSAGE =
  'El paciente no tiene un email registrado. Añádelo en su ficha o envía el enlace por WhatsApp.';
export const PAYMENT_LINK_NO_WHATSAPP_MESSAGE =
  'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo con + y su prefijo.';
export const PAYMENT_LINK_NO_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica: revisa su subdominio.';
export const PAYMENT_LINK_NO_METHODS_MESSAGE =
  'Ningún medio de pago está permitido en el enlace con datos para pagar en esta sede. Configúralo en Ajustes › Medios de pago.';

export const REPORT_METHOD_MESSAGE =
  'Elige uno de los medios de pago que ofrece el enlace.';
export const REPORT_CURRENCY_MESSAGE =
  'Elige una de las monedas que cobra la clínica.';
export const REPORT_REFERENCE_REQUIRED_MESSAGE =
  'Escribe la referencia del pago: este medio la pide.';
export const REPORT_REFERENCE_TOO_LONG_MESSAGE = `La referencia admite hasta ${REPORT_REFERENCE_MAX} caracteres.`;
export const REPORT_NOTE_TOO_LONG_MESSAGE = `La nota admite hasta ${REPORT_NOTE_MAX} caracteres.`;
export const REPORT_PROOF_REQUIRED_MESSAGE =
  'Adjunta el comprobante del pago: este medio lo pide.';
export const REPORT_PROOF_NOT_ALLOWED_MESSAGE =
  'Este medio de pago no admite comprobante.';
export const REPORT_PROOF_UNKNOWN_MESSAGE =
  'El comprobante no se subió por este enlace. Vuelve a adjuntarlo.';
export const PROOF_UPLOADS_EXHAUSTED_CODE =
  'PAYMENT_LINK_PROOF_UPLOADS_EXHAUSTED';
export const PROOF_UPLOADS_EXHAUSTED_MESSAGE = `Ya se subieron ${PAYMENT_LINK_MAX_PROOF_UPLOADS} comprobantes con este enlace. Si necesitas otro, pide un enlace nuevo a la clínica.`;

export const PAYMENT_REPORT_NOT_FOUND_MESSAGE =
  'No encontramos ese reporte de pago en esta clínica.';
export const PAYMENT_REPORT_NOT_PENDING_MESSAGE =
  'Este reporte ya no está pendiente.';
export const PAYMENT_REPORT_NOT_PENDING_CODE = 'PAYMENT_REPORT_NOT_PENDING';
export const PAYMENT_REPORT_NO_PROOF_MESSAGE =
  'El reporte no tiene comprobante.';
export const REJECT_REASON_MESSAGE = `Escribe el motivo (hasta ${REJECT_REASON_MAX} caracteres).`;
export const RATE_OVERRIDE_REASON_MESSAGE =
  'Escribe el motivo para usar otra tasa (hasta 280 caracteres).';

/** Motivos de auditoría (metadata.reason). */
export const PAYMENT_LINK_CREATED_REASON = 'PAYMENT_LINK_CREATED';
export const PAYMENT_REPORT_SUBMITTED_REASON = 'PAYMENT_REPORT_SUBMITTED';
export const PAYMENT_REPORT_CONFIRMED_REASON = 'PAYMENT_REPORT_CONFIRMED';
export const PAYMENT_REPORT_REJECTED_REASON = 'PAYMENT_REPORT_REJECTED';
export const PAYMENT_REPORT_PROOF_VIEWED_REASON = 'PAYMENT_REPORT_PROOF_VIEWED';
