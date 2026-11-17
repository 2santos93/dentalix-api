import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { FinancialLockSettings } from '../financial-lock';
import type { FinancialLockOverrideView } from '../financial-lock-settings';

export const FINANCIAL_LOCK_REPOSITORY = Symbol('FINANCIAL_LOCK_REPOSITORY');

export interface FinancialLockRepository {
  /** Los ajustes de la clínica del contexto. */
  get(): Promise<FinancialLockSettings>;
  /** Zona IANA de la sede de la petición (la de escritura); 409 si no tiene una válida. */
  siteTimeZone(): Promise<string>;
  /** Las últimas `limit` excepciones, de la más reciente a la más antigua. */
  listOverrides(limit: number): Promise<FinancialLockOverrideView[]>;
  /**
   * Aplica `next` con la fila de la clínica bloqueada y audita el antes y el
   * después en la misma transacción (sin evento si nada cambia).
   * `prepare` recibe el ajuste actual (bloqueado) y devuelve el nuevo o lanza el 400.
   */
  update(
    prepare: (current: FinancialLockSettings) => FinancialLockSettings,
    ctx: AuditRequestContext,
  ): Promise<FinancialLockSettings>;
}
