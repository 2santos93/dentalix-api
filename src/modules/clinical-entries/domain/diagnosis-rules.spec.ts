import { validateDiagnoses } from './diagnosis-rules';

describe('validateDiagnoses (DX-212)', () => {
  it('sin diagnósticos: lista vacía (la evolución sin diagnóstico sigue permitida)', () => {
    expect(validateDiagnoses(undefined)).toEqual({ diagnoses: [] });
    expect(validateDiagnoses([])).toEqual({ diagnoses: [] });
  });

  it('principal en la posición 0 y relacionados después, en su orden; normaliza códigos', () => {
    const result = validateDiagnoses([
      { icd10Code: 'k05.1', kind: 'RELACIONADO', toothFdi: '36' },
      { icd10Code: 'K021', kind: 'PRINCIPAL' },
      { icd10Code: 'K04.0', kind: 'RELACIONADO' },
    ]);
    expect(result).toEqual({
      diagnoses: [
        { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: null, position: 0 },
        {
          icd10Code: 'K05.1',
          kind: 'RELACIONADO',
          toothFdi: '36',
          position: 1,
        },
        {
          icd10Code: 'K04.0',
          kind: 'RELACIONADO',
          toothFdi: null,
          position: 2,
        },
      ],
    });
  });

  it('un segundo PRINCIPAL es un error en español', () => {
    expect(
      validateDiagnoses([
        { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
        { icd10Code: 'K05.1', kind: 'PRINCIPAL' },
      ]),
    ).toEqual({
      error: 'Solo puede haber un diagnóstico principal por evolución',
    });
  });

  it('más de 3 relacionados es un error', () => {
    const related = ['K05.1', 'K04.0', 'K03.1', 'K06.0'].map((icd10Code) => ({
      icd10Code,
      kind: 'RELACIONADO' as const,
    }));
    expect(
      validateDiagnoses([
        { icd10Code: 'K02.1', kind: 'PRINCIPAL' },
        ...related,
      ]),
    ).toEqual({
      error: 'Como máximo 3 diagnósticos relacionados por evolución',
    });
  });

  it('relacionados sin principal es un error', () => {
    expect(
      validateDiagnoses([{ icd10Code: 'K05.1', kind: 'RELACIONADO' }]),
    ).toEqual({
      error: 'Los diagnósticos relacionados necesitan un diagnóstico principal',
    });
  });

  it('código con formato inválido: «Código CIE-10 no válido»', () => {
    expect(
      validateDiagnoses([{ icd10Code: 'caries', kind: 'PRINCIPAL' }]),
    ).toEqual({ error: 'Código CIE-10 no válido: «CARIES»' });
  });

  it('diente que no es FDI', () => {
    expect(
      validateDiagnoses([
        { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: '19' },
      ]),
    ).toEqual({ error: 'El diente «19» no es un número FDI válido' });
  });

  it('el mismo código en el mismo diente, repetido', () => {
    expect(
      validateDiagnoses([
        { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: '36' },
        { icd10Code: 'K02.1', kind: 'RELACIONADO', toothFdi: '36' },
      ]),
    ).toEqual({ error: 'El diagnóstico K02.1 está repetido' });
  });

  it('el mismo código en otro diente sí vale', () => {
    const result = validateDiagnoses([
      { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: '36' },
      { icd10Code: 'K02.1', kind: 'RELACIONADO', toothFdi: '46' },
    ]);
    expect('diagnoses' in result && result.diagnoses).toHaveLength(2);
  });

  it('un diente vacío cuenta como sin diente', () => {
    expect(
      validateDiagnoses([
        { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: ' ' },
      ]),
    ).toEqual({
      diagnoses: [
        { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: null, position: 0 },
      ],
    });
  });
});
