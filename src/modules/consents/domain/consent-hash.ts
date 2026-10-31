import { createHash } from 'node:crypto';
import type {
  ConsentSignerType,
  SignatureRequestChannel,
} from '@prisma/client';

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

/**
 * DX-243: lo que sella la firma del PACIENTE a distancia. Además del texto
 * exacto que se le mostró, la versión de la plantilla, el firmante, su firma
 * y `signedAt` del servidor, sella las evidencias del enlace (canal, destino
 * enmascarado, envío, apertura, verificación del código, IP y navegador).
 * Sin la firma del profesional: llega después (`computeCountersignatureHash`).
 */
export interface RemoteConsentHashInput {
  title: string;
  body: string;
  templateVersion: number;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  /** PNG en base64, sin prefijo `data:`. */
  patientSignature: string;
  signedAt: Date;
  channel: SignatureRequestChannel;
  destinationMasked: string;
  sentAt: Date;
  openedAt: Date;
  verifiedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export function computeRemoteConsentHash(
  input: RemoteConsentHashInput,
): string {
  const canonical = JSON.stringify([
    'dentalix-consent-remote-v1',
    input.title,
    input.body,
    input.templateVersion,
    input.signerType,
    input.signerName,
    input.signerDocument,
    input.professionalName,
    input.patientSignature,
    input.signedAt.toISOString(),
    input.channel,
    input.destinationMasked,
    input.sentAt.toISOString(),
    input.openedAt.toISOString(),
    input.verifiedAt.toISOString(),
    input.ipAddress,
    input.userAgent,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** DX-243: la firma del profesional que completa uno firmado a distancia. */
export interface CountersignatureHashInput {
  /** `contentHash` del consentimiento: la cadena ata las dos firmas. */
  consentHash: string;
  professionalName: string;
  /** PNG en base64, sin prefijo `data:`. */
  professionalSignature: string;
  signedAt: Date;
}

export function computeCountersignatureHash(
  input: CountersignatureHashInput,
): string {
  const canonical = JSON.stringify([
    'dentalix-consent-countersign-v1',
    input.consentHash,
    input.professionalName,
    input.professionalSignature,
    input.signedAt.toISOString(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
