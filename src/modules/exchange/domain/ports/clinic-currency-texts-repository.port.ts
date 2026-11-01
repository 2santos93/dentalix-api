import type { CurrencyTexts } from '../../../../shared/format/currency-text';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const CLINIC_CURRENCY_TEXTS_REPOSITORY = Symbol(
  'CLINIC_CURRENCY_TEXTS_REPOSITORY',
);

/** DX-517: el mapa de textos de moneda de la clínica del contexto. */
export interface ClinicCurrencyTextsRepository {
  get(): Promise<CurrencyTexts>;
  /** Guarda el mapa entero y lo audita (antes y después) en la misma transacción. */
  set(next: CurrencyTexts, ctx: AuditRequestContext): Promise<CurrencyTexts>;
}
