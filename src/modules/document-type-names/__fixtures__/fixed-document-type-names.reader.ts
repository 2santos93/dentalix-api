import {
  DocumentTypeNamesReader,
  type DocumentTypeNamesBook,
} from '../../patients/domain/ports/document-type-names-repository.port';
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

  /** DX-524: nombres propios de cada sede (id → nombres), sobre los fijos. */
  byLocation = new Map<string, Partial<DocumentTypeNames>>();
  /** Sede activa que simula el contexto (lo que lee `get()` sin argumento). */
  activeLocationId: string | undefined;
  /** Las sedes que pidió cada lectura, en orden (`undefined` = la activa). */
  requested: (string | null | undefined)[] = [];

  private resolve(locationId: string | null | undefined): DocumentTypeNames {
    const own = locationId ? this.byLocation.get(locationId) : undefined;
    const names = { ...this.names };
    for (const [type, name] of Object.entries(own ?? {})) {
      if (name) names[type as keyof DocumentTypeNames] = name;
    }
    return names;
  }

  get(locationId?: string | null): Promise<DocumentTypeNames> {
    this.reads += 1;
    this.requested.push(locationId);
    return Promise.resolve(
      this.resolve(
        locationId === undefined ? this.activeLocationId : locationId,
      ),
    );
  }

  book(): Promise<DocumentTypeNamesBook> {
    this.reads += 1;
    return Promise.resolve({
      clinic: { ...this.names },
      forLocation: (id) => this.resolve(id),
    });
  }
}
