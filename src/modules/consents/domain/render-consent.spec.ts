import {
  CONSENT_VARIABLES,
  findUnknownVariables,
  formatConsentDate,
  renderConsent,
  type ConsentVariables,
} from './render-consent';

const values: ConsentVariables = {
  paciente: 'Ana Pérez',
  documento: 'CC 1020304050',
  profesional: 'Dra. Laura Gómez',
  clinica: 'Clínica Demo',
  fecha: '16 de octubre de 2026',
  tratamiento: 'Exodoncia simple (diente 48)',
};

describe('renderConsent', () => {
  it('sustituye cada variable conocida por su valor', () => {
    const body =
      'Yo, {{paciente}} ({{documento}}), autorizo a {{profesional}} de {{clinica}} ' +
      'a realizar {{tratamiento}} el {{fecha}}.';
    expect(renderConsent(body, values)).toBe(
      'Yo, Ana Pérez (CC 1020304050), autorizo a Dra. Laura Gómez de Clínica Demo ' +
        'a realizar Exodoncia simple (diente 48) el 16 de octubre de 2026.',
    );
  });

  it('tolera espacios y mayúsculas dentro de las llaves y repite ocurrencias', () => {
    expect(renderConsent('{{ Paciente }} / {{PACIENTE}}', values)).toBe(
      'Ana Pérez / Ana Pérez',
    );
  });

  it('no interpreta los valores como plantilla (sin inyección de variables)', () => {
    expect(
      renderConsent('{{paciente}}', { ...values, paciente: '{{clinica}}' }),
    ).toBe('{{clinica}}');
  });

  it('deja intacta una variable desconocida', () => {
    expect(renderConsent('Hola {{otro}}', values)).toBe('Hola {{otro}}');
  });

  it('expone las seis variables del alcance', () => {
    expect([...CONSENT_VARIABLES]).toEqual([
      'paciente',
      'documento',
      'profesional',
      'clinica',
      'fecha',
      'tratamiento',
    ]);
  });
});

describe('findUnknownVariables', () => {
  it('devuelve las variables que no existen, sin repetir', () => {
    expect(
      findUnknownVariables('{{paciente}} {{edad}} {{ edad }} {{firma}}'),
    ).toEqual(['edad', 'firma']);
  });

  it('rechaza nombres con dígitos sin duplicarlos ni confundirlos con paciente', () => {
    expect(
      findUnknownVariables(
        '{{paciente2}} {{ Paciente2 }} {{2paciente}} {{paciente}}',
      ),
    ).toEqual(['paciente2', '2paciente']);
  });

  it('acepta un texto sin variables o solo con las conocidas', () => {
    expect(findUnknownVariables('Texto plano')).toEqual([]);
    expect(findUnknownVariables('{{fecha}} {{ clinica }}')).toEqual([]);
  });
});

describe('formatConsentDate', () => {
  it('formatea la fecha larga en español en la zona horaria dada', () => {
    // 03:00 UTC del 17 es todavía el 16 en Bogotá (UTC-5).
    expect(
      formatConsentDate(new Date('2026-10-17T03:00:00.000Z'), 'America/Bogota'),
    ).toBe('16 de octubre de 2026');
  });
});
