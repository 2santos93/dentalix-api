import { postOpWhatsAppMessage } from './postop-whatsapp-message';

describe('postOpWhatsAppMessage', () => {
  const url = 'https://demo.dentalix.app/indicaciones/abc';
  const input = { firstName: 'Ana', clinicName: 'Clínica Sonrisa', url };
  // El mensaje no recibe título ni cuerpo: no puede filtrar el procedimiento.
  const withTitle = {
    ...input,
    title: 'Exodoncia',
    body: 'Indicación de procedimiento',
  };

  it('saluda, nombra la clínica e incluye el enlace', () => {
    expect(postOpWhatsAppMessage(input)).toBe(
      `Hola Ana, te saludamos de Clínica Sonrisa. Aquí tienes tus indicaciones de cuidado tras la visita: ${url}`,
    );
  });

  it('no revela el procedimiento en el texto', () => {
    const text = postOpWhatsAppMessage(withTitle);
    expect(text).not.toMatch(/exodoncia|indicaci[oó]n de procedimiento/i);
    expect(text).toContain(url);
  });
});
