import type { PaymentProofPolicy } from '@prisma/client';
import {
  type ByteRangeSource,
  sniffRestrictedFrom,
} from '../../../shared/storage/document-content';

/**
 * Comprobante del cobro (DX-389): la captura del pago móvil o de la
 * transferencia que se guarda con el abono. JPG, PNG, WebP o PDF de hasta
 * 10 MB, decidido por el CONTENIDO (el detector compartido de los documentos
 * del paciente, más la firma RIFF/WEBP, que ese detector no conoce).
 */
export const MAX_PAYMENT_PROOF_BYTES = 10 * 1024 * 1024;

export const PAYMENT_PROOF_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type PaymentProofMime = (typeof PAYMENT_PROOF_MIME_TYPES)[number];

export const PROOF_TYPE_MESSAGE =
  'El comprobante debe ser una imagen JPG, PNG o WebP, o un PDF.';
export const PROOF_TOO_LARGE_MESSAGE =
  'El comprobante supera el máximo de 10 MB.';
export const PROOF_REQUIRED_MESSAGE =
  'Este medio de pago exige el comprobante del cobro. Adjúntalo para registrar el abono.';
export const PROOF_NOT_ALLOWED_MESSAGE =
  'Este medio de pago no admite comprobante.';
export const PROOF_REJECTED_CODE = 'PAYMENT_PROOF_REJECTED';
export const PROOF_ALREADY_USED_MESSAGE =
  'Este comprobante ya está adjunto a otro abono. Sube un archivo nuevo.';
export const PROOF_DUPLICATE_LINES_MESSAGE =
  'Cada forma de pago lleva su propio comprobante: no repitas la misma subida.';
export const PROOF_NOT_FOUND_MESSAGE = 'El abono no tiene comprobante.';

/** Todo lo subido y aún sin entregar a un abono vive bajo este prefijo. */
export const PENDING_PROOF_PREFIX = 'payment-proofs/pending/';
/** Un pendiente de más de 24 h ya no lo entregará nadie (el POST prefirmado vale 15 min). */
export const PENDING_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Las URL firmadas para ver o descargar el comprobante viven 5 minutos. */
export const PROOF_URL_TTL_SECONDS = 300;
/** El POST prefirmado vale 15 minutos (como los documentos del paciente). */
export const PROOF_UPLOAD_TTL_SECONDS = 15 * 60;

/**
 * La regla de «Pide comprobante» ante lo que llega con el abono. REQUIRED sin
 * comprobante y NONE con comprobante son 400 en español.
 */
export function proofPolicyError(
  policy: PaymentProofPolicy,
  hasProof: boolean,
): string | null {
  if (policy === 'REQUIRED' && !hasProof) return PROOF_REQUIRED_MESSAGE;
  if (policy === 'NONE' && hasProof) return PROOF_NOT_ALLOWED_MESSAGE;
  return null;
}

export function isPaymentProofMime(
  type: string | null,
): type is PaymentProofMime {
  return (PAYMENT_PROOF_MIME_TYPES as readonly string[]).includes(type ?? '');
}

/**
 * Tipo por CONTENIDO: PDF/JPG/PNG con el detector compartido y WebP por su
 * cabecera (`RIFF` + tamaño + `WEBP`). Lo demás (HEIC, DOCX, SVG, …) es null.
 */
export async function sniffProofFrom(
  source: ByteRangeSource,
): Promise<PaymentProofMime | null> {
  if (source.size >= 12) {
    const head = await source.read(0, 12);
    if (
      head.length >= 12 &&
      head.toString('latin1', 0, 4) === 'RIFF' &&
      head.toString('latin1', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
  }
  return sniffRestrictedFrom(source, [
    'application/pdf',
    'image/jpeg',
    'image/png',
  ] as const);
}

const EXTENSIONS: Record<PaymentProofMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuids(label: string, tenantId: string, uploadId: string): void {
  if (!UUID.test(tenantId) || !UUID.test(uploadId)) {
    throw new Error(`${label}: tenantId y uploadId deben ser uuid`);
  }
}

/**
 * Clave definitiva: `payment-proofs/<tenantId>/<attemptId>-<sha16>.<ext>`.
 * Solo ids, la huella y la extensión del tipo DETECTADO: nada del nombre
 * original ni del paciente.
 */
export function proofStorageKey(
  tenantId: string,
  attemptId: string,
  type: PaymentProofMime,
  sha256: string,
): string {
  assertUuids('proofStorageKey', tenantId, attemptId);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('proofStorageKey: sha256 debe ser hex de 64');
  }
  return `payment-proofs/${tenantId}/${attemptId}-${sha256.slice(0, 16)}.${EXTENSIONS[type]}`;
}

/**
 * Donde el navegador deja el fichero antes del abono:
 * `payment-proofs/pending/<tenantId>/<uploadId>`. La API no lo sirve nunca;
 * lo que se queda aquí lo borra el ciclo de vida del bucket a las 24 h.
 */
export function pendingProofKey(tenantId: string, uploadId: string): string {
  assertUuids('pendingProofKey', tenantId, uploadId);
  return `payment-proofs/pending/${tenantId}/${uploadId}`;
}

const MIME_ALIASES: Record<PaymentProofMime, readonly string[]> = {
  'application/pdf': ['application/pdf', 'application/x-pdf'],
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/png': ['image/png', 'image/x-png'],
  'image/webp': ['image/webp'],
};

const NAME_EXTENSIONS: Record<PaymentProofMime, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

const GENERIC_MIME = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

function mimeOf(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().split(';')[0];
}

function extensionOfName(name: string | null | undefined): string {
  const match = /\.([^./\\]+)$/.exec(name ?? '');
  return match ? match[1].toLowerCase() : '';
}

const ALL_EXTENSIONS = PAYMENT_PROOF_MIME_TYPES.flatMap(
  (t) => NAME_EXTENSIONS[t],
);
const REJECTED_EXTENSIONS = [
  'heic',
  'heif',
  'docx',
  'dcm',
  'dicom',
  'svg',
  'html',
];

/**
 * ¿Lo que DECLARA el cliente al pedir la subida puede ser un comprobante?
 * Una etiqueta concreta que no es de JPG/PNG/WebP/PDF, o una extensión
 * conocida de otro tipo (HEIC, SVG, …), se rechaza antes de autorizar. Es una
 * comodidad: la decisión final es el contenido.
 */
export function declaredLooksLikeProof(declared: {
  mimeType?: string | null;
  name?: string | null;
}): boolean {
  const mime = mimeOf(declared.mimeType);
  if (
    !GENERIC_MIME.has(mime) &&
    !PAYMENT_PROOF_MIME_TYPES.some((t) => MIME_ALIASES[t].includes(mime))
  ) {
    return false;
  }
  const ext = extensionOfName(declared.name);
  return !(REJECTED_EXTENSIONS.includes(ext) && !ALL_EXTENSIONS.includes(ext));
}

/** ¿Lo que DICE el cliente cuadra con lo que ES (un PNG llamado `.pdf` no)? */
export function declaredMatchesDetected(
  declared: { mimeType?: string | null; name?: string | null },
  detected: PaymentProofMime,
): boolean {
  const mime = mimeOf(declared.mimeType);
  if (!GENERIC_MIME.has(mime) && !MIME_ALIASES[detected].includes(mime)) {
    return false;
  }
  const ext = extensionOfName(declared.name);
  return !(
    ALL_EXTENSIONS.includes(ext) && !NAME_EXTENSIONS[detected].includes(ext)
  );
}

/** Lo ya comprobado y copiado a su clave definitiva, listo para la fila. */
export interface PaymentProofAttachment {
  /**
   * La subida (`uploadId`) que lo originó: la BD la deja usar una sola vez
   * (único por clínica), así un mismo archivo no respalda dos abonos.
   */
  uploadId: string;
  /** Clave en el almacén: no sale nunca por la API. */
  key: string;
  mime: PaymentProofMime;
  size: number;
  sha256: string;
  /** Nombre original, solo para mostrar. */
  name: string;
}
