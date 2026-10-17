import {
  DEFAULT_WAITLIST_OFFER_CONFIG,
  loadWaitlistOfferConfig,
  offerCapMessage,
  offerDayFor,
  whatsappOfferPhone,
} from './waitlist-offer-rules';

describe('ofertas de huecos (DX-210)', () => {
  describe('día de la oferta en la zona de la sede', () => {
    it('las 23:30 de Bogotá siguen siendo hoy aunque en UTC ya sea mañana', () => {
      const now = new Date('2026-10-21T04:30:00Z'); // 20/10 23:30 en Bogotá
      expect(offerDayFor(now, 'America/Bogota')).toBe('2026-10-20');
      expect(offerDayFor(now, 'Europe/Madrid')).toBe('2026-10-21');
    });
  });

  describe('tope por paciente y día', () => {
    it('por defecto 2, con el texto de la tarea', () => {
      expect(DEFAULT_WAITLIST_OFFER_CONFIG.offersPerPatientPerDay).toBe(2);
      expect(offerCapMessage(2)).toBe('Ya se le ofrecieron 2 huecos hoy');
      expect(offerCapMessage(1)).toBe('Ya se le ofreció 1 hueco hoy');
    });

    it('configurable por entorno; un valor inválido hace fallar el arranque', () => {
      expect(loadWaitlistOfferConfig(() => undefined)).toEqual(
        DEFAULT_WAITLIST_OFFER_CONFIG,
      );
      expect(
        loadWaitlistOfferConfig((k) =>
          k === 'WAITLIST_OFFERS_PER_PATIENT_PER_DAY' ? '3' : undefined,
        ).offersPerPatientPerDay,
      ).toBe(3);
      for (const bad of ['0', '-1', '1.5', 'dos', '100']) {
        expect(() => loadWaitlistOfferConfig(() => bad)).toThrow(
          /WAITLIST_OFFERS_PER_PATIENT_PER_DAY/,
        );
      }
    });
  });

  describe('WhatsApp según el canal y la baja del paciente (DX-128)', () => {
    const base = {
      phone: '310 123 4567',
      contactChannel: 'EMAIL' as const,
      reminderOptOutAt: null,
    };

    it('móvil válido y sin baja: el número para wa.me', () => {
      expect(whatsappOfferPhone(base, 'CO')).toEqual({
        blocked: false,
        phone: '573101234567',
      });
    });

    it('con baja de los avisos o sin canal: bloqueado (se le llama)', () => {
      expect(
        whatsappOfferPhone({ ...base, reminderOptOutAt: new Date() }, 'CO'),
      ).toEqual({ blocked: true, phone: null });
      expect(
        whatsappOfferPhone({ ...base, contactChannel: 'NONE' }, 'CO'),
      ).toEqual({ blocked: true, phone: null });
    });

    it('un fijo o un número inválido no recibe WhatsApp', () => {
      expect(
        whatsappOfferPhone({ ...base, phone: '601 555 1234' }, 'CO'),
      ).toEqual({ blocked: false, phone: null });
      expect(whatsappOfferPhone({ ...base, phone: null }, 'CO')).toEqual({
        blocked: false,
        phone: null,
      });
    });
  });
});
