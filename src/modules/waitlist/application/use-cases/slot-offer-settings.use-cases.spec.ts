import { BadRequestException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
  SLOT_OFFER_MIN_LEAD_MESSAGE,
} from '../../domain/slot-offer-link';
import {
  InMemorySlotOfferSettingsRepository,
  inMemorySlotOfferSettings,
} from '../__fixtures__/in-memory-slot-offer-settings';
import { UpdateSlotOfferSettingsUseCase } from './slot-offer-settings.use-cases';

describe('Ajustes de la oferta de hueco por enlace (DX-448)', () => {
  let repo: InMemorySlotOfferSettingsRepository;
  let update: UpdateSlotOfferSettingsUseCase;
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: 'loc-1',
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };

  beforeEach(() => {
    repo = new InMemorySlotOfferSettingsRepository();
    update = new UpdateSlotOfferSettingsUseCase(
      repo,
      inMemorySlotOfferSettings(repo, { expiryLeadMinutes: 30 }),
    );
  });

  it('sin elegir: la caducidad de la instalación y 20 minutos de antelación, con los valores por defecto', async () => {
    const get = inMemorySlotOfferSettings(repo, { expiryLeadMinutes: 30 });
    await expect(get.execute()).resolves.toEqual({
      expiryLeadMinutes: 30,
      minLeadMinutes: 20,
      defaultExpiryLeadMinutes: 30,
      defaultMinLeadMinutes: 20,
    });
  });

  it('guarda lo elegido y lo devuelve resuelto; la lectura ya no usa la instalación', async () => {
    await expect(
      update.execute({ expiryLeadMinutes: 0, minLeadMinutes: 45 }, ctx),
    ).resolves.toEqual({
      expiryLeadMinutes: 0,
      minLeadMinutes: 45,
      defaultExpiryLeadMinutes: 30,
      defaultMinLeadMinutes: 20,
    });
    expect(repo.stored).toEqual({ expiryLeadMinutes: 0, minLeadMinutes: 45 });
    expect(repo.writes[0].ctx).toBe(ctx);
    const get = inMemorySlotOfferSettings(repo, { expiryLeadMinutes: 30 });
    await expect(get.effective()).resolves.toEqual({
      expiryLeadMinutes: 0,
      minLeadMinutes: 45,
    });
  });

  it.each([
    [
      { expiryLeadMinutes: -1, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [
      { expiryLeadMinutes: 241, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [
      { expiryLeadMinutes: 1.5, minLeadMinutes: 20 },
      SLOT_OFFER_EXPIRY_LEAD_MESSAGE,
    ],
    [{ expiryLeadMinutes: 60, minLeadMinutes: 4 }, SLOT_OFFER_MIN_LEAD_MESSAGE],
    [
      { expiryLeadMinutes: 60, minLeadMinutes: 241 },
      SLOT_OFFER_MIN_LEAD_MESSAGE,
    ],
  ])(
    'fuera de rango (%j): 400 en español y nada se escribe',
    async (input, message) => {
      await expect(update.execute(input, ctx)).rejects.toThrow(
        new BadRequestException(message),
      );
      expect(repo.writes).toHaveLength(0);
    },
  );
});
