import type { DocumentTypeNames } from '../document-type-names';

export const DOCUMENT_TYPE_NAMES_REPOSITORY = Symbol(
  'DOCUMENT_TYPE_NAMES_REPOSITORY',
);

/**
 * DX-327 (R16, spec §4.10): nombres locales de la clínica del contexto, de
 * solo lectura. Lo inyectan, importando `DocumentTypeNamesModule`, quienes
 * componen el nombre visible (R17). Sin `tx`: no se promete la misma
 * transacción que la lectura del paciente (spec §4.6). Clase abstracta para
 * que sirva de token de Nest.
 */
export abstract class DocumentTypeNamesReader {
  abstract get(): Promise<DocumentTypeNames>;
}

/** Lectura y escritura de los cinco nombres (el caso de uso de Ajustes). */
export interface DocumentTypeNamesRepository extends DocumentTypeNamesReader {
  /**
   * Sustituye los cinco en un solo UPDATE y devuelve los de antes y los de
   * después, leídos y escritos en la MISMA transacción con la fila de la
   * clínica bloqueada: dos ADMIN a la vez no dejan un «antes» que no fue real.
   */
  set(
    names: DocumentTypeNames,
  ): Promise<{ before: DocumentTypeNames; after: DocumentTypeNames }>;
}
