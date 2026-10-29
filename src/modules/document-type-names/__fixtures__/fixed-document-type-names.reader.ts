import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import type { DocumentTypeNames } from '../../patients/domain/document-type-names';

/** Una clínica sin ningún nombre local (como empiezan todas, R16). */
export const NO_LOCAL_NAMES: DocumentTypeNames = {
  NATIONAL_ID: null,
  PASSPORT: null,
  RESIDENCE_PERMIT: null,
  TAX_ID: null,
  OTHER: null,
};

/** Lector en memoria para los unit: nombres fijos y cuántas veces se leyó. */
export class FixedDocumentTypeNamesReader extends DocumentTypeNamesReader {
  names: DocumentTypeNames;
  reads = 0;

  constructor(names: Partial<DocumentTypeNames> = {}) {
    super();
    this.names = { ...NO_LOCAL_NAMES, ...names };
  }

  get(): Promise<DocumentTypeNames> {
    this.reads += 1;
    return Promise.resolve({ ...this.names });
  }
}
