import {
  ANESTHESIA_DOSE_RULES_VERSION,
  type AnestheticSnapshot,
  isValidCarpules,
  lineMg,
  maxDoseMg,
  summarizeAnesthesiaDose,
} from './anesthesia-dose';
import { SAMPLE_ANESTHETICS } from './sample-anesthetics';

// Valores de referencia de la literatura (los del catálogo de ejemplo):
// Malamed, Handbook of Local Anesthesia (7.ª ed.), dosis máximas recomendadas.
function sample(code: string): AnestheticSnapshot {
  const s = SAMPLE_ANESTHETICS.find((a) => a.sampleCode === code);
  if (!s) throw new Error(code);
  return s;
}
const LIDO = sample('LIDOCAINE_2_EPI');
const ARTI = sample('ARTICAINE_4_EPI');
const MEPI = sample('MEPIVACAINE_3');
const PRILO = sample('PRILOCAINE_4');
const BUPI = sample('BUPIVACAINE_05_EPI');

const NO_ANAMNESIS = null;
const CLEAN = { allergens: [], anestheticAllergyFlag: false };

describe('dosis de anestesia local (DX-307)', () => {
  it('el catálogo de ejemplo trae los valores de referencia', () => {
    expect(
      [LIDO, ARTI, MEPI, PRILO, BUPI].map((a) => [
        a.concentrationPct,
        a.maxMgPerKg,
        a.maxAbsoluteMg,
      ]),
    ).toEqual([
      [2, 7, 500],
      [4, 7, 500],
      [3, 6.6, 400],
      [4, 8, 600],
      [0.5, 1.3, 90],
    ]);
    expect(LIDO.mlPerCarpule).toBe(1.8);
  });

  it('mg por línea = carpules × ml × concentración × 10', () => {
    expect(lineMg(LIDO, 1)).toBe(36);
    expect(lineMg(LIDO, 0.5)).toBe(18);
    expect(lineMg({ ...ARTI, mlPerCarpule: 1.7 }, 3)).toBe(204);
    expect(lineMg(MEPI, 2)).toBe(108);
    expect(lineMg(BUPI, 1)).toBe(9);
  });

  it('carpules: de 0,25 en 0,25, entre 0,25 y 20', () => {
    expect(isValidCarpules(0.5)).toBe(true);
    expect(isValidCarpules(1.25)).toBe(true);
    expect(isValidCarpules(0)).toBe(false);
    expect(isValidCarpules(0.3)).toBe(false);
    expect(isValidCarpules(20.25)).toBe(false);
    expect(isValidCarpules(Number.NaN)).toBe(false);
  });

  describe('máximo por peso con tope absoluto', () => {
    it('niño de 15 kg: lidocaína 105 mg', () => {
      expect(maxDoseMg(LIDO, 15)).toBe(105);
    });
    it('adulto de 70 kg: lidocaína 490 mg (por peso, bajo el tope)', () => {
      expect(maxDoseMg(LIDO, 70)).toBe(490);
    });
    it('adulto de 110 kg: el tope absoluto manda (500 / 400 / 600 / 90)', () => {
      expect(maxDoseMg(LIDO, 110)).toBe(500);
      expect(maxDoseMg(MEPI, 110)).toBe(400);
      expect(maxDoseMg(PRILO, 110)).toBe(600);
      expect(maxDoseMg(BUPI, 110)).toBe(90);
    });
    it('sin peso: null', () => {
      expect(maxDoseMg(LIDO, null)).toBeNull();
    });
  });

  it('criterio DX-307: 3 carpules de articaína 4 % (1,7 ml) a 20 kg → 204 de 140 mg (146 %), bloqueante', () => {
    const r = summarizeAnesthesiaDose({
      lines: [{ anesthetic: { ...ARTI, mlPerCarpule: 1.7 }, carpules: 3 }],
      weightKg: 20,
      anamnesis: CLEAN,
    });
    expect(r.rulesVersion).toBe(ANESTHESIA_DOSE_RULES_VERSION);
    expect(r.totalMg).toBe(204);
    expect(r.byAnesthetic).toEqual([
      expect.objectContaining({ mg: 204, maxMg: 140, percent: 146 }),
    ]);
    expect(r.percent).toBe(146);
    expect(r.level).toBe('EXCEEDED');
    expect(r.alerts.map((a) => [a.code, a.severity])).toEqual([
      ['DOSE_OVER_MAX', 'BLOCKING'],
    ]);
    expect(r.alerts[0].message).toBe(
      'Dosis máxima superada: 204 mg de 140 mg (146 %) para 20 kg.',
    );
  });

  it('niño de 15 kg: 2 carpules de lidocaína es 69 % (sin aviso); 2,5 es 86 % (aviso); 3 es 103 % (bloqueo)', () => {
    const run = (carpules: number) =>
      summarizeAnesthesiaDose({
        lines: [{ anesthetic: LIDO, carpules }],
        weightKg: 15,
        anamnesis: CLEAN,
      });
    expect([run(2).percent, run(2).level]).toEqual([69, 'OK']);
    expect([run(2.5).percent, run(2.5).level]).toEqual([86, 'WARNING']);
    expect(run(2.5).alerts.map((a) => [a.code, a.severity])).toEqual([
      ['DOSE_NEAR_MAX', 'INFO'],
    ]);
    expect([run(3).percent, run(3).level]).toEqual([103, 'EXCEEDED']);
  });

  it('justo en el 80 % avisa y justo en el 100 % bloquea (sin errores de coma flotante)', () => {
    // 20 kg × 7 = 140 mg; 112 mg = 80 % exacto; 140 mg = 100 % exacto.
    const at = (mg: number) =>
      summarizeAnesthesiaDose({
        lines: [
          { anesthetic: { ...LIDO, mlPerCarpule: mg / 20 }, carpules: 1 },
        ],
        weightKg: 20,
        anamnesis: CLEAN,
      }).level;
    expect(at(111.9)).toBe('OK');
    expect(at(112)).toBe('WARNING');
    expect(at(140)).toBe('EXCEEDED');
  });

  it('el % que se enseña nunca contradice el nivel: 99,6 % se queda en 99 y 79,6 % en 79', () => {
    // 10 mg/kg a 10 kg: máximo 100 mg. 3 × 1,66 ml al 2 % = 99,6 mg.
    const TEN: AnestheticSnapshot = {
      ...LIDO,
      mlPerCarpule: 1.66,
      maxMgPerKg: 10,
      maxAbsoluteMg: 1000,
    };
    const near = summarizeAnesthesiaDose({
      lines: [{ anesthetic: TEN, carpules: 3 }],
      weightKg: 10,
      anamnesis: CLEAN,
    });
    expect([near.totalMg, near.level, near.percent]).toEqual([
      99.6,
      'WARNING',
      99,
    ]);
    expect(near.byAnesthetic[0].percent).toBe(99);
    // 2 × 1,99 ml al 2 % = 79,6 mg.
    const below = summarizeAnesthesiaDose({
      lines: [{ anesthetic: { ...TEN, mlPerCarpule: 1.99 }, carpules: 2 }],
      weightKg: 10,
      anamnesis: CLEAN,
    });
    expect([below.level, below.percent]).toEqual(['OK', 79]);
  });

  it('varios anestésicos: el % es la suma de las fracciones de cada máximo', () => {
    // 20 kg: lidocaína 2 carp = 72/140 (51,4 %) + articaína 1 carp (1,7 ml)
    // = 68/140 (48,6 %) → 100 %: bloquea aunque cada uno por separado no.
    const r = summarizeAnesthesiaDose({
      lines: [
        { anesthetic: LIDO, carpules: 2 },
        { anesthetic: { ...ARTI, mlPerCarpule: 1.7 }, carpules: 1 },
      ],
      weightKg: 20,
      anamnesis: CLEAN,
    });
    expect(r.byAnesthetic.map((a) => [a.mg, a.maxMg, a.percent])).toEqual([
      [72, 140, 51],
      [68, 140, 49],
    ]);
    expect(r.totalMg).toBe(140);
    expect(r.percent).toBe(100);
    expect(r.level).toBe('EXCEEDED');
  });

  it('varias líneas del mismo anestésico se agrupan', () => {
    const r = summarizeAnesthesiaDose({
      lines: [
        { anesthetic: LIDO, carpules: 1 },
        { anesthetic: LIDO, carpules: 1.5 },
      ],
      weightKg: 70,
      anamnesis: CLEAN,
    });
    expect(r.byAnesthetic).toHaveLength(1);
    expect(r.byAnesthetic[0]).toEqual(
      expect.objectContaining({
        carpules: 2.5,
        mg: 90,
        maxMg: 490,
        percent: 18,
      }),
    );
  });

  it('adulto > 100 kg con tope: 14 carpules de lidocaína (504 mg) superan los 500 mg', () => {
    const r = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 14 }],
      weightKg: 110,
      anamnesis: CLEAN,
    });
    expect([r.totalMg, r.byAnesthetic[0].maxMg, r.percent, r.level]).toEqual([
      504,
      500,
      101,
      'EXCEEDED',
    ]);
  });

  it('bupivacaína a 70 kg: el máximo es el tope de 90 mg (91 por peso)', () => {
    const r = summarizeAnesthesiaDose({
      lines: [{ anesthetic: BUPI, carpules: 8 }],
      weightKg: 70,
      anamnesis: CLEAN,
    });
    expect([r.totalMg, r.byAnesthetic[0].maxMg, r.percent]).toEqual([
      72, 90, 80,
    ]);
    expect(r.level).toBe('WARNING');
  });

  describe('sin peso', () => {
    it('no calcula el máximo y lo dice (informativo, no bloquea)', () => {
      const r = summarizeAnesthesiaDose({
        lines: [{ anesthetic: LIDO, carpules: 2 }],
        weightKg: null,
        anamnesis: CLEAN,
      });
      expect([r.percent, r.level, r.byAnesthetic[0].maxMg]).toEqual([
        null,
        'NO_WEIGHT',
        null,
      ]);
      expect(r.alerts).toEqual([
        expect.objectContaining({
          code: 'WEIGHT_MISSING',
          severity: 'INFO',
          message: 'Dosis máxima no calculada: falta el peso.',
        }),
      ]);
    });

    it('pero el tope absoluto sigue valiendo: 14 carpules de lidocaína bloquean', () => {
      const r = summarizeAnesthesiaDose({
        lines: [{ anesthetic: LIDO, carpules: 14 }],
        weightKg: null,
        anamnesis: CLEAN,
      });
      expect(r.alerts.map((a) => [a.code, a.severity])).toEqual([
        ['WEIGHT_MISSING', 'INFO'],
        ['DOSE_OVER_ABSOLUTE', 'BLOCKING'],
      ]);
      expect(r.level).toBe('EXCEEDED');
    });
  });

  describe('alergia', () => {
    it('alergia a la lidocaína en la lista + articaína (amida) → bloqueante', () => {
      const r = summarizeAnesthesiaDose({
        lines: [{ anesthetic: ARTI, carpules: 1 }],
        weightKg: 70,
        anamnesis: { allergens: ['Lidocaína'], anestheticAllergyFlag: false },
      });
      expect(r.alerts.map((a) => [a.code, a.severity])).toEqual([
        ['ALLERGY_ANESTHETIC', 'BLOCKING'],
      ]);
      expect(r.alerts[0].message).toContain('Lidocaína');
    });

    it('la casilla «alergia a anestésicos» también bloquea', () => {
      const r = summarizeAnesthesiaDose({
        lines: [{ anesthetic: MEPI, carpules: 1 }],
        weightKg: 70,
        anamnesis: { allergens: [], anestheticAllergyFlag: true },
      });
      expect(r.alerts.map((a) => a.code)).toEqual(['ALLERGY_ANESTHETIC_FLAG']);
    });

    it('sin anamnesis: aviso informativo', () => {
      const r = summarizeAnesthesiaDose({
        lines: [{ anesthetic: MEPI, carpules: 1 }],
        weightKg: 70,
        anamnesis: NO_ANAMNESIS,
      });
      expect(r.alerts.map((a) => [a.code, a.severity])).toEqual([
        ['NO_ANAMNESIS', 'INFO'],
      ]);
    });
  });

  it('sin líneas: 0 mg y 0 %', () => {
    const r = summarizeAnesthesiaDose({
      lines: [],
      weightKg: 20,
      anamnesis: CLEAN,
    });
    expect([r.totalMg, r.percent, r.level, r.alerts]).toEqual([0, 0, 'OK', []]);
  });
});
