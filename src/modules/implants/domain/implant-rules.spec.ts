import {
  normalizeImplantInput,
  validateImplantInput,
  validatePlacedOn,
  type ImplantInput,
} from './implant-rules';

const VALID: ImplantInput = {
  toothNumber: '36',
  kind: 'IMPLANT',
  manufacturer: 'Straumann',
  system: 'BLT',
  reference: '021.5310',
  lot: 'LOT-AB12',
  diameterMm: 4.1,
  lengthMm: 10,
};

describe('validateImplantInput (DX-191)', () => {
  it('acepta un implante completo', () => {
    expect(validateImplantInput(VALID)).toEqual([]);
  });

  it('lista en español todo lo que falta: fabricante, referencia y lote', () => {
    expect(
      validateImplantInput({
        ...VALID,
        manufacturer: '  ',
        reference: undefined,
        lot: '',
      }),
    ).toEqual([
      'falta el fabricante',
      'falta la referencia (REF)',
      'falta el lote',
    ]);
  });

  it.each(['99', '19', '56', '', '3', '360', 'ab'])(
    'rechaza el diente FDI inválido %p',
    (toothNumber) => {
      expect(validateImplantInput({ ...VALID, toothNumber })).toEqual([
        `el diente «${toothNumber}» no es un código FDI válido (11-18, 21-28, 31-38, 41-48 o temporales 51-55, 61-65, 71-75, 81-85)`,
      ]);
    },
  );

  it('acepta los temporales, como el odontograma', () => {
    expect(validateImplantInput({ ...VALID, toothNumber: '75' })).toEqual([]);
  });

  it('rechaza un tipo desconocido y medidas fuera de rango', () => {
    expect(
      validateImplantInput({
        ...VALID,
        kind: 'SCREW' as ImplantInput['kind'],
        diameterMm: 0,
        lengthMm: 41,
      }),
    ).toEqual([
      'el tipo de componente no es válido',
      'el diámetro debe estar entre 0,1 y 20 mm',
      'la longitud debe estar entre 0,1 y 40 mm',
    ]);
  });

  it('rechaza textos demasiado largos', () => {
    expect(
      validateImplantInput({
        ...VALID,
        lot: 'L'.repeat(81),
        notes: 'n'.repeat(1001),
      }),
    ).toEqual([
      'el lote admite como mucho 80 caracteres',
      'las notas admiten como mucho 1000 caracteres',
    ]);
  });
});

describe('normalizeImplantInput', () => {
  it('recorta y deja a null los opcionales vacíos', () => {
    expect(
      normalizeImplantInput({
        ...VALID,
        manufacturer: ' Straumann ',
        system: ' ',
        udi: '',
        notes: '  ',
      }),
    ).toMatchObject({
      manufacturer: 'Straumann',
      system: null,
      udi: null,
      notes: null,
      sanitaryRegistration: null,
    });
  });
});

describe('validatePlacedOn', () => {
  it('sin fecha, hoy', () => {
    expect(validatePlacedOn(undefined, '2026-10-17')).toBe('2026-10-17');
  });
  it('admite una fecha pasada real', () => {
    expect(validatePlacedOn('2026-02-28', '2026-10-17')).toBe('2026-02-28');
  });
  it('rechaza una fecha futura o inexistente', () => {
    expect(() => validatePlacedOn('2026-10-18', '2026-10-17')).toThrow(
      'La fecha de colocación no puede ser posterior a hoy',
    );
    expect(() => validatePlacedOn('2026-02-30', '2026-10-17')).toThrow(
      'La fecha de colocación no existe en el calendario',
    );
  });
});
