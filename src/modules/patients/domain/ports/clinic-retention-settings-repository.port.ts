import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { StoredRetentionTerm } from '../retention/retention-term-change';

export const CLINIC_RETENTION_SETTINGS_REPOSITORY = Symbol(
  'CLINIC_RETENTION_SETTINGS_REPOSITORY',
);

/** Qué pasó al guardar el plazo; el caso de uso lo traduce a HTTP (DX-330). */
export type RetentionSettingsWrite =
  | { outcome: 'UNCHANGED'; stored: StoredRetentionTerm }
  | {
      outcome: 'CONFIRMATION_REQUIRED';
      previousYears: number;
      newYears: number;
      referenceYears: number;
      protectedPatients: number;
      withinCorrectionWindow: boolean;
    }
  | {
      outcome: 'APPLIED';
      stored: StoredRetentionTerm;
      protectedPatients: number;
    }
  | { outcome: 'BUSY'; reason: 'CONTENTION' | 'TIMEOUT' };

/** Plazo de conservación de la HC de la clínica del contexto (DX-330). */
export interface ClinicRetentionSettingsRepository {
  /** El plazo guardado y su ventana de corrección, tal como están en `tenants`. */
  get(): Promise<StoredRetentionTerm>;
  /**
   * Cambia el plazo en una sola transacción con la fila de la clínica
   * bloqueada: suelos de una reducción confirmada, plazo, ventana y evento de
   * auditoría, o nada. `now` es el reloj de la API, también para la ventana.
   */
  set(
    input: { clinicalRecordRetentionYears: number; confirmReduction: boolean },
    ctx: AuditRequestContext,
    now: Date,
  ): Promise<RetentionSettingsWrite>;
}
