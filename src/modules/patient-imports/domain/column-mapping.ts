import { DocType } from '@prisma/client';
import {
  IMPORT_FIELDS,
  fieldLabel,
  headerKey,
  type ImportFieldKey,
} from './import-fields';
import { ImportFileError } from './tabular-file';

/** Campo de Dentalix → cabecera del fichero que lo trae. */
export type ColumnMapping = Partial<Record<ImportFieldKey, string>>;

export interface MappingInput {
  columns: ColumnMapping;
  /** Tipo de documento cuando la columna no está o la celda va vacía. */
  defaultDocType?: DocType;
}

export interface ResolvedMapping {
  /** Campo → índice de la columna en el fichero. */
  indexes: Partial<Record<ImportFieldKey, number>>;
  /** Campo → cabecera (para el informe: la columna «como la ve» la persona). */
  headers: Partial<Record<ImportFieldKey, string>>;
  defaultDocType: DocType | null;
}

/**
 * Mapeo sugerido: cada cabecera reconocida por sus sinónimos va a su campo
 * (la primera que case gana; una cabecera nunca a dos campos).
 */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const out: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of IMPORT_FIELDS) {
    const synonyms: readonly string[] = field.synonyms;
    const index = headers.findIndex(
      (h, i) => !used.has(i) && h !== '' && synonyms.includes(headerKey(h)),
    );
    if (index >= 0) {
      out[field.key] = headers[index];
      used.add(index);
    }
  }
  return out;
}

/**
 * Comprueba el mapeo contra las cabeceras del fichero: cada cabecera existe y
 * va a un solo campo, y están los obligatorios (nombres, apellidos, número de
 * documento; el tipo, o por columna o por defecto).
 */
export function resolveMapping(
  headers: readonly string[],
  input: MappingInput,
): ResolvedMapping {
  const indexes: ResolvedMapping['indexes'] = {};
  const chosen: ResolvedMapping['headers'] = {};
  const usedBy = new Map<number, ImportFieldKey>();
  for (const field of IMPORT_FIELDS) {
    const header = input.columns[field.key]?.trim();
    if (!header) continue;
    const index = headers.findIndex(
      (h) => h.toLowerCase() === header.toLowerCase(),
    );
    if (index < 0) {
      throw new ImportFileError(
        `La columna «${header}» elegida para «${field.label}» no está en el archivo.`,
      );
    }
    const other = usedBy.get(index);
    if (other) {
      throw new ImportFileError(
        `La columna «${header}» está elegida para «${fieldLabel(other)}» y para «${field.label}»: elige una sola.`,
      );
    }
    usedBy.set(index, field.key);
    indexes[field.key] = index;
    chosen[field.key] = headers[index];
  }
  const missing = IMPORT_FIELDS.filter(
    (f) => f.required && indexes[f.key] === undefined,
  ).map((f) => `«${f.label}»`);
  if (indexes.docType === undefined && !input.defaultDocType) {
    missing.push('«Tipo de documento» (o un tipo por defecto)');
  }
  if (missing.length > 0) {
    throw new ImportFileError(
      `Falta elegir la columna de ${missing.join(', ')}.`,
    );
  }
  return {
    indexes,
    headers: chosen,
    defaultDocType: input.defaultDocType ?? null,
  };
}
