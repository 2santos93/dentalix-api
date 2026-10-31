// Excepción G5.3 (DX-334): códigos de documento anteriores a DX-327.
import type { DocumentType } from '@prisma/client';
import { isDocumentType } from './document-type';

/**
 * Única definición en la API de los códigos de documento anteriores a DX-327.
 * Solo se LEEN, nunca se escriben, en dos sitios:
 *
 * 1. JSON guardado antes de la migración 20261110130000: la foto de un recibo
 *    ya emitido (inmutable: no se reescribe) y las filas y el mapeo de una
 *    importación preparada entonces. Las fotos nuevas solo llevan el tipo
 *    genérico.
 * 2. Ficheros de importación de otro software (o de una versión anterior):
 *    la celda «Tipo de documento» puede traer uno de estos códigos o
 *    nombres; se reconocen y se guardan como el tipo genérico, sin etiqueta.
 *
 * La BD ya no tiene ninguno: la columna antigua quedó congelada con nombres
 * genéricos (migración 20261110130000) y nadie la lee.
 */
const STORED_CODES: Readonly<Record<string, DocumentType>> = {
  CC: 'NATIONAL_ID',
  TI: 'NATIONAL_ID',
  CE: 'RESIDENCE_PERMIT',
};

/**
 * Tipo genérico o código anterior guardado en JSON → tipo genérico; null si
 * no se reconoce. Solo claves propias. Nunca da etiqueta.
 */
export function docTypeFromCode(code: string): DocumentType | null {
  if (isDocumentType(code)) return code;
  return Object.hasOwn(STORED_CODES, code) ? STORED_CODES[code] : null;
}

/** Para lectores de lo guardado: un código desconocido es un fallo de despliegue. */
export function docTypeFromStored(code: string): DocumentType {
  const type = docTypeFromCode(code);
  if (type === null) {
    throw new Error(
      `DX-327: tipo de documento guardado desconocido: ${JSON.stringify(code)}`,
    );
  }
  return type;
}

/**
 * Valores de la celda «Tipo de documento» de un fichero de importación que
 * vienen de otro software, ya como claves normalizadas (`documentTypeKey`).
 * Se comprueban después de los nombres de la clínica y de los genéricos
 * (`GENERIC_DOC_TYPE_NAMES`). Spec de DX-327, Q3.
 */
export const IMPORT_DOC_TYPE_ALIASES: ReadonlyArray<
  [DocumentType, readonly string[]]
> = [
  [
    'NATIONAL_ID',
    [
      'cc',
      'cedula',
      'ceduladeciudadania',
      'cedulaciudadania',
      'cedulaciudadana',
      'ti',
      'tarjetadeidentidad',
      'tarjetaidentidad',
    ],
  ],
  [
    'RESIDENCE_PERMIT',
    ['ce', 'cedulaextranjeria', 'ceduladeextranjeria', 'extranjeria'],
  ],
  [
    'OTHER',
    [
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

/**
 * Cabeceras de la columna del NÚMERO de documento en ficheros de otro
 * software (pre-flight I5), ya como claves normalizadas. `import-fields.ts`
 * las añade a sus sinónimos; no son tipos (`rut` no es un valor de tipo).
 */
export const IMPORT_DOC_NUMBER_HEADER_ALIASES: readonly string[] = [
  'cedula',
  'dni',
  'rut',
];
