import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { StoredSlotOfferSettings } from '../slot-offer-link';

export const SLOT_OFFER_SETTINGS_REPOSITORY = Symbol(
  'SLOT_OFFER_SETTINGS_REPOSITORY',
);

/** Ajustes de la oferta por enlace de la clínica del contexto (DX-448). */
export interface SlotOfferSettingsRepository {
  /** `tenants.slotOffer*` de la clínica del contexto, tal como se guardan. */
  get(): Promise<StoredSlotOfferSettings>;
  /**
   * Escribe los ajustes y devuelve el antes y el después, leídos y escritos
   * en la MISMA transacción con la fila de la clínica bloqueada, junto con el
   * evento de auditoría si algo cambió (patrón de DX-360).
   */
  set(
    next: StoredSlotOfferSettings,
    ctx: AuditRequestContext,
  ): Promise<{
    before: StoredSlotOfferSettings;
    after: StoredSlotOfferSettings;
  }>;
}
