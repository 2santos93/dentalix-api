import { regionalFormat } from '../../../shared/format/regional-format';
import { defaultMessageText } from './message-catalog';
import {
  CONFIRMATION_MESSAGE_MAX,
  confirmationMessageLanguage,
  confirmationWhatsAppText,
  linkOfferWhatsAppText,
  sedeDayAndTime,
  type ConfirmationWhatsAppInput,
  type LinkOfferWhatsAppInput,
} from './whatsapp-messages';

const FMT = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
const FMT_24 = regionalFormat({ locale: 'es-VE', hourCycle: 'h23' });
const ZONE = 'America/Caracas';
// 14:00 UTC = 10:00 a. m. en Caracas, martes 20 de octubre.
const START = new Date('2026-10-20T14:00:00.000Z');

const confirmation = (
  over: Partial<ConfirmationWhatsAppInput> = {},
): ConfirmationWhatsAppInput => ({
  url: 'https://demo.dentalix.app/confirmar/tok',
  patientFirstName: 'Ana',
  ...sedeDayAndTime(START, ZONE, FMT),
  providerName: 'Dra. Pérez',
  locationName: 'Sede Norte',
  locationAddress: 'Av. Libertador 100',
  clinicName: 'Clínica Dental Altamira',
  anamnesisUrl: null,
  anamnesisPending: false,
  patientLanguage: null,
  preVisitInstructions: null,
  ...over,
});

const offer = (
  over: Partial<LinkOfferWhatsAppInput> = {},
): LinkOfferWhatsAppInput => ({
  firstName: 'Ana María',
  ...sedeDayAndTime(START, ZONE, FMT),
  locationName: 'Sede Norte',
  providerName: null,
  clinicName: 'Clínica Dental Altamira',
  url: 'https://demo.dentalix.app/hueco/abc',
  expiresAtLabel: 'martes 20 de octubre de 2026 a las 9:00 a. m.',
  ...over,
});

describe('DX-565: textos de wa.me en la API', () => {
  describe('confirmación (antes `confirmationMessage` de la web)', () => {
    it('sin plantilla: el texto de siempre, palabra por palabra', () => {
      expect(confirmationWhatsAppText(confirmation(), null)).toBe(
        'Hola Ana, te recordamos tu cita del martes, 20 de octubre a las 10:00 a. m. con Dra. Pérez en Sede Norte (Av. Libertador 100). ' +
          'Confírmala, cancélala o pide que te llamemos aquí: https://demo.dentalix.app/confirmar/tok',
      );
      expect(
        confirmationWhatsAppText(
          confirmation({
            patientFirstName: null,
            providerName: null,
            locationAddress: null,
            locationName: 'Sede principal',
            url: 'u',
          }),
          null,
        ),
      ).toBe(
        'Hola, te recordamos tu cita del martes, 20 de octubre a las 10:00 a. m. en Sede principal. ' +
          'Confírmala, cancélala o pide que te llamemos aquí: u',
      );
    });

    it('el texto por defecto del catálogo da lo mismo en todos los casos y en los dos idiomas', () => {
      const cases = [
        confirmation(),
        confirmation({ patientFirstName: null }),
        confirmation({ providerName: null, locationAddress: null }),
        confirmation({ anamnesisUrl: 'https://demo.dentalix.app/anamnesis/x' }),
        confirmation({ anamnesisPending: true }),
        confirmation({ preVisitInstructions: { es: 'Ven en ayunas.' } }),
        confirmation(sedeDayAndTime(START, ZONE, FMT_24)),
      ];
      for (const language of ['es', 'en'] as const) {
        const text = defaultMessageText(
          'appointment-confirmation',
          'WHATSAPP',
          language,
        );
        for (const c of cases) {
          const input = { ...c, patientLanguage: language };
          expect(confirmationWhatsAppText(input, text)).toBe(
            confirmationWhatsAppText(input, null),
          );
        }
      }
    });

    it('con plantilla: el cuerpo de la clínica y detrás, fijos, anamnesis e indicaciones', () => {
      const text = confirmationWhatsAppText(
        confirmation({
          anamnesisPending: true,
          preVisitInstructions: { es: 'Ven en ayunas.' },
        }),
        { subject: null, body: '{paciente}: tu cita es el {fecha}. {enlace}' },
      );
      expect(text).toBe(
        'Ana: tu cita es el martes, 20 de octubre. https://demo.dentalix.app/confirmar/tok' +
          ' Si aún no completaste el cuestionario de salud, usa el enlace que te enviamos.' +
          '\n\nAntes de tu cita: Ven en ayunas.',
      );
    });

    it('en inglés, con las indicaciones en inglés', () => {
      const text = confirmationWhatsAppText(
        confirmation({
          patientLanguage: 'en-GB',
          preVisitInstructions: { es: 'Ven en ayunas.', en: 'Come fasting.' },
        }),
        null,
      );
      expect(text.startsWith('Hello Ana, this is a reminder')).toBe(true);
      expect(text.endsWith('\n\nBefore your appointment: Come fasting.')).toBe(
        true,
      );
    });

    it('no pasa de 1500 caracteres: se recortan las indicaciones', () => {
      const long = 'x'.repeat(3000);
      const text = confirmationWhatsAppText(
        confirmation({ preVisitInstructions: { es: long } }),
        null,
      );
      expect([...text].length).toBe(CONFIRMATION_MESSAGE_MAX);
      expect(text.endsWith('…')).toBe(true);
    });

    it('idioma: inglés por la base; el resto, español', () => {
      expect(confirmationMessageLanguage(null)).toBe('es');
      expect(confirmationMessageLanguage('en-US')).toBe('en');
      expect(confirmationMessageLanguage('es-419')).toBe('es');
      expect(confirmationMessageLanguage('ca')).toBe('es');
    });
  });

  describe('oferta de hueco con enlace (antes `linkOfferMessage` de la web)', () => {
    it('sin plantilla: el texto de siempre, sin doblar el punto de «a. m.»', () => {
      expect(linkOfferWhatsAppText(offer(), null)).toBe(
        'Hola Ana, te escribimos de Sede Norte. Se liberó un hueco el martes, 20 de octubre a las 10:00 a. m. Si te viene bien, acéptalo aquí (se lo queda el primero que lo acepte): https://demo.dentalix.app/hueco/abc',
      );
      expect(
        linkOfferWhatsAppText(offer({ providerName: 'Dra. Gómez' }), null),
      ).toContain('a las 10:00 a. m. con Dra. Gómez. Si te viene bien');
    });

    it('el texto por defecto del catálogo da lo mismo', () => {
      const text = defaultMessageText('slot-offer', 'WHATSAPP', 'es');
      for (const c of [
        offer(),
        offer({ providerName: 'Dra. Gómez' }),
        offer({ firstName: '' }),
        offer(sedeDayAndTime(START, ZONE, FMT_24)),
      ]) {
        expect(linkOfferWhatsAppText(c, text)).toBe(
          linkOfferWhatsAppText(c, null),
        );
      }
    });

    it('con plantilla: el texto de la clínica', () => {
      expect(
        linkOfferWhatsAppText(offer(), {
          subject: null,
          body: '{paciente}, hueco el {fecha} hasta {caduca}: {enlace}',
        }),
      ).toBe(
        'Ana, hueco el martes, 20 de octubre hasta martes 20 de octubre de 2026 a las 9:00 a. m.: https://demo.dentalix.app/hueco/abc',
      );
    });
  });
});
