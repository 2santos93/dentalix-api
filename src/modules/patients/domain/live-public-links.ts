/**
 * DX-461: enlaces públicos por token ligados a un paciente que archivar
 * anula. Un enlace «vivo» es el que todavía serviría hoy: sin usar, sin
 * anular y sin caducar.
 *
 * - `slotOffers`: oferta de hueco con enlace pendiente (DX-435).
 * - `consentSignatures` / `budgetSignatures`: firma y presupuesto a distancia
 *   sin firmar ni bloquear (DX-243, DX-415).
 * - `signedPdfCopies`: copia del PDF firmado sin descargar (DX-443).
 * - `anamnesis`: cuestionario de salud sin responder (DX-099).
 * - `prescriptionCopies`: copia de una receta enviada y sin caducar (DX-468).
 * - `certificateCopies`: copia de un certificado enviada y sin caducar (DX-306).
 * - `paymentLinks`: enlace de pago sin reporte (DX-569).
 * - `externalOrderCopies`: copia de una orden externa sin descargar (DX-572).
 *
 * Fuera a propósito (ver el informe de DX-461): la confirmación de cita y las
 * indicaciones postoperatorias (archivar exige no tener citas abiertas ni HC
 * en retención, así que no pueden quedar vivas) y la baja de recordatorios
 * (ya rechaza al paciente archivado y solo sirve para dejar de recibir).
 */
export const LIVE_PUBLIC_LINK_KINDS = [
  'slotOffers',
  'consentSignatures',
  'budgetSignatures',
  'signedPdfCopies',
  'anamnesis',
  'prescriptionCopies',
  'certificateCopies',
  'paymentLinks',
  'externalOrderCopies',
] as const;

export type LivePublicLinkKind = (typeof LIVE_PUBLIC_LINK_KINDS)[number];

export type LivePublicLinkCounts = Record<LivePublicLinkKind, number>;

export const NO_LIVE_PUBLIC_LINKS: LivePublicLinkCounts = {
  slotOffers: 0,
  consentSignatures: 0,
  budgetSignatures: 0,
  signedPdfCopies: 0,
  anamnesis: 0,
  prescriptionCopies: 0,
  certificateCopies: 0,
  paymentLinks: 0,
  externalOrderCopies: 0,
};

export function totalLivePublicLinks(counts: LivePublicLinkCounts): number {
  return LIVE_PUBLIC_LINK_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

/** Motivo del audit_event que deja el número de enlaces anulados por tipo. */
export const PATIENT_ARCHIVED_LINKS_REVOKED_REASON =
  'PATIENT_ARCHIVED_LINKS_REVOKED';
