import {
  ageInYears,
  checkPrescriptionSafety,
  emptySafetyAnamnesis,
  hasBlockingAlerts,
  NO_ANAMNESIS_MESSAGE,
  PEDIATRIC_WEIGHT_MISSING_MESSAGE,
  PRESCRIPTION_SAFETY_RULES_VERSION,
  type SafetyAnamnesis,
  type SafetyItem,
} from './prescription-safety';

const amoxicilina: SafetyItem = {
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
};
const ibuprofeno: SafetyItem = {
  activeIngredient: 'Ibuprofeno',
  concentration: '400 mg',
  dose: '1 comprimido',
  frequency: 'Cada 8 horas',
};
const paracetamol: SafetyItem = {
  activeIngredient: 'Paracetamol',
  concentration: '500 mg',
  dose: '1 comprimido',
  frequency: 'Cada 8 horas',
};
const metronidazol: SafetyItem = {
  activeIngredient: 'Metronidazol',
  concentration: '500 mg',
  dose: '1 comprimido',
  frequency: 'Cada 8 horas',
};

type AnamnesisOverrides = Partial<Omit<SafetyAnamnesis, 'flags'>> & {
  flags?: Partial<SafetyAnamnesis['flags']>;
};

function anamnesis(overrides: AnamnesisOverrides = {}): SafetyAnamnesis {
  const base = emptySafetyAnamnesis();
  return {
    ...base,
    ...overrides,
    flags: { ...base.flags, ...(overrides.flags ?? {}) },
  };
}

function check(
  items: SafetyItem[],
  a: SafetyAnamnesis | null = anamnesis(),
  ageYears: number | null = 40,
) {
  return checkPrescriptionSafety({ items, anamnesis: a, ageYears });
}

const codes = (r: ReturnType<typeof check>) => r.alerts.map((a) => a.code);

describe('prescription-safety (DX-300)', () => {
  it('versión de reglas declarada y sin avisos para un adulto sin antecedentes', () => {
    expect(PRESCRIPTION_SAFETY_RULES_VERSION).toMatch(/^[A-Z][A-Z0-9_]+$/);
    const result = check([amoxicilina, ibuprofeno, paracetamol]);
    expect(result.rulesVersion).toBe(PRESCRIPTION_SAFETY_RULES_VERSION);
    expect(result.alerts).toEqual([]);
    expect(result.allergyMatches).toEqual([]);
  });

  describe('ALLERGY: casillas de la anamnesis además de la lista', () => {
    it('«Alergia a penicilina» marcada con la lista vacía: amoxicilina bloquea', () => {
      const result = check(
        [amoxicilina],
        anamnesis({ flags: { alergiaPenicilina: true } }),
      );
      expect(result.alerts).toEqual([
        expect.objectContaining({
          rule: 'ALLERGY',
          code: 'ALLERGY_MATCH',
          severity: 'BLOCKING',
          activeIngredient: 'Amoxicilina',
        }),
      ]);
      expect(result.alerts[0].message).toContain('penicilina');
      expect(result.allergyMatches).toEqual([
        { activeIngredient: 'Amoxicilina', allergen: 'penicilina' },
      ]);
      expect(hasBlockingAlerts(result.alerts)).toBe(true);
    });

    it('«Alergia a anestésico» casa con articaína; «látex» con nada de la receta', () => {
      const result = check(
        [{ activeIngredient: 'Articaína' }, ibuprofeno],
        anamnesis({ flags: { alergiaAnestesico: true, alergiaLatex: true } }),
      );
      expect(result.allergyMatches).toEqual([
        { activeIngredient: 'Articaína', allergen: 'anestésico local' },
      ]);
    });

    it('la lista de alergias sigue contando, sin duplicar con la casilla', () => {
      const result = check(
        [amoxicilina],
        anamnesis({
          allergens: ['Penicilina'],
          flags: { alergiaPenicilina: true },
        }),
      );
      expect(result.alerts).toHaveLength(1);
    });

    it('falso positivo: «sulfato» no es una sulfa', () => {
      const result = check(
        [{ activeIngredient: 'Sulfato ferroso' }],
        anamnesis({ allergens: ['Sulfas'] }),
      );
      expect(result.alerts).toEqual([]);
    });
  });

  describe('INTERACTION', () => {
    it('warfarina en la medicación habitual: ibuprofeno y metronidazol bloquean', () => {
      const result = check(
        [ibuprofeno, metronidazol],
        anamnesis({ medications: ['Warfarina 5 mg'] }),
      );
      expect(codes(result)).toEqual([
        'INTERACTION_ANTICOAGULANT_NSAID',
        'INTERACTION_ANTICOAGULANT_METRONIDAZOLE',
      ]);
      expect(result.alerts.every((a) => a.severity === 'BLOCKING')).toBe(true);
      expect(result.alerts[0].message).toContain('Warfarina');
    });

    it('casilla anticoagulantes sin nombre: también bloquea', () => {
      const result = check(
        [ibuprofeno],
        anamnesis({ flags: { anticoagulantes: true } }),
      );
      expect(codes(result)).toEqual(['INTERACTION_ANTICOAGULANT_NSAID']);
    });

    it('acenocumarol con macrólidos y azoles', () => {
      const result = check(
        [
          { activeIngredient: 'Claritromicina' },
          { activeIngredient: 'Miconazol gel oral' },
        ],
        anamnesis({ medications: ['Sintrom (acenocumarol)'] }),
      );
      expect(codes(result)).toEqual([
        'INTERACTION_ANTICOAGULANT_MACROLIDE',
        'INTERACTION_ANTICOAGULANT_AZOLE',
      ]);
    });

    it('metotrexato con AINE', () => {
      const result = check(
        [ibuprofeno],
        anamnesis({ medications: ['Metotrexato semanal'] }),
      );
      expect(codes(result)).toEqual(['INTERACTION_METHOTREXATE_NSAID']);
    });

    it('falso positivo: paracetamol con warfarina no es una interacción bloqueante', () => {
      const result = check(
        [paracetamol, amoxicilina],
        anamnesis({ medications: ['Warfarina'] }),
      );
      expect(result.alerts).toEqual([]);
    });
  });

  describe('PREGNANCY', () => {
    const pregnant = (semanasEmbarazo: number | null) =>
      anamnesis({ flags: { embarazo: true, semanasEmbarazo } });

    it('24 semanas: un AINE bloquea; paracetamol no', () => {
      expect(codes(check([ibuprofeno], pregnant(24)))).toEqual([
        'PREGNANCY_NSAID',
      ]);
      expect(check([ibuprofeno], pregnant(24)).alerts[0].severity).toBe(
        'BLOCKING',
      );
      expect(check([paracetamol], pregnant(24)).alerts).toEqual([]);
    });

    it('sin semanas: el AINE bloquea igualmente', () => {
      expect(codes(check([ibuprofeno], pregnant(null)))).toEqual([
        'PREGNANCY_NSAID',
      ]);
    });

    it('antes de la semana 20: el AINE solo informa', () => {
      const result = check([ibuprofeno], pregnant(12));
      expect(result.alerts).toEqual([
        expect.objectContaining({
          code: 'PREGNANCY_NSAID_EARLY',
          severity: 'INFO',
        }),
      ]);
    });

    it('tetraciclinas siempre; metronidazol solo en el 1.er trimestre', () => {
      expect(
        codes(check([{ activeIngredient: 'Doxiciclina' }], pregnant(30))),
      ).toEqual(['PREGNANCY_TETRACYCLINE']);
      expect(codes(check([metronidazol], pregnant(8)))).toEqual([
        'PREGNANCY_METRONIDAZOLE_FIRST_TRIMESTER',
      ]);
      expect(check([metronidazol], pregnant(20)).alerts).toEqual([]);
    });
  });

  it('ANTIRESORPTIVE: bifosfonatos da un aviso informativo (uno por receta)', () => {
    const result = check(
      [amoxicilina, paracetamol],
      anamnesis({ flags: { bifosfonatos: true } }),
    );
    expect(result.alerts).toEqual([
      expect.objectContaining({
        rule: 'ANTIRESORPTIVE',
        severity: 'INFO',
        activeIngredient: null,
      }),
    ]);
    expect(hasBlockingAlerts(result.alerts)).toBe(false);
  });

  describe('PEDIATRIC_DOSE (< 12 años)', () => {
    const child = (weightKg: number | null) => anamnesis({ weightKg });
    const amox1g: SafetyItem = {
      activeIngredient: 'Amoxicilina',
      concentration: '1 g',
      dose: '1 g',
      frequency: 'Cada 8 horas',
    };

    it('6 años y 20 kg con amoxicilina 1 g/8 h: supera el tope (50 mg/kg/toma)', () => {
      const result = check([amox1g], child(20), 6);
      expect(result.alerts).toEqual([
        expect.objectContaining({
          rule: 'PEDIATRIC_DOSE',
          code: 'PEDIATRIC_DOSE_EXCEEDED',
          severity: 'BLOCKING',
        }),
      ]);
      expect(result.alerts[0].message).toContain('50 mg/kg/toma');
      expect(result.alerts[0].message).toContain('supera el tope');
    });

    it('dosis correcta: 250 mg/5 ml, 5 ml cada 8 h para 20 kg no avisa', () => {
      const result = check(
        [
          {
            activeIngredient: 'Amoxicilina',
            concentration: '250 mg/5 ml',
            dose: '5 ml',
            frequency: 'Cada 8 horas',
          },
        ],
        child(20),
        6,
      );
      expect(result.alerts).toEqual([]);
    });

    it('supera el tope diario aunque la toma valga (paracetamol cada 4 h)', () => {
      const result = check(
        [
          {
            activeIngredient: 'Paracetamol',
            concentration: '100 mg/ml',
            dose: '3 ml',
            frequency: 'Cada 4 horas',
          },
        ],
        child(20),
        6,
      );
      // 300 mg = 15 mg/kg/toma (vale); 6 tomas = 90 mg/kg/día (> 60).
      expect(codes(result)).toEqual(['PEDIATRIC_DOSE_EXCEEDED']);
      expect(result.alerts[0].message).toContain('90 mg/kg/día');
    });

    it('sin peso: pide el peso', () => {
      const result = check([ibuprofeno], child(null), 6);
      expect(result.alerts).toEqual([
        expect.objectContaining({
          code: 'PEDIATRIC_WEIGHT_MISSING',
          message: expect.stringContaining(
            PEDIATRIC_WEIGHT_MISSING_MESSAGE,
          ) as string,
        }),
      ]);
    });

    it('sin anamnesis tampoco hay peso: avisa de las dos cosas', () => {
      expect(codes(check([ibuprofeno], null, 6))).toEqual([
        'NO_ANAMNESIS',
        'PEDIATRIC_WEIGHT_MISSING',
      ]);
    });

    it('dosis ilegible: lo dice en vez de callar', () => {
      const result = check(
        [{ activeIngredient: 'Ibuprofeno', dose: 'según pauta' }],
        child(20),
        6,
      );
      expect(codes(result)).toEqual(['PEDIATRIC_DOSE_UNREADABLE']);
    });

    it('un adulto o un niño de 12 no tiene aviso de dosis; otros fármacos tampoco', () => {
      expect(check([amox1g], child(20), 40).alerts).toEqual([]);
      expect(check([amox1g], child(40), 12).alerts).toEqual([]);
      expect(
        check([{ activeIngredient: 'Clorhexidina' }], child(null), 6).alerts,
      ).toEqual([]);
    });
  });

  it('NO_ANAMNESIS: informa con el texto exacto', () => {
    const result = check([amoxicilina], null);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        rule: 'NO_ANAMNESIS',
        severity: 'INFO',
        message: NO_ANAMNESIS_MESSAGE,
      }),
    ]);
    expect(NO_ANAMNESIS_MESSAGE).toBe(
      'Sin anamnesis vigente: no se han podido comprobar alergias ni interacciones',
    );
  });

  it('cada aviso trae fuente y texto en español; ingredientes vacíos se ignoran', () => {
    const result = check(
      [{ activeIngredient: '  ' }, ibuprofeno],
      anamnesis({ medications: ['Warfarina'] }),
    );
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].source).toMatch(/SDCEP/);
  });

  it('ageInYears cuenta cumpleaños por día civil', () => {
    const birth = new Date('2020-10-24T00:00:00.000Z');
    expect(ageInYears(birth, '2026-10-23')).toBe(5);
    expect(ageInYears(birth, '2026-10-24')).toBe(6);
  });
});
