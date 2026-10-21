import type { AnamnesisSnapshot } from '../medical-alert-flags';

/** Una confirmación «Sin cambios hoy» guardada (DX-247). */
export interface AnamnesisConfirmation {
  id: string;
  patientId: string;
  medicalHistoryVersionId: string;
  reviewedById: string;
  reviewedByName: string | null;
  locationId: string | null;
  reviewedAt: Date;
}

/** La versión vigente y la última confirmación de un paciente. */
export interface AnamnesisReviewState {
  snapshot: AnamnesisSnapshot;
  lastConfirmedAt: Date | null;
}

/** Quién revisó por última vez la anamnesis de un paciente, para la ficha. */
export interface AnamnesisLastReview {
  /** UPDATED: se guardó una versión; NO_CHANGES: «Sin cambios hoy». */
  kind: 'UPDATED' | 'NO_CHANGES';
  at: Date;
  byName: string | null;
}

export const MEDICAL_ALERTS_REPOSITORY = Symbol('MEDICAL_ALERTS_REPOSITORY');

/**
 * Lecturas por lote de la anamnesis REDUCIDA a banderas (DX-247) y escritura
 * de la confirmación «Sin cambios hoy». Todo bajo RLS (la clínica del
 * contexto); ningún método devuelve texto clínico.
 */
export interface MedicalAlertsRepository {
  /**
   * Versión vigente y última confirmación de cada paciente con anamnesis, en
   * UNA consulta sin importar cuántos ids lleguen. Los que no tienen (o son de
   * otra clínica) no salen en el mapa.
   */
  reviewStates(
    patientIds: readonly string[],
  ): Promise<Map<string, AnamnesisReviewState>>;

  /** `tenants.anamnesisValidityMonths` de la clínica del contexto. */
  getValidityMonths(): Promise<number>;
  /**
   * Cambia la vigencia y devuelve la de antes y la de después, leídas y
   * escritas en la MISMA transacción con la fila de la clínica bloqueada: dos
   * ADMIN a la vez no dejan un «antes» que no fue real.
   */
  setValidityMonths(months: number): Promise<{ before: number; after: number }>;

  /** Quién y cuándo revisó por última vez (versión o confirmación). */
  lastReview(patientId: string): Promise<AnamnesisLastReview | null>;

  /**
   * Guarda la confirmación sobre la versión VIGENTE, en la sede del request (o
   * ninguna, en la vista consolidada). Lee la versión y escribe en la misma
   * transacción, bajo el candado por paciente que también toma el alta de una
   * versión: no se confirma «sin cambios» una versión que otra persona está
   * reemplazando. `null` si el paciente no tiene anamnesis.
   */
  createConfirmation(input: {
    patientId: string;
    reviewedById: string;
  }): Promise<AnamnesisConfirmation | null>;
}
