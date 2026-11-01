import {
  answerOf,
  readStoredHabits,
  readStoredPregnancy,
  toVersionData,
} from './anamnesis-answers';

describe('anamnesis tri-estado — lectura de versiones guardadas', () => {
  it('una versión ANTERIOR (booleanos) se lee como se registró: true «Sí», false «No», ausente sin responder', () => {
    expect(
      readStoredHabits({
        tabaquismo: { activo: true, porDia: 5, anios: 8 },
        alcohol: { activo: false },
        bruxismo: true,
        sustancias: false,
        higieneOral: { cepilladoPorDia: 2, hilo: false, cremaConFluor: true },
        dieta: 'Normal',
      }),
    ).toEqual({
      tabaquismo: { estado: 'SI', porDia: 5, anios: 8 },
      alcohol: { estado: 'NO' },
      bruxismo: 'SI',
      sustancias: 'NO',
      higieneOral: { cepilladoPorDia: 2, hilo: 'NO', cremaConFluor: 'SI' },
      dieta: 'Normal',
    });
  });

  it('una versión nueva (tri-estado) se lee tal cual, con «No sabe»', () => {
    const habits = {
      tabaquismo: { estado: 'DESCONOCE' },
      bruxismo: 'DESCONOCE',
      higieneOral: { enjuague: 'DESCONOCE' },
    };
    expect(readStoredHabits(habits)).toEqual(habits);
  });

  it('sin hábitos (o basura) → null; lo que no es una respuesta es sin responder', () => {
    expect(readStoredHabits(null)).toBeNull();
    expect(readStoredHabits([])).toBeNull();
    expect(readStoredHabits({ bruxismo: 'quizá', tabaquismo: {} })).toBeNull();
    expect(answerOf(undefined)).toBeUndefined();
    expect(answerOf('NO')).toBe('NO');
  });

  it('embarazo: la columna manda; sin ella (versiones anteriores) solo la bandera «Sí»; un false NO es un «No»', () => {
    expect(readStoredPregnancy('NO', { embarazo: false })).toBe('NO');
    expect(readStoredPregnancy('DESCONOCE', { embarazo: false })).toBe(
      'DESCONOCE',
    );
    expect(readStoredPregnancy(null, { embarazo: true })).toBe('SI');
    expect(readStoredPregnancy(null, { embarazo: false })).toBeNull();
  });
});

describe('toVersionData — lo que se guarda', () => {
  it('pregnancy tri-estado; las semanas solo con «Sí»', () => {
    expect(toVersionData({ pregnancy: 'NO', semanasEmbarazo: 8 })).toEqual(
      expect.objectContaining({ pregnancy: 'NO' }),
    );
    expect(
      toVersionData({ pregnancy: 'NO', semanasEmbarazo: 8 }),
    ).not.toHaveProperty('semanasEmbarazo');
    expect(toVersionData({ pregnancy: 'SI', semanasEmbarazo: 8 })).toEqual(
      expect.objectContaining({ pregnancy: 'SI', semanasEmbarazo: 8 }),
    );
  });

  it('cliente anterior: embarazo true → «Sí»; false → sin responder; pregnancy manda', () => {
    expect(toVersionData({ embarazo: true }).pregnancy).toBe('SI');
    expect(toVersionData({ embarazo: false })).not.toHaveProperty('pregnancy');
    expect(toVersionData({ embarazo: true, pregnancy: 'NO' }).pregnancy).toBe(
      'NO',
    );
  });

  it('hábitos a la forma tri-estado y nada de campos colados', () => {
    const data = toVersionData({
      habits: { bruxismo: true },
      ...({ tenantId: 'x', safetyFlags: { embarazo: true } } as object),
    });
    expect(data.habits).toEqual({ bruxismo: 'SI' });
    expect(data).not.toHaveProperty('tenantId');
    expect(data).not.toHaveProperty('safetyFlags');
  });
});
