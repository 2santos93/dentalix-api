import { createHash } from 'node:crypto';
import type { ConsentSignerType } from '@prisma/client';

/** Lo que el hash sella de un consentimiento firmado. */
export interface ConsentHashInput {
  title: string;
  body: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  /** PNG en base64, sin prefijo `data:`. */
  patientSignature: string;
  professionalSignature: string;
  signedAt: Date;
}

/**
 * SHA-256 (hex) del texto renderizado + firmante + firmas + `signedAt`.
 *
 * Se serializa como un ARRAY JSON con un orden fijo y una versión al principio:
 * JSON escapa cada campo, así que dos documentos distintos nunca producen la
 * misma cadena por correr una frontera entre campos ("ab"+"c" vs "a"+"bc"), y
 * la versión permite cambiar el formato en el futuro sin invalidar los hashes
 * ya guardados.
 */
export function computeConsentHash(input: ConsentHashInput): string {
  const canonical = JSON.stringify([
    'dentalix-consent-v1',
    input.title,
    input.body,
    input.signerType,
    input.signerName,
    input.signerDocument,
    input.professionalName,
    input.patientSignature,
    input.professionalSignature,
    input.signedAt.toISOString(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
