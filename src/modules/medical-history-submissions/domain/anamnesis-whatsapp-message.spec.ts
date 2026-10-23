import { anamnesisWhatsAppMessage } from './anamnesis-whatsapp-message';

describe('mensaje de WhatsApp de la anamnesis (DX-099)', () => {
  it('saludo, clínica y enlace; nada clínico', () => {
    expect(
      anamnesisWhatsAppMessage({
        firstName: 'Mariana',
        clinicName: 'Clínica Demo',
        url: 'https://demo.dentalix.app/anamnesis/abc',
      }),
    ).toBe(
      'Hola Mariana, le saludamos de Clínica Demo. Antes de su cita, responda su cuestionario de salud aquí (el enlace es personal): https://demo.dentalix.app/anamnesis/abc',
    );
  });

  it('sin nombre de pila, saludo genérico', () => {
    expect(
      anamnesisWhatsAppMessage({ firstName: null, clinicName: 'C', url: 'u' }),
    ).toMatch(/^Hola, le saludamos de C\./);
  });
});
