import { findAllergyMatches, normalizeDrugText } from './allergy-match';

describe('normalizeDrugText', () => {
  it('quita tildes, mayúsculas, signos y espacios de más', () => {
    expect(normalizeDrugText('  Ácido   Clavulánico, (AINEs) ')).toBe(
      'acido clavulanico aines',
    );
  });
});

describe('findAllergyMatches (alerta de alergia contra la anamnesis)', () => {
  it('coincide sin mayúsculas ni tildes', () => {
    expect(findAllergyMatches(['IBUPROFENO'], ['Ibuprofeno'])).toEqual([
      { activeIngredient: 'IBUPROFENO', allergen: 'Ibuprofeno' },
    ]);
    expect(findAllergyMatches(['Lidocaina'], ['lidocaína'])).toHaveLength(1);
  });

  it('coincide si la alergia nombra el principio activo dentro de un texto más largo', () => {
    expect(
      findAllergyMatches(['ibuprofeno'], ['AINEs (ibuprofeno, naproxeno)']),
    ).toHaveLength(1);
    expect(
      findAllergyMatches(
        ['Amoxicilina + ácido clavulánico'],
        ['Ácido clavulánico'],
      ),
    ).toHaveLength(1);
  });

  it('coincide por familia: alergia a penicilina y se prescribe amoxicilina', () => {
    expect(findAllergyMatches(['Amoxicilina'], ['Penicilina'])).toEqual([
      { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
    ]);
    expect(findAllergyMatches(['Naproxeno'], ['AINES'])).toHaveLength(1);
  });

  it('no confunde fármacos distintos ni palabras sueltas cortas', () => {
    expect(
      findAllergyMatches(['Clorhexidina'], ['Penicilina', 'Látex']),
    ).toEqual([]);
    expect(findAllergyMatches(['Paracetamol'], ['Ibuprofeno'])).toEqual([]);
    expect(findAllergyMatches(['Amoxicilina'], ['de'])).toEqual([]);
    expect(findAllergyMatches(['Clindamicina'], ['Penicilina'])).toEqual([]);
  });

  it('ignora entradas vacías y no repite el mismo par', () => {
    expect(findAllergyMatches(['', '  '], ['Penicilina'])).toEqual([]);
    expect(
      findAllergyMatches(['Amoxicilina', 'amoxicilina'], ['Penicilina']),
    ).toHaveLength(1);
  });
});
