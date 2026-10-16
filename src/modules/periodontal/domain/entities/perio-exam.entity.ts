import type { PerioExamStatus, PerioSite } from '@prisma/client';

/**
 * Medida de un sitio. Las flags se exponen como booleanos (en la base van en
 * un bitmask, ver `encodeFlags`). `recessionMm` positivo = recesión (margen
 * apical a la UAC); negativo = margen coronal a la UAC.
 */
export interface PerioSiteMeasure {
  toothFdi: number;
  site: PerioSite;
  probingMm: number | null;
  recessionMm: number | null;
  furcation: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  calculus: boolean;
}

/** Igual que la medida, con el NIC (CAL) calculado: sondaje + recesión. */
export interface PerioSiteMeasureWithCal extends PerioSiteMeasure {
  calMm: number | null;
}

export interface PerioToothMeasure {
  toothFdi: number;
  mobility: number | null;
  skipped: boolean;
}

export interface PerioIndices {
  /** Sitios con algún dato, sin contar dientes omitidos. */
  sitesExamined: number;
  /** % de sitios examinados con sangrado al sondaje (1 decimal). */
  bopPercent: number;
  /** % de sitios examinados con placa (1 decimal). */
  plaquePercent: number;
  sites4mmOrMore: number;
  sites6mmOrMore: number;
}

export interface PerioExamHeader {
  id: string;
  tenantId: string;
  patientId: string;
  providerId: string;
  providerName: string;
  /** Fecha clínica del examen, `YYYY-MM-DD`. */
  examDate: string;
  notes: string | null;
  status: PerioExamStatus;
  finalizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Examen con sus medidas crudas (lo que devuelve el repositorio). */
export interface PerioExamRecord extends PerioExamHeader {
  sites: PerioSiteMeasure[];
  teeth: PerioToothMeasure[];
}

/** Fila del histórico. */
export interface PerioExamSummary extends PerioExamHeader {
  indices: PerioIndices;
}

/** Detalle: medidas con NIC calculado + índices. */
export interface PerioExamDetail extends PerioExamHeader {
  sites: PerioSiteMeasureWithCal[];
  teeth: PerioToothMeasure[];
  indices: PerioIndices;
}
