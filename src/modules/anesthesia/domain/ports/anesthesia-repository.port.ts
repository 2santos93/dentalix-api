import type { AnesthesiaTechnique } from '@prisma/client';
import type {
  AnesthesiaAdministration,
  AnestheticProduct,
  WeightSource,
} from '../entities';
import type { AnesthesiaAnamnesis, DoseAlert } from '../anesthesia-dose';
import type { SampleAnesthetic } from '../sample-anesthetics';

export const ANESTHESIA_REPOSITORY = Symbol('ANESTHESIA_REPOSITORY');

export interface AnestheticProductInput {
  name: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  mlPerCarpule: number;
  maxMgPerKg: number;
  maxAbsoluteMg: number;
}

export type AnestheticProductPatch = Partial<AnestheticProductInput> & {
  active?: boolean;
};

/** La evolución a la que se añade la anestesia (bajo RLS). */
export interface AnesthesiaEntryRef {
  id: string;
  /** Sede de la atención (null en evoluciones legacy). */
  locationId: string | null;
  /** Zona IANA de esa sede: decide la edad del paciente «hoy». */
  timeZone: string | null;
  /**
   * DX-407: peso medido hoy en la valoración de la hoja de sedación de ESTA
   * evolución (null si no tiene hoja o no se pesó). Es del sillón, del día:
   * manda sobre la anamnesis, que puede ser antigua.
   */
  sedationWeightKg?: number | null;
}

/** Lo que el cálculo lee del paciente: nacimiento y anamnesis VIGENTE. */
export interface AnesthesiaPatientContext {
  birthDate: Date | null;
  anamnesis: (AnesthesiaAnamnesis & { weightKg: number | null }) | null;
}

/** Fila nueva; tenant, id y `createdAt` los ponen el repositorio y la BD. */
export interface NewAnesthesiaAdministration {
  patientId: string;
  clinicalEntryId: string;
  locationId: string | null;
  anesthetic: AnestheticProduct;
  carpules: number;
  doseMg: number;
  technique: AnesthesiaTechnique;
  site: string | null;
  lot: string | null;
  administeredAt: Date;
  weightKg: number | null;
  weightSource: WeightSource | null;
  cumulativeMg: number;
  cumulativePercent: number | null;
  safetyRulesVersion: string;
  safetyAlerts: DoseAlert[];
  overrideReason: string | null;
  authorId: string;
}

export interface AnesthesiaRepository {
  listProducts(includeInactive: boolean): Promise<AnestheticProduct[]>;
  findProduct(id: string): Promise<AnestheticProduct | null>;
  /** `DUPLICATE_NAME` si la clínica ya tiene uno con ese nombre. */
  createProduct(
    input: AnestheticProductInput & { sampleCode?: string },
    userId: string,
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME'>;
  updateProduct(
    id: string,
    patch: AnestheticProductPatch,
    userId: string,
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME' | null>;
  /** Crea los ejemplos cuyo `sampleCode` y nombre aún no tiene la clínica. */
  createMissingSamples(
    samples: readonly SampleAnesthetic[],
    userId: string,
  ): Promise<AnestheticProduct[]>;

  /** null si el paciente no es de esta clínica (o no existe). */
  loadPatientContext(
    patientId: string,
  ): Promise<AnesthesiaPatientContext | null>;
  /** Evolución viva de ESTE paciente en esta clínica, o null. */
  findEntry(
    patientId: string,
    entryId: string,
  ): Promise<AnesthesiaEntryRef | null>;
  /** En orden de administración. */
  listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<AnesthesiaAdministration[]>;
  listByPatient(patientId: string): Promise<AnesthesiaAdministration[]>;
  /**
   * Append-only. Bloquea la evolución (FOR UPDATE) para que dos registros
   * simultáneos no pasen los dos por debajo del máximo, lee lo ya registrado
   * y llama a `build`, que decide (o lanza) con ese acumulado; inserta lo que
   * devuelva, en la MISMA transacción.
   */
  record(
    patientId: string,
    entryId: string,
    build: (
      prior: AnesthesiaAdministration[],
    ) => NewAnesthesiaAdministration | Promise<NewAnesthesiaAdministration>,
  ): Promise<AnesthesiaAdministration>;
}
