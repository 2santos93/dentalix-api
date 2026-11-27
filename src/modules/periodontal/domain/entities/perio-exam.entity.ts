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
  /** Sitios con sondaje ≥ 4 mm (fijo, como en DX-007). */
  sites4mmOrMore: number;
  /** Sitios con sondaje ≥ 6 mm (fijo, como en DX-007). */
  sites6mmOrMore: number;
  /** DX-066: sitios con sondaje ≥ el umbral de alerta de la clínica. */
  sitesAlertOrMore: number;
  /** DX-066: sitios con sondaje ≥ el umbral severo de la clínica. */
  sitesSevereOrMore: number;
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
  /** DX-066: umbrales de la clínica con los que se colorea y se cuenta. */
  thresholds: PerioThresholdsView;
}

/** DX-066: umbrales de sondaje de la clínica (mm). */
export interface PerioThresholdsView {
  pdAlertMm: number;
  pdSevereMm: number;
}

/** DX-066: un examen dentro de la comparación (sin medidas). */
export interface PerioComparisonExam {
  id: string;
  examDate: string;
  providerId: string;
  providerName: string;
  finalizedAt: Date | null;
  indices: PerioIndices;
}

/** Valor de un sitio en un examen de la comparación. */
export interface PerioComparisonValue {
  probingMm: number | null;
  calMm: number | null;
  bleeding: boolean;
  /** El diente estaba omitido (ausente / no sondable) en ese examen. */
  skipped: boolean;
  /** Δ sondaje frente al examen anterior de la selección (null en el 1.º o sin dato). */
  deltaProbingMm: number | null;
  /** Δ NIC frente al examen anterior de la selección. */
  deltaCalMm: number | null;
}

/** Un sitio en todos los exámenes comparados, en el orden de `exams`. */
export interface PerioComparisonSite {
  toothFdi: number;
  site: PerioSite;
  values: PerioComparisonValue[];
  /** Δ sondaje del último examen frente al primero (null sin los dos datos). */
  deltaProbingMm: number | null;
  /** Δ NIC del último frente al primero. */
  deltaCalMm: number | null;
  /** Δ sondaje o Δ NIC (último − primero) ≥ `worseningMm`. */
  worsened: boolean;
  /** Δ sondaje o Δ NIC (último − primero) ≤ −`worseningMm`. */
  improved: boolean;
}

export interface PerioComparison {
  thresholds: PerioThresholdsView;
  /** Umbral de cambio relevante (2 mm). */
  worseningMm: number;
  /** Por fecha de examen ascendente (el más antiguo primero). */
  exams: PerioComparisonExam[];
  sites: PerioComparisonSite[];
}
