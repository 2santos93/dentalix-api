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
 * 2. Ficheros de importación de otro software: la celda «Tipo de documento»
 *    puede traer un nombre de uso en muchos países (`IMPORT_DOC_TYPE_ALIASES`);
 *    se reconoce y se guarda como el tipo genérico, sin etiqueta.
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
 * Nombres de uso en muchos países para la celda «Tipo de documento» de un
 * fichero de importación de otro software, ya como claves normalizadas
 * (`documentTypeKey`). Se comprueban después de los nombres de la clínica y
 * de los genéricos (`GENERIC_DOC_TYPE_NAMES`). Spec de DX-327, Q3.
 *
 * Solo nombres de uso en muchos países (cada línea de la lista la fija la
 * guarda `no-location-fallbacks.spec.ts`). Las siglas y los nombres de un solo
 * país no se reconocen: un fichero con ellos da
 * «Tipo de documento no reconocido» y la clínica lo resuelve con el nombre
 * local de su documento (Ajustes › Tipos de documento).
 */
export const IMPORT_DOC_TYPE_ALIASES: ReadonlyArray<
  [DocumentType, readonly string[]]
> = [
  ['NATIONAL_ID', ['cedula']],
  ['OTHER', ['dni']],
];

/**
 * Cabeceras de la columna del NÚMERO de documento en ficheros de otro
 * software (pre-flight I5), ya como claves normalizadas. `import-fields.ts`
 * las añade a sus sinónimos; no son tipos (la tercera no es un valor de tipo).
 */
export const IMPORT_DOC_NUMBER_HEADER_ALIASES: readonly string[] = [
  'cedula',
  'dni',
  'rut',
];
