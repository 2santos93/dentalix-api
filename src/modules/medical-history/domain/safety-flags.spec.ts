import { deriveSafetyFlags } from './safety-flags';

describe('deriveSafetyFlags', () => {
  it('marca embarazo desde la entrada explícita y copia las semanas', () => {
    const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags({
      embarazo: true,
      semanasEmbarazo: 12,
    });
    expect(safetyFlags.embarazo).toBe(true);
    expect(safetyFlags.semanasEmbarazo).toBe(12);
    expect(hasCriticalAlert).toBe(true);
  });

  it('deriva alergia a anestésico/penicilina/látex por palabra clave del alérgeno', () => {
    const { safetyFlags } = deriveSafetyFlags({
      allergies: [
        {
          alergeno: 'Lidocaína',
          tipo: 'MEDICAMENTO',
          severidad: 'MODERADA',
          esAlerta: true,
        },
        {
          alergeno: 'Penicilina',
          tipo: 'MEDICAMENTO',
          severidad: 'LEVE',
          esAlerta: true,
        },
        {
          alergeno: 'Guantes de látex',
          tipo: 'MATERIAL',
          severidad: 'MODERADA',
          esAlerta: true,
        },
      ],
    });
    expect(safetyFlags.alergiaAnestesico).toBe(true);
    expect(safetyFlags.alergiaPenicilina).toBe(true);
    expect(safetyFlags.alergiaLatex).toBe(true);
  });

  it('deriva anticoagulantes y bifosfonatos por palabra clave del medicamento', () => {
    const { safetyFlags } = deriveSafetyFlags({
      medications: [
        { nombre: 'Warfarina', esAlerta: false },
        { nombre: 'Ácido zoledrónico', esAlerta: false },
      ],
    });
    expect(safetyFlags.anticoagulantes).toBe(true);
    expect(safetyFlags.bifosfonatos).toBe(true);
  });

  it('deriva diabetes y profilaxis desde condiciones con estado SI', () => {
    const { safetyFlags } = deriveSafetyFlags({
      conditions: [
        {
          codigo: 'DIABETES',
          etiqueta: 'Diabetes',
          estado: 'SI',
          esAlerta: true,
        },
        {
          codigo: 'VALVULOPATIA',
          etiqueta: 'Valvulopatía',
          estado: 'SI',
          esAlerta: true,
        },
        { codigo: 'ASMA', etiqueta: 'Asma', estado: 'NO', esAlerta: false },
      ],
    });
    expect(safetyFlags.diabetes).toBe(true);
    expect(safetyFlags.profilaxisAntibiotica).toBe(true);
  });

  it('hasCriticalAlert es false cuando no hay banderas ni alergias de alerta', () => {
    const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags({
      allergies: [
        {
          alergeno: 'Polen',
          tipo: 'AMBIENTAL',
          severidad: 'LEVE',
          esAlerta: false,
        },
      ],
      conditions: [
        { codigo: 'ASMA', etiqueta: 'Asma', estado: 'NO', esAlerta: false },
      ],
    });
    expect(hasCriticalAlert).toBe(false);
    expect(safetyFlags.embarazo).toBe(false);
  });

  it('hasCriticalAlert es true si alguna alergia tiene esAlerta aunque no sea de las críticas conocidas', () => {
    const { hasCriticalAlert } = deriveSafetyFlags({
      allergies: [
        {
          alergeno: 'Yodo',
          tipo: 'MEDICAMENTO',
          severidad: 'MODERADA',
          esAlerta: true,
        },
      ],
    });
    expect(hasCriticalAlert).toBe(true);
  });
});
