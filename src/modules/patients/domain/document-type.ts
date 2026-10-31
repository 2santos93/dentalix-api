import type { DocumentType } from '@prisma/client';

/**
 * DX-327: tipos de documento del paciente, iguales para cualquier clínica y
 * sin país (R2). El nombre que ve cada clínica sale de `documentTypeName`
 * (R17); los códigos anteriores solo se leen en `legacy-document-codes.ts`.
 */
export const DOCUMENT_TYPES = [
  'NATIONAL_ID',
  'PASSPORT',
  'RESIDENCE_PERMIT',
  'TAX_ID',
  'OTHER',
] as const satisfies readonly DocumentType[];

/** R2: nombre genérico de cada tipo. El único mapa de etiquetas de la API. */
export const DOC_TYPE_LABEL: Readonly<Record<DocumentType, string>> = {
  NATIONAL_ID: 'Documento nacional',
  PASSPORT: 'Pasaporte',
  RESIDENCE_PERMIT: 'Permiso de residencia',
  TAX_ID: 'Identificación fiscal',
  OTHER: 'Otro documento',
};

/** R7: puntos de código, no unidades UTF-16. */
export const DOC_TYPE_LABEL_MAX = 40;

/** Solo claves propias: `'constructor'` o `'__proto__'` no son tipos. */
export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && Object.hasOwn(DOC_TYPE_LABEL, value);
}

/** El mensaje va tal cual al 400. */
export class DocTypeLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocTypeLabelError';
  }
}

/**
 * Controles y formato (p. ej. U+202E invierte el texto impreso), y sustitutos
 * sueltos (`\p{Cs}`): un «\ud800» solo no es texto y la BD lo rechazaría (500).
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * R7: recorta y junta espacios; vacía o null = sin etiqueta (null), ausente =
 * no tocarla (undefined). Lanza DocTypeLabelError si pasa de 40 o lleva
 * caracteres de control o de formato.
 */
export function normalizeDocTypeLabel(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === undefined) return undefined;
  const label = raw?.replace(/\s+/g, ' ').trim() || null;
  if (label === null) return null;
  if (CONTROL_OR_FORMAT.test(label)) {
    throw new DocTypeLabelError(
      'El nombre del documento no puede llevar caracteres de control.',
    );
  }
  if ([...label].length > DOC_TYPE_LABEL_MAX) {
    throw new DocTypeLabelError(
      `El nombre del documento admite hasta ${DOC_TYPE_LABEL_MAX} caracteres.`,
    );
  }
  return label;
}

/** R16: nombres locales de una clínica; ausente o null = sin nombre local. */
export type ClinicDocumentTypeNames = Readonly<
  Partial<Record<DocumentType, string | null>>
>;

/**
 * R17: el único resolvedor del nombre visible. Etiqueta del paciente, si no
 * el nombre local de la clínica para su tipo, si no el genérico.
 */
export function documentTypeName(
  type: DocumentType,
  label: string | null | undefined,
  clinicNames: ClinicDocumentTypeNames,
): string {
  if (label) return label;
  const local = Object.hasOwn(clinicNames, type) ? clinicNames[type] : null;
  return local || DOC_TYPE_LABEL[type];
}

/** R8: «{nombre} {número}», o null sin número. */
export function documentText(
  name: string,
  number: string | null,
): string | null {
  return number ? `${name} ${number}` : null;
}

/** Una letra latina seguida de sus marcas combinantes (tildes, diéresis…). */
const LATIN_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const NOT_KEY = /[^\p{L}\p{N}\p{M}]/gu;

/**
 * R16 y R19: clave de comparación de un nombre en cualquier escritura
 * (pre-flight I4). Ignora mayúsculas, tildes latinas, espacios y puntuación:
 * «Nómbre Locál» = «nombre-local». Las marcas solo se quitan de las letras
 * latinas: en otras escrituras son parte de la letra (el dakuten japonés, las
 * vocales del devanagari). `toLowerCase()` sin locale es el plegado por
 * defecto de Unicode, igual en cualquier entorno. Solo puntuación o símbolos
 * da la clave vacía.
 */
export function documentTypeKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(LATIN_MARKS, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(NOT_KEY, '');
}

/**
 * R19 (2): códigos y nombres genéricos (en español e inglés) que reconoce la
 * importación, por tipo y ya como claves (`documentTypeKey`). Spec §4.7.
 */
export const GENERIC_DOC_TYPE_NAMES: Readonly<
  Record<DocumentType, readonly string[]>
> = {
  NATIONAL_ID: [
    'nationalid',
    'documentonacional',
    'documentonacionaldeidentidad',
    'documentodeidentidad',
    'documentoidentidad',
    'identidad',
  ],
  PASSPORT: ['passport', 'pasaporte', 'pa', 'pas', 'pp'],
  RESIDENCE_PERMIT: [
    'residencepermit',
    'permisoderesidencia',
    'permisoresidencia',
  ],
  TAX_ID: ['taxid', 'identificacionfiscal', 'idfiscal'],
  OTHER: ['other', 'otro', 'otrodocumento'],
};
