import {
  ageInMonths,
  doseAdjustment,
  EPINEPHRINE_CARDIAC_MAX_MG,
  EPINEPHRINE_MAX_MG,
  epinephrineFromLabel,
  epinephrineMaxMg,
  hasCardiacCondition,
} from './anesthesia-limits';

const PATIENT = {
  ageYears: 30,
  ageMonths: 360,
  sedation: false,
  cardiac: false,
};

describe('límites de la anestesia por paciente (DX-420)', () => {
  it('pediátrico = menor de 12 años cumplidos; sin edad no se presume', () => {
    expect(doseAdjustment({ ...PATIENT, ageYears: 11 }).pediatric).toBe(true);
    expect(doseAdjustment({ ...PATIENT, ageYears: 12 }).pediatric).toBe(false);
    expect(
      doseAdjustment({ ...PATIENT, ageYears: null, ageMonths: null }),
    ).toEqual({ pediatric: false, infant: false, sedation: false, factor: 1 });
  });

  it('−30 % en menores de 6 meses y con sedación; las dos se multiplican', () => {
    expect(doseAdjustment({ ...PATIENT, ageYears: 0, ageMonths: 5 })).toEqual({
      pediatric: true,
      infant: true,
      sedation: false,
      factor: 0.7,
    });
    expect(
      doseAdjustment({ ...PATIENT, ageYears: 0, ageMonths: 6 }).infant,
    ).toBe(false);
    expect(doseAdjustment({ ...PATIENT, sedation: true }).factor).toBe(0.7);
    expect(
      doseAdjustment({ ...PATIENT, ageYears: 0, ageMonths: 3, sedation: true })
        .factor,
    ).toBeCloseTo(0.49, 10);
  });

  it('meses cumplidos el día civil de la sede', () => {
    const birth = new Date('2026-05-15T00:00:00.000Z');
    expect(ageInMonths(birth, '2026-11-14')).toBe(5);
    expect(ageInMonths(birth, '2026-11-15')).toBe(6);
    expect(ageInMonths(null, '2026-11-15')).toBeNull();
    expect(
      ageInMonths(new Date('2027-01-01T00:00:00.000Z'), '2026-11-15'),
    ).toBe(null);
  });

  it('epinefrina por carpule = ml × 1000 / dilución (1:100.000 → 0,01 mg/ml)', () => {
    expect(epinephrineFromLabel('Epinefrina 1:100.000', 1.8)).toBe(0.018);
    expect(epinephrineFromLabel('Epinefrina 1:100.000', 1.7)).toBe(0.017);
    expect(epinephrineFromLabel('epinefrina 1:200.000', 1.8)).toBe(0.009);
    expect(epinephrineFromLabel('Adrenalina 1:80000', 1.8)).toBe(0.0225);
    expect(epinephrineFromLabel('Epinefrina 1:50 000', 1.7)).toBe(0.034);
  });

  it('sin vasoconstrictor o con otro (felipresina) no hay epinefrina; sin dilución, desconocida', () => {
    expect(epinephrineFromLabel(null, 1.8)).toBe(0);
    expect(epinephrineFromLabel('Felipresina 0,03 UI/ml', 1.8)).toBe(0);
    expect(epinephrineFromLabel('Noradrenalina 1:25.000', 1.8)).toBe(0);
    expect(epinephrineFromLabel('Con epinefrina', 1.8)).toBeNull();
    // Más de 0,2 mg en un carpule no es una dilución real («1:1000»).
    expect(epinephrineFromLabel('Epinefrina 1:1000', 1.8)).toBeNull();
    expect(epinephrineFromLabel('Epinefrina 1:9000', 1.8)).toBe(0.2);
  });

  it('tope de epinefrina por cita: 0,2 mg; 0,04 mg en el cardiópata', () => {
    expect(epinephrineMaxMg(false)).toBe(EPINEPHRINE_MAX_MG);
    expect(epinephrineMaxMg(null)).toBe(0.2);
    expect(epinephrineMaxMg(true)).toBe(EPINEPHRINE_CARDIAC_MAX_MG);
    expect(EPINEPHRINE_CARDIAC_MAX_MG).toBe(0.04);
  });

  it('cardiopatía: condición cardiovascular marcada «Sí» en la anamnesis', () => {
    expect(hasCardiacCondition([{ codigo: 'CARDIOPATIA', estado: 'SI' }])).toBe(
      true,
    );
    expect(
      hasCardiacCondition([{ codigo: 'HIPERTENSION', estado: 'SI' }]),
    ).toBe(true);
    expect(
      hasCardiacCondition([{ codigo: 'VALVULOPATIA', estado: 'SI' }]),
    ).toBe(true);
    expect(hasCardiacCondition([{ codigo: 'CARDIOPATIA', estado: 'NO' }])).toBe(
      false,
    );
    expect(hasCardiacCondition([{ codigo: 'DIABETES', estado: 'SI' }])).toBe(
      false,
    );
    expect(hasCardiacCondition([])).toBe(false);
  });
});
