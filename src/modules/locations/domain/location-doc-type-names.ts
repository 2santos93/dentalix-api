import type { DocumentType } from '@prisma/client';
import { DOCUMENT_TYPES } from '../../patients/domain/document-type';
import {
  DOC_TYPE_NAME_FIELD,
  normalizeDocumentTypeName,
  validateDocumentTypeNames,
  type DocumentTypeNames,
} from '../../patients/domain/document-type-names';

/**
 * DX-524: nombres propios de la sede para los tipos de documento. Mismas
 * reglas que los de la clínica (DX-327, R16): 1..60 caracteres sin controles,
 * distintos entre sí y sin ser el genérico de otro tipo. La sede puede dejar
 * cualquiera sin nombre (null): hereda el de la clínica.
 */
export type LocationDocTypeNamesInput = Readonly<
  Partial<Record<DocumentType, string | null>>
>;

export type LocationDocTypeNamesResult =
  | { ok: true; patch: Partial<DocumentTypeNames> }
  | { ok: false; message: string };

/**
 * `input` trae solo los tipos que cambian (clave ausente = no se toca; null o
 * vacío = vuelve a heredar). Se valida el conjunto resultante junto a los que
 * ya tenía la sede, y se devuelve únicamente lo enviado, normalizado.
 */
export function resolveLocationDocTypeNames(
  input: LocationDocTypeNamesInput,
  current: DocumentTypeNames,
): LocationDocTypeNamesResult {
  const patch: Partial<DocumentTypeNames> = {};
  const merged: Record<DocumentType, string | null> = { ...current };
  for (const type of DOCUMENT_TYPES) {
    // Un `undefined` (el DTO declara las cinco claves) es «no se toca».
    if (!Object.hasOwn(input, type) || input[type] === undefined) continue;
    const checked = validateDocumentTypeNames({ [type]: input[type] });
    if (!checked.ok) return checked;
    const name = normalizeDocumentTypeName(input[type]);
    patch[type] = name;
    merged[type] = name;
  }
  const all = validateDocumentTypeNames(merged);
  return all.ok ? { ok: true, patch } : all;
}

/** Antes y después de la auditoría (DX-360): solo las columnas que cambiaron. */
export interface LocationDocTypeNamesChange {
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

export function locationDocTypeNamesChange(
  before: DocumentTypeNames,
  after: DocumentTypeNames,
): LocationDocTypeNamesChange | null {
  const changed = DOCUMENT_TYPES.filter((type) => before[type] !== after[type]);
  if (changed.length === 0) return null;
  const side = (names: DocumentTypeNames) =>
    Object.fromEntries(changed.map((t) => [DOC_TYPE_NAME_FIELD[t], names[t]]));
  return { before: side(before), after: side(after) };
}
