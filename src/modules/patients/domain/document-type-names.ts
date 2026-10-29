import type { DocumentType } from '@prisma/client';
import {
  DOCUMENT_TYPES,
  DOC_TYPE_LABEL,
  GENERIC_DOC_TYPE_NAMES,
  documentTypeKey,
} from './document-type';

/**
 * DX-327 (R16): nombre local de cada tipo de documento, por clínica. Todas
 * empiezan sin ninguno (NULL): ni relleno ni valor por defecto de país. Lo
 * cambia el ADMIN (PUT /patients/document-type-names, auditado).
 */

/** R16: puntos de código, no unidades UTF-16. El CHECK de la BD es el mismo. */
export const DOC_TYPE_NAME_MAX = 60;

/** La columna de `tenants` de cada tipo. Se lee solo con `Object.hasOwn`. */
export const DOC_TYPE_NAME_FIELD = {
  NATIONAL_ID: 'docTypeNameNationalId',
  PASSPORT: 'docTypeNamePassport',
  RESIDENCE_PERMIT: 'docTypeNameResidencePermit',
  TAX_ID: 'docTypeNameTaxId',
  OTHER: 'docTypeNameOther',
} as const satisfies Record<DocumentType, string>;

export type DocTypeNameField = (typeof DOC_TYPE_NAME_FIELD)[DocumentType];

/** Los cinco nombres de una clínica; null = sin nombre local. */
export type DocumentTypeNames = Record<DocumentType, string | null>;

/** 403 del PUT para quien no es ADMIN; la web (T8b) usa el mismo texto. */
export const DOCUMENT_TYPE_NAMES_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los nombres de los documentos.';

/** El mensaje va tal cual al 400. */
export class DocumentTypeNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentTypeNameError';
  }
}

/**
 * Controles y formato (p. ej. U+202E invierte el texto impreso), y sustitutos
 * sueltos (`\p{Cs}`): un «\ud800» solo no es texto y la BD lo rechazaría (500).
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * R16 (como R7, con 60): recorta y junta espacios; vacío, null o ausente =
 * sin nombre (null). Lanza DocumentTypeNameError si pasa de 60, lleva
 * caracteres de control o de formato, o no tiene ni una letra ni un número
 * en ninguna escritura (su clave queda vacía).
 */
export function normalizeDocumentTypeName(
  raw: string | null | undefined,
): string | null {
  const name = raw?.replace(/\s+/g, ' ').trim() || null;
  if (name === null) return null;
  if (CONTROL_OR_FORMAT.test(name)) {
    throw new DocumentTypeNameError(
      'El nombre del documento no puede llevar caracteres de control.',
    );
  }
  if ([...name].length > DOC_TYPE_NAME_MAX) {
    throw new DocumentTypeNameError(
      `El nombre del documento admite hasta ${DOC_TYPE_NAME_MAX} caracteres.`,
    );
  }
  if (documentTypeKey(name) === '') {
    throw new DocumentTypeNameError(
      'El nombre necesita al menos una letra o un número.',
    );
  }
  return name;
}

export type DocumentTypeNamesValidation =
  { ok: true; names: DocumentTypeNames } | { ok: false; message: string };

/**
 * R16: normaliza los cinco (una clave ausente es null) y rechaza la
 * ambigüedad, comparando por `documentTypeKey` (cualquier escritura): dos
 * tipos con el mismo nombre, o un nombre que es el código o el nombre
 * genérico de OTRO tipo. El genérico del propio tipo vale. Los sinónimos
 * antiguos no se comprueban: la clínica no los ve y en la importación gana
 * su nombre (R19).
 */
export function validateDocumentTypeNames(
  input: Readonly<Partial<Record<DocumentType, string | null>>>,
): DocumentTypeNamesValidation {
  const names = {} as DocumentTypeNames;
  try {
    for (const type of DOCUMENT_TYPES) {
      names[type] = normalizeDocumentTypeName(
        Object.hasOwn(input, type) ? input[type] : null,
      );
    }
  } catch (err) {
    if (err instanceof DocumentTypeNameError) {
      return { ok: false, message: err.message };
    }
    throw err;
  }
  const taken = new Map<string, DocumentType>();
  for (const type of DOCUMENT_TYPES) {
    const name = names[type];
    if (name === null) continue;
    const key = documentTypeKey(name);
    const twin = taken.get(key);
    if (twin) {
      return {
        ok: false,
        message: `“${name}” ya es el nombre de ${DOC_TYPE_LABEL[twin]}. Cada tipo necesita un nombre distinto.`,
      };
    }
    const owner = DOCUMENT_TYPES.find(
      (other) => other !== type && GENERIC_DOC_TYPE_NAMES[other].includes(key),
    );
    if (owner) {
      return {
        ok: false,
        message: `“${name}” es el nombre de ${DOC_TYPE_LABEL[owner]}. Elige otro.`,
      };
    }
    taken.set(key, type);
  }
  return { ok: true, names };
}
