import type { PerioSiteCounts } from '../perio-measures';
import type {
  PerioExamHeader,
  PerioExamRecord,
  PerioSiteMeasure,
  PerioToothMeasure,
} from '../entities/perio-exam.entity';

export const PERIO_EXAM_REPOSITORY = Symbol('PERIO_EXAM_REPOSITORY');

export interface CreatePerioExamRepoInput {
  patientId: string;
  providerId: string;
  /** `YYYY-MM-DD`. */
  examDate: string;
  notes: string | null;
  /** Dientes que nacen marcados como omitidos (copiados del examen anterior). */
  skippedTeeth: number[];
}

export interface SavePerioMeasuresRepoInput {
  /** Sitios a escribir; uno vacío limpia la celda (la fila queda vacía). */
  sites: PerioSiteMeasure[];
  /** Dientes a escribir; uno vacío limpia el diente. */
  teeth: PerioToothMeasure[];
  /** `undefined` = no tocar las notas. */
  notes?: string | null;
}

/**
 * Fila del histórico (DX-103): cabecera y los conteos de los que salen los
 * índices, calculados en la base. Sin medidas.
 */
export interface PerioExamSummaryRow extends PerioExamHeader {
  counts: PerioSiteCounts;
}

/**
 * Resultado de una escritura sobre un examen existente: `final` si ya estaba
 * finalizado (inmutable), `not_found` si no existe, es de otro paciente o de
 * otra clínica (RLS).
 */
export type PerioWriteResult = 'ok' | 'not_found' | 'final';

export interface PerioExamRepository {
  /**
   * Zona IANA de la sede activa (su horario); sin sede o sin horario, la zona
   * por defecto. Fija qué día es «hoy» para la fecha del examen.
   */
  clinicTimeZone(): Promise<string>;
  /**
   * Del paciente, por fecha de examen descendente: como mucho `limit`
   * exámenes, con los conteos de sus índices y SIN las medidas.
   */
  listSummaries(
    patientId: string,
    limit: number,
  ): Promise<PerioExamSummaryRow[]>;
  findById(patientId: string, id: string): Promise<PerioExamRecord | null>;
  /** El examen más reciente (por fecha) del paciente, o `null`. */
  findLatest(patientId: string): Promise<PerioExamRecord | null>;
  create(input: CreatePerioExamRepoInput): Promise<PerioExamRecord>;
  /** Solo si el examen sigue en DRAFT (comprobado en la misma transacción). */
  saveMeasures(
    patientId: string,
    id: string,
    input: SavePerioMeasuresRepoInput,
  ): Promise<PerioWriteResult>;
  finalize(patientId: string, id: string, at: Date): Promise<PerioWriteResult>;
  /** Borrado blando de un DRAFT. */
  deleteDraft(patientId: string, id: string): Promise<PerioWriteResult>;
}
