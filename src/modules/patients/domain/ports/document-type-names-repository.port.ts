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
  /**
   * DX-524: los nombres que rigen en una sede (los de la sede sobre los de la
   * clínica, por tipo). `undefined` = la sede activa de la petición (sin ella,
   * la clínica); `null` = solo los de la clínica; un id = esa sede. Los
   * documentos pasan SU sede; las pantallas, nada.
   */
  abstract get(locationId?: string | null): Promise<DocumentTypeNames>;

  /**
   * DX-524: los de la clínica y los de todas sus sedes en una lectura, para
   * resolver después y de forma síncrona los de la sede de un documento
   * (p. ej. dentro de la transacción de aceptar un presupuesto).
   */
  abstract book(): Promise<DocumentTypeNamesBook>;
}

export interface DocumentTypeNamesBook {
  /** Solo los de la clínica. */
  readonly clinic: DocumentTypeNames;
  /** Los de esa sede sobre los de la clínica; sede sin nombres o `null`: la clínica. */
  forLocation(locationId: string | null | undefined): DocumentTypeNames;
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
