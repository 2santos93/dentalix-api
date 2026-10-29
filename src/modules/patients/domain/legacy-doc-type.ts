// Excepción G5.3 (DX-334): tipos de documento anteriores a DX-327.
import type { DocType as LegacyDocType, DocumentType } from '@prisma/client';
import { DOCUMENT_TYPES, isDocumentType } from './document-type';

/**
 * DX-327 (fase 1): traducción única de los códigos anteriores (columna
 * "docType", JSON guardado y cuerpos de la web anterior) a los tipos
 * genéricos (spec R3). Solo tipos: ningún código da etiqueta ni nombre; el
 * nombre visible sale siempre de `documentTypeName` (R17). La misma tabla en
 * SQL son `dx_doc_type_from_legacy` y `dx_doc_type_to_legacy` (migración
 * 20261030120000), y un test int comprueba que coinciden.
 */
export type { LegacyDocType };

/** R3: código anterior → tipo genérico. La única tabla; la inversa sale de aquí. */
export const LEGACY_DOC_TYPES: Readonly<Record<LegacyDocType, DocumentType>> = {
  CC: 'NATIONAL_ID',
  TI: 'NATIONAL_ID',
  CE: 'RESIDENCE_PERMIT',
  PASSPORT: 'PASSPORT',
  OTHER: 'OTHER',
};

/** Los cinco códigos anteriores, en el orden del enum `DocType`. */
export const LEGACY_CODES = Object.keys(
  LEGACY_DOC_TYPES,
) as readonly LegacyDocType[];

/**
 * R5: código anterior que se guarda junto al genérico, sacado de la tabla:
 * el primer código que da ese tipo. TAX_ID no tiene ninguno y va a OTHER.
 */
const LEGACY_PROJECTION = Object.fromEntries(
  DOCUMENT_TYPES.map((type) => [
    type,
    LEGACY_CODES.find((code) => LEGACY_DOC_TYPES[code] === type) ?? 'OTHER',
  ]),
) as Readonly<Record<DocumentType, LegacyDocType>>;

/**
 * R6: código anterior o genérico guardado en JSON → tipo genérico; null si no
 * se reconoce. Solo claves propias. Nunca da etiqueta.
 */
export function docTypeFromCode(code: string): DocumentType | null {
  if (isDocumentType(code)) return code;
  if (Object.hasOwn(LEGACY_DOC_TYPES, code)) {
    return LEGACY_DOC_TYPES[code as LegacyDocType];
  }
  return null;
}

/** R6 para lectores de lo guardado: un código desconocido es un fallo de despliegue. */
export function docTypeFromStored(code: string): DocumentType {
  const type = docTypeFromCode(code);
  if (type === null) {
    throw new Error(
      `DX-327: tipo de documento guardado desconocido: ${JSON.stringify(code)}`,
    );
  }
  return type;
}

/** R5: proyección de fase 1 para los INSERT y las fotos JSON. */
export function legacyStoredDocType(type: DocumentType): LegacyDocType {
  return LEGACY_PROJECTION[type];
}

/**
 * R9: tipo de un cuerpo (genérico o anterior) → tipo del dominio. La etiqueta
 * va aparte (`normalizeDocTypeLabel`) y nunca se deriva del código. El DTO ya
 * valida con `@IsIn`: aquí un desconocido es un error de programación.
 */
export function resolveDocTypeInput(type: string): DocumentType {
  const resolved = docTypeFromCode(type);
  if (resolved === null) {
    throw new Error(
      `DX-327: tipo de documento no validado: ${JSON.stringify(type)}`,
    );
  }
  return resolved;
}

/**
 * Sinónimos anteriores de la importación (`row-validation.ts`), ya como
 * claves normalizadas: clave → código anterior, que se traduce a su genérico
 * sin etiqueta (Q3).
 */
export const LEGACY_DOC_TYPE_SYNONYMS: ReadonlyArray<
  [LegacyDocType, readonly string[]]
> = [
  [
    'CC',
    [
      'cc',
      'cedula',
      'ceduladeciudadania',
      'cedulaciudadania',
      'cedulaciudadana',
    ],
  ],
  ['TI', ['ti', 'tarjetadeidentidad', 'tarjetaidentidad']],
  ['CE', ['ce', 'cedulaextranjeria', 'ceduladeextranjeria', 'extranjeria']],
  ['PASSPORT', ['pa', 'pas', 'pp', 'pasaporte', 'passport']],
  [
    'OTHER',
    [
      'otro',
      'other',
      'rc',
      'registrocivil',
      'nuip',
      'pep',
      'ppt',
      'dni',
      'nit',
      'cv',
      'ms',
      'as',
    ],
  ],
];
