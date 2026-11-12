import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  SLOT_OFFER_SETTINGS_REPOSITORY,
  type SlotOfferSettingsRepository,
} from '../../domain/ports/slot-offer-settings-repository.port';
import {
  LINK_OFFER_CONFIG,
  LINK_OFFER_MIN_LEAD_MINUTES,
  SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
  SLOT_OFFER_MIN_LEAD_MESSAGE,
  effectiveSlotOfferSettings,
  isValidSlotOfferExpiryLead,
  isValidSlotOfferMinLead,
  type LinkOfferConfig,
  type SlotOfferSettings,
} from '../../domain/slot-offer-link';

/** Lo que devuelve GET/PUT /slot-offer-settings. */
export interface SlotOfferSettingsView extends SlotOfferSettings {
  /** La caducidad de la instalación: la que rige si la clínica no eligió. */
  defaultExpiryLeadMinutes: number;
  /** La antelación mínima de plataforma (20). */
  defaultMinLeadMinutes: number;
}

/**
 * Los ajustes de la oferta por enlace de la clínica, ya resueltos (DX-448).
 * Lo usan la ruta de Ajustes y los casos de uso que crean ofertas y listan
 * candidatos: una sola regla.
 */
@Injectable()
export class GetSlotOfferSettingsUseCase {
  constructor(
    @Inject(SLOT_OFFER_SETTINGS_REPOSITORY)
    private readonly repo: SlotOfferSettingsRepository,
    @Inject(LINK_OFFER_CONFIG)
    private readonly installation: LinkOfferConfig,
  ) {}

  async effective(): Promise<SlotOfferSettings> {
    return effectiveSlotOfferSettings(await this.repo.get(), this.installation);
  }

  async execute(): Promise<SlotOfferSettingsView> {
    return this.view(await this.effective());
  }

  view(settings: SlotOfferSettings): SlotOfferSettingsView {
    return {
      ...settings,
      defaultExpiryLeadMinutes: this.installation.expiryLeadMinutes,
      defaultMinLeadMinutes: LINK_OFFER_MIN_LEAD_MINUTES,
    };
  }
}

/**
 * Cambia la caducidad anticipada de la oferta y la antelación mínima para
 * ofrecer por enlace (DX-448; solo ADMIN, lo exige la ruta). El repositorio
 * audita en la transacción, solo si algo cambió. Aplica a las ofertas que se
 * envíen después: las enviadas guardan su `expiresAt`.
 */
@Injectable()
export class UpdateSlotOfferSettingsUseCase {
  constructor(
    @Inject(SLOT_OFFER_SETTINGS_REPOSITORY)
    private readonly repo: SlotOfferSettingsRepository,
    private readonly getSettings: GetSlotOfferSettingsUseCase,
  ) {}

  async execute(
    input: SlotOfferSettings,
    ctx: AuditRequestContext,
  ): Promise<SlotOfferSettingsView> {
    if (!isValidSlotOfferExpiryLead(input.expiryLeadMinutes)) {
      throw new BadRequestException(SLOT_OFFER_EXPIRY_LEAD_MESSAGE);
    }
    if (!isValidSlotOfferMinLead(input.minLeadMinutes)) {
      throw new BadRequestException(SLOT_OFFER_MIN_LEAD_MESSAGE);
    }
    const { after } = await this.repo.set(
      {
        expiryLeadMinutes: input.expiryLeadMinutes,
        minLeadMinutes: input.minLeadMinutes,
      },
      ctx,
    );
    return this.getSettings.view({
      expiryLeadMinutes: after.expiryLeadMinutes ?? input.expiryLeadMinutes,
      minLeadMinutes: after.minLeadMinutes,
    });
  }
}
