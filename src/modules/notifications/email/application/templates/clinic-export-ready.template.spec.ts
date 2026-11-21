import { renderEmail } from './templates';

/**
 * DX-053: aviso a los ADMIN de que la exportación de datos está lista. Sin
 * enlace al fichero: solo a Ajustes › Exportar datos (exige sesión).
 */
describe('Plantilla clinic-export-ready (DX-053)', () => {
  const vars = {
    clinicName: 'Clínica Ávila',
    requestedByName: 'Ana Rodríguez',
    requestedAtLabel: 'sábado, 21 de noviembre de 2026 a las 9:30 a. m.',
    expiresAtLabel: 'domingo, 22 de noviembre de 2026 a las 9:31 a. m.',
    sizeLabel: '2,4 MB',
    settingsUrl: 'https://avila.dentalix.app/settings/exportar-datos',
  };

  it('dice quién la pidió, cuándo, el tamaño, hasta cuándo y que es de un solo uso', () => {
    const email = renderEmail('clinic-export-ready', vars, null);
    expect(email.subject).toBe(
      'La exportación de datos de Clínica Ávila está lista',
    );
    for (const part of [
      'Ana Rodríguez pidió el sábado, 21 de noviembre de 2026',
      '(2,4 MB)',
      'una sola vez',
      'hasta el domingo, 22 de noviembre de 2026',
      'datos de salud',
    ]) {
      expect(email.text).toContain(part);
    }
    expect(email.html).toContain(vars.settingsUrl);
  });

  it('el único enlace es el de Ajustes (nada que descargue sin sesión)', () => {
    const email = renderEmail('clinic-export-ready', vars, null);
    const links = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links.filter((l) => l.startsWith('http'))).toEqual([
      vars.settingsUrl,
    ]);
    expect(email.text).not.toMatch(/clinic-exports\/|\.zip/);
  });

  it('sin quién, sin fechas y sin host: texto genérico y sin botón', () => {
    const email = renderEmail(
      'clinic-export-ready',
      {
        ...vars,
        requestedByName: null,
        requestedAtLabel: null,
        expiresAtLabel: null,
        settingsUrl: null,
      },
      null,
    );
    expect(email.text).toContain('Un administrador pidió una exportación');
    expect(email.text).toContain('durante 24 horas');
    expect(email.html).not.toContain('Ir a Exportar datos');
  });
});
