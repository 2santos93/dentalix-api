import {
  ANESTHESIA_DOSE_RULES_VERSION,
  type AnestheticSnapshot,
  hasBlockingDoseAlerts,
  isValidCarpules,
  lineMg,
  maxDoseMg,
  summarizeAnesthesiaDose,
} from './anesthesia-dose';
import { SAMPLE_ANESTHETICS } from './sample-anesthetics';
import { NO_ADJUSTMENT as NO_ADJ } from './anesthesia-limits';

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
        // DX-420: 14 × 0,018 = 0,252 mg de epinefrina, sobre 0,2 mg.
        ['EPINEPHRINE_OVER_MAX', 'BLOCKING'],
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

describe('máximos pediátricos, edad mínima, sedación y epinefrina (DX-420)', () => {
  const ADULT = {
    ageYears: 40,
    ageMonths: 480,
    sedation: false,
    cardiac: false,
  };
  const CHILD = {
    ageYears: 8,
    ageMonths: 100,
    sedation: false,
    cardiac: false,
  };
  const codes = (s: { alerts: { code: string }[] }) =>
    s.alerts.map((a) => a.code);

  it('el catálogo de ejemplo trae los valores pediátricos, la edad mínima y la epinefrina', () => {
    expect(
      [LIDO, ARTI, MEPI, PRILO, BUPI].map((a) => [
        a.pediatricMaxMgPerKg,
        a.minAgeYears,
        a.epinephrineMgPerCarpule,
      ]),
    ).toEqual([
      [4.4, null, 0.018],
      [null, 4, 0.017],
      [4.4, null, 0],
      [null, null, 0],
      [null, 12, 0.009],
    ]);
  });

  it('niño de 20 kg con lidocaína: máximo 4,4 mg/kg = 88 mg, con la fuente AAPD', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 20,
      anamnesis: CLEAN,
      patient: CHILD,
      pending: LIDO,
    });
    expect(s.rulesVersion).toBe('ANESTHESIA_DOSE_V3');
    expect(s.byAnesthetic[0]).toEqual(
      expect.objectContaining({
        maxMg: 88,
        maxMgPerKg: 4.4,
        percent: 41,
      }),
    );
    expect(s.byAnesthetic[0].maxSource).toContain('AAPD');
    expect(s.adjustment).toEqual(
      expect.objectContaining({ pediatric: true, factor: 1 }),
    );
    const pediatric = s.alerts.find((a) => a.code === 'PEDIATRIC_MAX');
    expect(pediatric?.severity).toBe('INFO');
    expect(pediatric?.source).toContain('AAPD');
    expect(pediatric?.message).toContain('4,4 mg/kg');
  });

  it('un adulto de 70 kg con lidocaína sigue con 7 mg/kg (490 mg)', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: ADULT,
    });
    expect(s.byAnesthetic[0].maxMg).toBe(490);
    expect(codes(s)).not.toContain('PEDIATRIC_MAX');
  });

  it('sin valor pediátrico en el catálogo (articaína) se usa el de adulto', () => {
    expect(maxDoseMg(ARTI, 20, { ...NO_ADJ, pediatric: true })).toBe(140);
  });

  it('articaína en menor de 4 años y bupivacaína en menor de 12: aviso bloqueante', () => {
    const arti = summarizeAnesthesiaDose({
      lines: [{ anesthetic: ARTI, carpules: 0.5 }],
      weightKg: 14,
      anamnesis: CLEAN,
      patient: { ...CHILD, ageYears: 3, ageMonths: 40 },
      pending: ARTI,
    });
    const alert = arti.alerts.find((a) => a.code === 'AGE_BELOW_MINIMUM');
    expect(alert?.severity).toBe('BLOCKING');
    expect(alert?.source).toContain('AAPD');
    expect(alert?.message).toContain('menores de 4 años');
    expect(hasBlockingDoseAlerts(arti.alerts)).toBe(true);

    const bupi = summarizeAnesthesiaDose({
      lines: [{ anesthetic: BUPI, carpules: 1 }],
      weightKg: 40,
      anamnesis: CLEAN,
      patient: { ...CHILD, ageYears: 11 },
      pending: BUPI,
    });
    expect(codes(bupi)).toContain('AGE_BELOW_MINIMUM');
    // A los 12 cumplidos ya no.
    const bupi12 = summarizeAnesthesiaDose({
      lines: [{ anesthetic: BUPI, carpules: 1 }],
      weightKg: 40,
      anamnesis: CLEAN,
      patient: { ...CHILD, ageYears: 12, ageMonths: 150 },
      pending: BUPI,
    });
    expect(codes(bupi12)).not.toContain('AGE_BELOW_MINIMUM');
  });

  it('la edad mínima solo mira la dosis nueva, no lo ya registrado con su motivo', () => {
    const s = summarizeAnesthesiaDose({
      lines: [
        { anesthetic: ARTI, carpules: 0.5 },
        { anesthetic: LIDO, carpules: 0.5 },
      ],
      weightKg: 14,
      anamnesis: CLEAN,
      patient: { ...CHILD, ageYears: 3, ageMonths: 40 },
      pending: LIDO,
    });
    expect(codes(s)).not.toContain('AGE_BELOW_MINIMUM');
  });

  it('sin fecha de nacimiento: máximos de adulto y aviso explícito, sin bloquear', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: ARTI, carpules: 1 }],
      weightKg: 20,
      anamnesis: CLEAN,
      patient: { ...ADULT, ageYears: null, ageMonths: null },
      pending: ARTI,
    });
    const alert = s.alerts.find((a) => a.code === 'AGE_UNKNOWN');
    expect(alert?.severity).toBe('INFO');
    expect(alert?.message).toContain('fecha de nacimiento');
    expect(hasBlockingDoseAlerts(s.alerts)).toBe(false);
  });

  it('con sedación el máximo baja un 30 % y se dice por qué', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 20,
      anamnesis: CLEAN,
      patient: { ...CHILD, sedation: true },
      pending: LIDO,
    });
    // 4,4 × 20 = 88 → × 0,7 = 61,6 mg.
    expect(s.byAnesthetic[0].maxMg).toBe(61.6);
    expect(s.percent).toBe(58);
    const alert = s.alerts.find((a) => a.code === 'DOSE_REDUCED_SEDATION');
    expect(alert?.message).toContain('30 %');
    expect(alert?.message).toContain('sedación');
  });

  it('menor de 6 meses: −30 %; también baja el tope absoluto sin peso', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 0.25 }],
      weightKg: 6,
      anamnesis: CLEAN,
      patient: { ...CHILD, ageYears: 0, ageMonths: 4 },
      pending: LIDO,
    });
    // 4,4 × 6 = 26,4 → × 0,7 = 18,5 mg.
    expect(s.byAnesthetic[0].maxMg).toBe(18.5);
    expect(codes(s)).toContain('DOSE_REDUCED_INFANT');
    expect(maxDoseMg(LIDO, null, { ...NO_ADJ, factor: 0.7 })).toBeNull();
  });

  it('epinefrina acumulada en mg contra 0,2 mg en el adulto sano', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 3 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: ADULT,
      pending: LIDO,
    });
    expect(s.epinephrine).toEqual({
      totalMg: 0.054,
      maxMg: 0.2,
      percent: 27,
      cardiac: false,
      level: 'OK',
    });
  });

  it('cardiópata: tope 0,04 mg; 3 carpules 1:100.000 (0,054 mg) exigen motivo', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 3 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: { ...ADULT, cardiac: true },
      pending: LIDO,
    });
    expect(s.epinephrine).toEqual(
      expect.objectContaining({
        totalMg: 0.054,
        maxMg: 0.04,
        level: 'EXCEEDED',
        cardiac: true,
      }),
    );
    const alert = s.alerts.find((a) => a.code === 'EPINEPHRINE_OVER_MAX');
    expect(alert?.severity).toBe('BLOCKING');
    expect(alert?.message).toContain('0,054 mg');
    expect(alert?.message).toContain('cardiopatía');
    // El anestésico va bien (162 de 490 mg): bloquea solo la epinefrina.
    expect(s.level).toBe('OK');
    expect(hasBlockingDoseAlerts(s.alerts)).toBe(true);
  });

  it('cardiópata con 2 carpules (0,036 mg): aviso al 80 %, sin motivo', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 2 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: { ...ADULT, cardiac: true },
    });
    expect(s.epinephrine.level).toBe('WARNING');
    expect(codes(s)).toContain('EPINEPHRINE_NEAR_MAX');
    expect(hasBlockingDoseAlerts(s.alerts)).toBe(false);
  });

  it('sin anamnesis: tope de adulto sano y aviso de que no se ha comprobado la cardiopatía', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 70,
      anamnesis: NO_ANAMNESIS,
      patient: { ...ADULT, cardiac: null },
    });
    expect(s.epinephrine.maxMg).toBe(0.2);
    expect(codes(s)).toContain('EPINEPHRINE_CARDIAC_UNKNOWN');
  });

  it('epinefrina sin mg por carpule en el catálogo: se deduce del texto o se avisa', () => {
    const legacy = { ...LIDO, epinephrineMgPerCarpule: undefined };
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: legacy, carpules: 1 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: ADULT,
    });
    expect(s.epinephrine.totalMg).toBe(0.018);
    const unknown = {
      ...LIDO,
      vasoconstrictor: 'Con epinefrina',
      epinephrineMgPerCarpule: null,
    };
    const u = summarizeAnesthesiaDose({
      lines: [{ anesthetic: unknown, carpules: 1 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: ADULT,
    });
    expect(codes(u)).toContain('EPINEPHRINE_UNKNOWN');
  });

  it('quedan X mg ≈ Y carpules del anestésico nuevo, en cuartos hacia abajo', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 20,
      anamnesis: CLEAN,
      patient: CHILD,
      pending: LIDO,
    });
    // 88 − 36 = 52 mg; 52 / 36 = 1,44 → 1,25 carpules de 1,8 ml.
    expect(s.remaining).toEqual({
      name: LIDO.name,
      mg: 52,
      carpules: 1.25,
      mlPerCarpule: 1.8,
      limitedBy: 'DOSE',
      epinephrineMg: 0.182,
    });
  });

  it('en el cardiópata lo que queda lo limita la epinefrina', () => {
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: { ...ADULT, cardiac: true },
      pending: LIDO,
    });
    // Epinefrina: 0,04 − 0,018 = 0,022 mg → 1,22 carpules → 1.
    expect(s.remaining).toEqual(
      expect.objectContaining({
        mg: 44,
        carpules: 1,
        limitedBy: 'EPINEPHRINE',
        epinephrineMg: 0.022,
      }),
    );
  });

  it('superado el máximo quedan 0; sin peso no hay «quedan»', () => {
    const over = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 3 }],
      weightKg: 20,
      anamnesis: CLEAN,
      patient: CHILD,
      pending: LIDO,
    });
    expect(over.remaining).toEqual(
      expect.objectContaining({ mg: 0, carpules: 0 }),
    );
    const noWeight = summarizeAnesthesiaDose({
      lines: [{ anesthetic: LIDO, carpules: 1 }],
      weightKg: null,
      anamnesis: CLEAN,
      patient: CHILD,
      pending: LIDO,
    });
    expect(noWeight.remaining).toBeNull();
  });

  it('«quedan» no ofrece la dosis que llega justo al 100 % (exige motivo)', () => {
    // Prilocaína sin epinefrina, adulto de 63 kg: 8 × 63 = 504 mg = 7
    // carpules exactos de 72 mg.
    const s = summarizeAnesthesiaDose({
      lines: [{ anesthetic: PRILO, carpules: 0.25 }],
      weightKg: 63,
      anamnesis: CLEAN,
      patient: ADULT,
      pending: PRILO,
    });
    // 504 − 18 = 486 mg = 6,75 carpules exactos → 6,5 (6,75 ya sería el 100 %).
    expect(s.remaining).toEqual(
      expect.objectContaining({ mg: 486, carpules: 6.5, limitedBy: 'DOSE' }),
    );
    const at100 = summarizeAnesthesiaDose({
      lines: [{ anesthetic: PRILO, carpules: 7 }],
      weightKg: 63,
      anamnesis: CLEAN,
      patient: ADULT,
    });
    expect(at100.level).toBe('EXCEEDED');
  });

  it('la epinefrina se suma línea a línea aunque el grupo sea el mismo anestésico', () => {
    // Un registro con la dilución sin leer (null) y otro ya corregido en el
    // catálogo (0,018): mismo grupo de dosis, epinefrina distinta.
    const unknown = {
      ...LIDO,
      vasoconstrictor: 'Con epinefrina',
      epinephrineMgPerCarpule: null,
    };
    const fixed = { ...unknown, epinephrineMgPerCarpule: 0.018 };
    const s = summarizeAnesthesiaDose({
      lines: [
        { anesthetic: unknown, carpules: 1 },
        { anesthetic: fixed, carpules: 2 },
        { anesthetic: unknown, carpules: 1 },
      ],
      weightKg: 70,
      anamnesis: CLEAN,
      patient: ADULT,
    });
    expect(s.byAnesthetic).toHaveLength(1);
    expect(s.epinephrine.totalMg).toBe(0.036);
    expect(codes(s).filter((c) => c === 'EPINEPHRINE_UNKNOWN')).toHaveLength(1);
  });
});
