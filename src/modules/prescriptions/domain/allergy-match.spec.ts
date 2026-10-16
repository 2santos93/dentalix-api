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

  it('coincide con miembros de la familia que no están en la lista (sufijos)', () => {
    const cases: [string, string][] = [
      ['Bencilpenicilina benzatínica', 'Penicilina'],
      ['Cloxacilina', 'Penicilinas'],
      ['Amoxicillin', 'Penicilina'],
      ['Cefazolina', 'Cefalosporinas'],
      ['Cefixima', 'Cefalexina'],
      ['Aceclofenaco', 'AINE'],
      ['Dexibuprofeno', 'Ibuprofeno'],
      ['Celecoxib', 'Antiinflamatorios no esteroideos'],
      ['Ácido acetilsalicílico', 'AAS'],
      ['Roxitromicina', 'Macrólidos'],
      ['Levofloxacino', 'Ciprofloxacino'],
      ['Moxifloxacino', 'Quinolonas'],
      ['Doxiciclina', 'Tetraciclinas'],
      ['Clindamicina', 'Lincosamidas'],
      ['Tinidazol', 'Metronidazol'],
      ['Articaína con epinefrina', 'Anestesia local'],
    ];
    for (const [ingredient, allergen] of cases) {
      expect([
        ingredient,
        allergen,
        findAllergyMatches([ingredient], [allergen]).length,
      ]).toEqual([ingredient, allergen, 1]);
    }
  });

  it('casa plurales y la forma inglesa como palabra completa', () => {
    expect(
      findAllergyMatches(['Metronidazol'], ['metronidazole']),
    ).toHaveLength(1);
    expect(
      findAllergyMatches(['Clorhexidina'], ['Clorhexidinas']),
    ).toHaveLength(1);
  });

  it('no confunde «sulfato» con una alergia a las sulfas', () => {
    expect(findAllergyMatches(['Sulfato ferroso'], ['Sulfas'])).toEqual([]);
    expect(
      findAllergyMatches(['Sulfametoxazol + trimetoprim'], ['Sulfas']),
    ).toHaveLength(1);
  });

  it('el texto de la alergia no se interpreta como patrón (sin inyección)', () => {
    expect(findAllergyMatches(['Amoxicilina'], ['.*'])).toEqual([]);
    expect(findAllergyMatches(['Amoxicilina'], ['(a+)+$'])).toEqual([]);
  });

  it('ignora entradas vacías y no repite el mismo par', () => {
    expect(findAllergyMatches(['', '  '], ['Penicilina'])).toEqual([]);
    expect(
      findAllergyMatches(['Amoxicilina', 'amoxicilina'], ['Penicilina']),
    ).toHaveLength(1);
  });
});
