import type { AnesthesiaTechnique } from '@prisma/client';
import type { DoseAlert } from './anesthesia-dose';

/** Anestésico del catálogo de la clínica (DX-307): datos editables. */
export interface AnestheticProduct {
  id: string;
  name: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  mlPerCarpule: number;
  maxMgPerKg: number;
  maxAbsoluteMg: number;
  /** Clave del ejemplo del que salió; null si lo creó la clínica. */
  sampleCode: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type WeightSource = 'ANAMNESIS' | 'ENTERED';

/**
 * Anestesia local registrada en una evolución (DX-307). INALTERABLE como la
 * evolución (DX-038): no hay método para editarla ni borrarla y la BD lo
 * impide; se corrige con una adenda de la evolución.
 */
export interface AnesthesiaAdministration {
  id: string;
  patientId: string;
  clinicalEntryId: string;
  locationId: string | null;
  anestheticId: string;
  /** Copia de los valores del catálogo en el momento de la administración. */
  anestheticName: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  mlPerCarpule: number;
  maxMgPerKg: number;
  maxAbsoluteMg: number;
  carpules: number;
  doseMg: number;
  technique: AnesthesiaTechnique;
  /** Zona o dientes FDI, texto corto. */
  site: string | null;
  lot: string | null;
  administeredAt: Date;
  weightKg: number | null;
  weightSource: WeightSource | null;
  /**
   * mg y % acumulados CON este registro: de la evolución en V1 (DX-307); del
   * paciente en la ventana de 24 h en V2 (DX-418). Ver `safetyRulesVersion`.
   */
  cumulativeMg: number;
  cumulativePercent: number | null;
  safetyRulesVersion: string;
  safetyAlerts: DoseAlert[];
  /** Motivo con el que se confirmó un aviso bloqueante; null si no hubo. */
  overrideReason: string | null;
  authorId: string;
  createdAt: Date;
}
