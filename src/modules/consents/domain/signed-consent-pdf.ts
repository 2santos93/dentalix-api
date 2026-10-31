import type {
  ConsentSignerType,
  SignatureRequestChannel,
} from '@prisma/client';
import {
  regionalFormat,
  type RegionalFormat,
} from '../../../shared/format/regional-format';
import { transliterateToAscii } from '../../../shared/storage/ascii-filename';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from './consent-hash';

/**
 * DX-422: todo lo que sale en el PDF firmado de un consentimiento firmado a
 * distancia y ya completo (con la firma del profesional). Viene tal cual de
 * la base: el texto y las evidencias congelados, los dos hashes guardados y
 * la sede DESDE LA QUE SE ENVIÓ (su zona IANA y su formato).
 */
export interface SignedConsentPdfSource {
  consentId: string;
  clinicName: string;
  title: string;
  body: string;
  templateVersion: number;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  /** PNG en base64, sin prefijo `data:`. */
  patientSignature: string;
  professionalSignature: string;
  signedAt: Date;
  professionalSignedAt: Date;
  /** Hash guardado de la firma del paciente (`patient_consents.contentHash`). */
  contentHash: string;
  /** Hash guardado de la firma del profesional (encadenado al anterior). */
  countersignatureHash: string;
  channel: SignatureRequestChannel;
  destinationMasked: string;
  sentAt: Date;
  openedAt: Date;
  verifiedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  location: {
    name: string;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  };
}

export interface SignedConsentEvidenceRow {
  label: string;
  value: string;
}

/** Lo que pinta el renderer: nada se recalcula ni se reformatea allí. */
export interface SignedConsentPdfModel {
  clinicName: string;
  title: string;
  /** El texto firmado, carácter a carácter. */
  body: string;
  signerLabel: string;
  professionalLabel: string;
  patientSignature: string;
  professionalSignature: string;
  /** Página final de evidencias, en este orden. */
  evidence: SignedConsentEvidenceRow[];
  /** Para los metadatos del PDF: la firma que lo completó. */
  completedAt: Date;
}

export type SignedConsentPdfSourceErrorCode =
  | 'INTEGRITY_MISMATCH'
  | 'LOCATION_TIMEZONE_REQUIRED'
  | 'LOCATION_LOCALE_REQUIRED'
  | 'NOT_COMPLETE'
  | 'UNSUPPORTED_CHARACTERS';

/** El origen no permite generar un PDF probatorio: no se reintenta. */
export class SignedConsentPdfSourceError extends Error {
  constructor(readonly code: SignedConsentPdfSourceErrorCode) {
    super(`No se puede generar el PDF firmado: ${code}`);
    this.name = 'SignedConsentPdfSourceError';
  }
}

const CHANNEL_LABELS: Record<SignatureRequestChannel, string> = {
  EMAIL: 'Email',
};

const NOT_RECORDED = 'No registrado';

/**
 * Lo que las fuentes estándar del PDF (WinAnsi) pintan tal cual: ASCII
 * imprimible, Latin-1 y los 27 signos de 0x80–0x9F (€, —, “”, …), más los
 * saltos de línea (\n o \r\n). El español, el portugués, el francés y el
 * resto de lenguas de Europa occidental caben enteros.
 */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split(''));

const THIN_SPACES = /[\u2007\u2009\u202f]/g;

function isWinAnsiPrintable(text: string): boolean {
  const chars = [...text];
  return chars.every((ch, i) => {
    const code = ch.codePointAt(0) ?? 0;
    // B5: el tabulador no avanza igual que en pantalla y un \r suelto no es
    // un salto de línea: no se pintarían tal cual. \r\n sí (un salto).
    if (ch === '\r') return chars[i + 1] === '\n';
    return (
      ch === '\n' ||
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_EXTRA.has(ch)
    );
  });
}

/**
 * Un carácter que la fuente no tiene saldría como otro: el PDF ya no
 * reproduciría el texto firmado. Se niega (fallo definitivo, la ficha lo
 * dice) en vez de archivar un documento alterado.
 */
function assertPrintable(src: SignedConsentPdfSource): void {
  const texts = [
    src.clinicName,
    src.title,
    src.body,
    src.signerName,
    src.signerDocument ?? '',
    src.professionalName,
    src.destinationMasked,
    src.userAgent ?? '',
    src.location.name,
  ];
  if (!texts.every(isWinAnsiPrintable)) {
    throw new SignedConsentPdfSourceError('UNSUPPORTED_CHARACTERS');
  }
}

function regionalOf(location: SignedConsentPdfSource['location']): {
  timeZone: string;
  fmt: RegionalFormat;
} {
  const { timeZone, locale, hourCycle } = location;
  if (!timeZone) {
    throw new SignedConsentPdfSourceError('LOCATION_TIMEZONE_REQUIRED');
  }
  if (!locale || (hourCycle !== 'h12' && hourCycle !== 'h23')) {
    throw new SignedConsentPdfSourceError('LOCATION_LOCALE_REQUIRED');
  }
  try {
    const fmt = regionalFormat({ locale, hourCycle });
    // Una zona que no existe lanza aquí, no a mitad del PDF.
    fmt.dateTime(new Date(0), timeZone);
    return { timeZone, fmt };
  } catch (error) {
    if (error instanceof RangeError) {
      throw new SignedConsentPdfSourceError('LOCATION_LOCALE_REQUIRED');
    }
    throw error;
  }
}

/** Los dos hashes guardados casan con lo que se va a imprimir, o lanza. */
function assertIntegrity(src: SignedConsentPdfSource): void {
  const patientSide = computeRemoteConsentHash({
    title: src.title,
    body: src.body,
    templateVersion: src.templateVersion,
    signerType: src.signerType,
    signerName: src.signerName,
    signerDocument: src.signerDocument,
    professionalName: src.professionalName,
    patientSignature: src.patientSignature,
    signedAt: src.signedAt,
    channel: src.channel,
    destinationMasked: src.destinationMasked,
    sentAt: src.sentAt,
    openedAt: src.openedAt,
    verifiedAt: src.verifiedAt,
    ipAddress: src.ipAddress,
    userAgent: src.userAgent,
  });
  const professionalSide = computeCountersignatureHash({
    consentHash: src.contentHash,
    professionalName: src.professionalName,
    professionalSignature: src.professionalSignature,
    signedAt: src.professionalSignedAt,
  });
  if (
    patientSide !== src.contentHash ||
    professionalSide !== src.countersignatureHash
  ) {
    throw new SignedConsentPdfSourceError('INTEGRITY_MISMATCH');
  }
}

/**
 * El modelo del PDF firmado (DX-422). Comprueba ANTES los dos hashes: un
 * registro alterado por fuera de la app no se archiva como probatorio. Cada
 * hora va en la zona IANA y el formato de la sede desde la que se envió, con
 * el instante UTC exacto al lado (la evidencia no depende del formato).
 */
export function buildSignedConsentPdfModel(
  src: SignedConsentPdfSource,
): SignedConsentPdfModel {
  assertIntegrity(src);
  assertPrintable(src);
  const { timeZone, fmt } = regionalOf(src.location);
  // Intl separa con espacios finos (U+202F, U+2009): en el PDF, un espacio.
  const at = (instant: Date) =>
    `${fmt.dateTime(instant, timeZone).replace(THIN_SPACES, ' ')} (${timeZone}) · ${instant.toISOString()} UTC`;
  const guardian = src.signerType === 'GUARDIAN';
  const signerLabel = `${src.signerName} (${guardian ? 'responsable' : 'paciente'})${
    src.signerDocument ? ` · ${src.signerDocument}` : ''
  }`;
  const model: SignedConsentPdfModel = {
    clinicName: src.clinicName,
    title: src.title,
    body: src.body,
    signerLabel,
    professionalLabel: src.professionalName,
    patientSignature: src.patientSignature,
    professionalSignature: src.professionalSignature,
    completedAt: src.professionalSignedAt,
    evidence: [
      { label: 'Documento', value: src.title },
      { label: 'Versión de la plantilla', value: String(src.templateVersion) },
      { label: 'Identificador del consentimiento', value: src.consentId },
      {
        label: 'Huella SHA-256 de la firma del paciente',
        value: src.contentHash,
      },
      {
        label: 'Huella SHA-256 de la firma del profesional',
        value: src.countersignatureHash,
      },
      { label: 'Canal', value: CHANNEL_LABELS[src.channel] },
      { label: 'Destino', value: src.destinationMasked },
      { label: 'Firmado por', value: signerLabel },
      { label: 'Profesional', value: src.professionalName },
      { label: 'Enviado', value: at(src.sentAt) },
      { label: 'Abierto', value: at(src.openedAt) },
      { label: 'Código verificado', value: at(src.verifiedAt) },
      {
        label: guardian
          ? 'Firmado por el responsable'
          : 'Firmado por el paciente',
        value: at(src.signedAt),
      },
      {
        label: 'Firmado por el profesional',
        value: at(src.professionalSignedAt),
      },
      { label: 'IP de quien firmó', value: src.ipAddress ?? NOT_RECORDED },
      {
        label: 'Navegador de quien firmó',
        value: src.userAgent ?? NOT_RECORDED,
      },
      { label: 'Zona horaria', value: `${timeZone} (${src.location.name})` },
    ],
  };
  // El formato de la sede (p. ej. un locale con «午後») también tiene que caber.
  if (!model.evidence.every((row) => isWinAnsiPrintable(row.value))) {
    throw new SignedConsentPdfSourceError('UNSUPPORTED_CHARACTERS');
  }
  return model;
}

/** Caracteres que no van en un nombre de fichero (los de control, aparte). */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]+/g;

function withoutControlChars(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
}

/**
 * «Consentimiento firmado - <título> - <día civil de la sede>.pdf» en ASCII:
 * el nombre con el que se archiva en los documentos del paciente.
 */
export function signedConsentPdfFileName(
  title: string,
  completedAt: Date,
  timeZone: string,
): string {
  // H1: en ASCII (Chromium descarta un `filename*` con UTF-8 y lo guarda
  // como «download»); el título exacto va dentro del PDF.
  const safeTitle = Array.from(transliterateToAscii(withoutControlChars(title)))
    .map((ch) => (/^[\x20-\x7e]$/.test(ch) ? ch : '_'))
    .join('')
    .replace(UNSAFE_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `Consentimiento firmado - ${safeTitle} - ${civilDateIn(completedAt, timeZone)}.pdf`;
}

/** Código técnico del error para la fila de estado: nunca el mensaje. */
export function signedConsentPdfErrorCode(error: unknown): string {
  if (error instanceof SignedConsentPdfSourceError) return error.code;
  if (error instanceof Error && error.name === 'StorageObjectChangedError') {
    return 'STORAGE_ERROR';
  }
  return 'GENERATION_ERROR';
}
