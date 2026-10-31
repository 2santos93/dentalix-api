import {
  LINK_OFFER_MIN_LEAD_MINUTES,
  SLOT_OFFER_MESSAGES,
  canResolveOffer,
  emailOfferBlock,
  generateSlotOfferToken,
  hashSlotOfferToken,
  isLinkChannel,
  isWellFormedSlotOfferToken,
  linkOfferExpiresAt,
  linkOfferWindowOpen,
  loadLinkOfferConfig,
  publicSlotOfferState,
} from './slot-offer-link';

const MIN = 60_000;
const slotStart = new Date('2026-11-02T15:00:00.000Z');

describe('enlace de la oferta de hueco (DX-435)', () => {
  describe('token', () => {
    it('es aleatorio, con forma de URL y solo se guarda su hash', () => {
      const a = generateSlotOfferToken();
      const b = generateSlotOfferToken();
      expect(a).not.toBe(b);
      expect(isWellFormedSlotOfferToken(a)).toBe(true);
      expect(hashSlotOfferToken(a)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashSlotOfferToken(a)).not.toContain(a);
    });

    it('descarta lo que no puede ser un token sin tocar la BD', () => {
      expect(isWellFormedSlotOfferToken('corto')).toBe(false);
      expect(isWellFormedSlotOfferToken(`${'a'.repeat(42)}/`)).toBe(false);
    });
  });

  describe('ventana de 20 minutos', () => {
    it('no se oferta si faltan menos de 20 minutos para el hueco', () => {
      expect(LINK_OFFER_MIN_LEAD_MINUTES).toBe(20);
      const at = (m: number) => new Date(slotStart.getTime() - m * MIN);
      expect(linkOfferWindowOpen(slotStart, at(21))).toBe(true);
      expect(linkOfferWindowOpen(slotStart, at(20))).toBe(true);
      expect(linkOfferWindowOpen(slotStart, at(19))).toBe(false);
      expect(linkOfferWindowOpen(slotStart, at(-5))).toBe(false);
    });
  });

  describe('caducidad', () => {
    it('por defecto caduca al empezar el hueco', () => {
      expect(linkOfferExpiresAt(slotStart, 0)).toEqual(slotStart);
    });

    it('con antelación configurada, caduca antes', () => {
      expect(linkOfferExpiresAt(slotStart, 60)).toEqual(
        new Date(slotStart.getTime() - 60 * MIN),
      );
    });

    it('lee la antelación del entorno y rechaza valores inválidos', () => {
      expect(loadLinkOfferConfig(() => undefined)).toEqual({
        expiryLeadMinutes: 0,
      });
      expect(
        loadLinkOfferConfig((k) =>
          k === 'WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES' ? '90' : undefined,
        ),
      ).toEqual({ expiryLeadMinutes: 90 });
      expect(() => loadLinkOfferConfig(() => '-1')).toThrow();
      expect(() => loadLinkOfferConfig(() => '2000')).toThrow();
      expect(() => loadLinkOfferConfig(() => 'x')).toThrow();
    });
  });

  describe('estado público de la oferta', () => {
    const now = new Date(slotStart.getTime() - 60 * MIN);
    const pending = {
      outcome: 'PENDING' as const,
      expiresAt: slotStart,
    };

    it('pendiente, vigente y con el hueco libre: abierta', () => {
      expect(publicSlotOfferState(pending, now, false)).toBe('OPEN');
    });

    it('pasado expiresAt: caducada (aunque siga PENDING en la BD)', () => {
      expect(publicSlotOfferState(pending, slotStart, false)).toBe('EXPIRED');
    });

    it('recepción ocupó el hueco a mano: ya no está disponible', () => {
      expect(publicSlotOfferState(pending, now, true)).toBe('UNAVAILABLE');
    });

    it('el resultado guardado manda', () => {
      const s = (
        outcome: Parameters<typeof publicSlotOfferState>[0]['outcome'],
      ) => publicSlotOfferState({ outcome, expiresAt: slotStart }, now, true);
      expect(s('ACCEPTED')).toBe('ACCEPTED');
      expect(s('DECLINED')).toBe('DECLINED');
      expect(s('TAKEN_BY_OTHER')).toBe('TAKEN');
      expect(s('EXPIRED')).toBe('EXPIRED');
      expect(s('NO_ANSWER')).toBe('EXPIRED');
    });

    it('cada estado tiene su mensaje en español', () => {
      expect(SLOT_OFFER_MESSAGES.TAKEN).toBe('Este hueco ya se ocupó');
      expect(SLOT_OFFER_MESSAGES.UNAVAILABLE).toBe(
        'Este hueco ya no está disponible',
      );
      expect(SLOT_OFFER_MESSAGES.EXPIRED).toBe('Esta oferta caducó');
    });
  });

  describe('transiciones', () => {
    it('solo una oferta PENDING cambia de resultado', () => {
      for (const to of [
        'ACCEPTED',
        'DECLINED',
        'EXPIRED',
        'TAKEN_BY_OTHER',
        'NO_ANSWER',
      ] as const) {
        expect(canResolveOffer('PENDING', to)).toBe(true);
        expect(canResolveOffer('ACCEPTED', to)).toBe(false);
        expect(canResolveOffer('TAKEN_BY_OTHER', to)).toBe(false);
      }
      expect(canResolveOffer('PENDING', 'PENDING')).toBe(false);
    });

    it('distingue los canales con enlace', () => {
      expect(isLinkChannel('LINK_EMAIL')).toBe(true);
      expect(isLinkChannel('LINK_WA_ME')).toBe(true);
      expect(isLinkChannel('WA_ME')).toBe(false);
      expect(isLinkChannel('PHONE')).toBe(false);
    });
  });

  describe('email (DX-128)', () => {
    const base = {
      email: 'ana@example.com',
      contactChannel: 'EMAIL' as const,
      reminderOptOutAt: null,
    };

    it('con email y sin baja, se le puede escribir', () => {
      expect(emailOfferBlock(base)).toBeNull();
      expect(
        emailOfferBlock({ ...base, contactChannel: 'WHATSAPP' }),
      ).toBeNull();
    });

    it('baja, canal «Ninguno» o sin email: no', () => {
      expect(emailOfferBlock({ ...base, reminderOptOutAt: new Date() })).toBe(
        'OPTED_OUT',
      );
      expect(emailOfferBlock({ ...base, contactChannel: 'NONE' })).toBe(
        'CHANNEL_NONE',
      );
      expect(emailOfferBlock({ ...base, email: null })).toBe('NO_EMAIL');
      expect(emailOfferBlock({ ...base, email: '  ' })).toBe('NO_EMAIL');
    });
  });
});
