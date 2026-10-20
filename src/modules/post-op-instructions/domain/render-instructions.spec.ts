import {
  POSTOP_VARIABLES,
  renderInstructions,
  unknownVariables,
} from './render-instructions';

const VARS = {
  paciente: 'Ana Pérez',
  profesional: 'Dr. Ruiz',
  clinica: 'Clínica Sonrisa',
  telefono_sede: '601 555 0100',
  fecha: '20 de octubre de 2026',
};

describe('renderInstructions', () => {
  it('sustituye las cinco variables', () => {
    const body =
      '{{paciente}}|{{profesional}}|{{clinica}}|{{telefono_sede}}|{{fecha}}';
    expect(renderInstructions(body, VARS)).toBe(
      'Ana Pérez|Dr. Ruiz|Clínica Sonrisa|601 555 0100|20 de octubre de 2026',
    );
  });

  it('tolera espacios dentro de las llaves', () => {
    expect(renderInstructions('Hola {{ paciente }}', VARS)).toBe(
      'Hola Ana Pérez',
    );
  });

  it('sustituye por cadena vacía la variable sin valor', () => {
    expect(
      renderInstructions('Tel: {{telefono_sede}}.', {
        ...VARS,
        telefono_sede: '',
      }),
    ).toBe('Tel: .');
  });

  it('no reinterpreta el valor de una variable como plantilla', () => {
    expect(
      renderInstructions('{{paciente}}', { ...VARS, paciente: '{{clinica}}' }),
    ).toBe('{{clinica}}');
  });

  it('deja literal una variable desconocida', () => {
    expect(renderInstructions('{{foo}}', VARS)).toBe('{{foo}}');
  });
});

describe('unknownVariables', () => {
  it('devuelve solo las desconocidas, sin repetir', () => {
    expect(unknownVariables('{{foo}} {{paciente}} {{ foo }}')).toEqual(['foo']);
  });

  it('detecta variables desconocidas con dígitos', () => {
    expect(unknownVariables('{{paciente2}} {{paciente}}')).toEqual([
      'paciente2',
    ]);
  });

  it('devuelve vacío si todas son conocidas', () => {
    expect(unknownVariables('{{paciente}} {{fecha}}')).toEqual([]);
  });

  it('expone las cinco variables admitidas', () => {
    expect([...POSTOP_VARIABLES]).toEqual([
      'paciente',
      'profesional',
      'clinica',
      'telefono_sede',
      'fecha',
    ]);
  });
});
