import type { PrescriptionSettings } from '../prescription-settings';

export const PRESCRIPTION_SETTINGS_REPOSITORY = Symbol(
  'PRESCRIPTION_SETTINGS_REPOSITORY',
);

/** Ajustes de la receta de la clínica del contexto (DX-324). */
export interface PrescriptionSettingsRepository {
  /** Los tres `tenants.prescription*` de la clínica del contexto. */
  get(): Promise<PrescriptionSettings>;
  /**
   * Escribe los tres ajustes y devuelve los de antes y los de después, leídos
   * y escritos en la MISMA transacción con la fila de la clínica bloqueada:
   * dos ADMIN a la vez no dejan un «antes» que no fue real.
   */
  set(
    next: PrescriptionSettings,
  ): Promise<{ before: PrescriptionSettings; after: PrescriptionSettings }>;
}
