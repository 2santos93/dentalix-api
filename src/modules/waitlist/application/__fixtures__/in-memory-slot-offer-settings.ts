import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { SlotOfferSettingsRepository } from '../../domain/ports/slot-offer-settings-repository.port';
import type {
  LinkOfferConfig,
  StoredSlotOfferSettings,
} from '../../domain/slot-offer-link';
import { GetSlotOfferSettingsUseCase } from '../use-cases/slot-offer-settings.use-cases';

/** `tenants.slotOffer*` de una clínica, en memoria (DX-448). */
export class InMemorySlotOfferSettingsRepository implements SlotOfferSettingsRepository {
  stored: StoredSlotOfferSettings = {
    expiryLeadMinutes: null,
    minLeadMinutes: 20,
  };
  readonly writes: {
    before: StoredSlotOfferSettings;
    after: StoredSlotOfferSettings;
    ctx: AuditRequestContext;
  }[] = [];

  get(): Promise<StoredSlotOfferSettings> {
    return Promise.resolve({ ...this.stored });
  }

  set(
    next: StoredSlotOfferSettings,
    ctx: AuditRequestContext,
  ): Promise<{
    before: StoredSlotOfferSettings;
    after: StoredSlotOfferSettings;
  }> {
    const before = { ...this.stored };
    this.stored = { ...next };
    const write = { before, after: { ...next }, ctx };
    this.writes.push(write);
    return Promise.resolve({ before, after: write.after });
  }
}

/** El caso de uso de lectura sobre un repositorio en memoria. */
export function inMemorySlotOfferSettings(
  repo: InMemorySlotOfferSettingsRepository = new InMemorySlotOfferSettingsRepository(),
  installation: LinkOfferConfig = { expiryLeadMinutes: 0 },
): GetSlotOfferSettingsUseCase {
  return new GetSlotOfferSettingsUseCase(repo, installation);
}
