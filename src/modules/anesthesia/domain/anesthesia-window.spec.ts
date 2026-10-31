import { summarizeAnesthesiaDose } from './anesthesia-dose';
import {
  ANESTHESIA_DOSE_WINDOW_HOURS,
  doseWindowAround,
  doseWindowBreakdown,
  isInDoseWindow,
  worstDoseWindow,
  type WindowAdministration,
} from './anesthesia-window';
import { SAMPLE_ANESTHETICS } from './sample-anesthetics';

const LIDO = SAMPLE_ANESTHETICS.find(
  (a) => a.sampleCode === 'LIDOCAINE_2_EPI',
)!;
const E1 = 'e1';
const E2 = 'e2';
const HOUR = 3_600_000;
const AT = new Date('2026-10-30T15:00:00.000Z');

function record(
  overrides: Partial<WindowAdministration> & { carpules: number },
): WindowAdministration {
  return {
    id: `r-${Math.random()}`,
    patientId: 'p',
    clinicalEntryId: E1,
    locationId: 'sede-centro',
    locationName: 'Centro',
    anestheticId: 'lido',
    anestheticName: LIDO.name,
    activeIngredient: LIDO.activeIngredient,
    concentrationPct: LIDO.concentrationPct,
    vasoconstrictor: LIDO.vasoconstrictor,
    mlPerCarpule: LIDO.mlPerCarpule,
    maxMgPerKg: LIDO.maxMgPerKg,
    maxAbsoluteMg: LIDO.maxAbsoluteMg,
    pediatricMaxMgPerKg: null,
    minAgeYears: null,
    epinephrineMgPerCarpule: null,
    epinephrineMg: null,
    cumulativeEpinephrineMg: null,
    doseMg: overrides.carpules * 36,
    technique: 'INFILTRATION',
    site: null,
    lot: null,
    administeredAt: AT,
    weightKg: 20,
    weightSource: 'ENTERED',
    cumulativeMg: 0,
    cumulativePercent: null,
    safetyRulesVersion: 'ANESTHESIA_DOSE_V2',
    safetyAlerts: [],
    overrideReason: null,
    authorId: 'dra-ana',
    authorName: 'Dra. Ana',
    createdAt: AT,
    ...overrides,
  };
}

describe('ventana del acumulado del paciente (DX-418)', () => {
  it('lee 24 h a cada lado de la administración, cerrado: [desde, hasta]', () => {
    expect(ANESTHESIA_DOSE_WINDOW_HOURS).toBe(24);
    const w = doseWindowAround(AT);
    expect(w.from.toISOString()).toBe('2026-10-29T15:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-10-31T15:00:00.000Z');
    expect(isInDoseWindow(new Date(AT.getTime() - 23.9 * HOUR), w)).toBe(true);
    expect(isInDoseWindow(w.from, w)).toBe(true);
    expect(isInDoseWindow(w.to, w)).toBe(true);
    expect(isInDoseWindow(new Date(w.to.getTime() + 1), w)).toBe(false);
    expect(isInDoseWindow(new Date(AT.getTime() - 25 * HOUR), w)).toBe(false);
    // No es el día civil: las 23:30 y las 00:30 cuentan juntas.
    const lateNight = new Date('2026-10-30T23:30:00-05:00');
    expect(
      isInDoseWindow(
        new Date('2026-10-31T00:30:00-05:00'),
        doseWindowAround(lateNight),
      ),
    ).toBe(true);
  });

  it('peor ventana de 24 h que contiene la hora: la que acaba en ella o en una dosis posterior, nunca 48 h', () => {
    const at = AT;
    const before = record({
      carpules: 2,
      administeredAt: new Date(at.getTime() - 20 * HOUR),
    });
    const after = record({
      carpules: 2,
      administeredAt: new Date(at.getTime() + 10 * HOUR),
    });
    // Sin nada después: las 24 h que acaban en la hora.
    expect(worstDoseWindow(at, [before], 20)).toEqual({
      from: new Date(at.getTime() - 24 * HOUR),
      to: at,
    });
    // Con más carga en la que acaba en la dosis posterior, esa (tiene las dos).
    const near = record({
      carpules: 2,
      administeredAt: new Date(at.getTime() - 10 * HOUR),
    });
    expect(worstDoseWindow(at, [near, after], 20)).toEqual({
      from: new Date(at.getTime() - 14 * HOUR),
      to: new Date(at.getTime() + 10 * HOUR),
    });
    // A más de 24 h entre sí: ninguna ventana tiene las dos; a igualdad, la
    // que acaba en la hora.
    const far = record({
      carpules: 2,
      administeredAt: new Date(at.getTime() + 23 * HOUR),
    });
    const w = worstDoseWindow(at, [before, far], 20);
    expect(w.to).toEqual(at);
    // Sin peso decide por mg.
    const big = record({
      carpules: 3,
      administeredAt: new Date(at.getTime() + 23 * HOUR),
    });
    expect(worstDoseWindow(at, [before, big], null).to).toEqual(
      big.administeredAt,
    );
  });

  it('criterio: 20 kg, 3 carpules de lidocaína en E1 y 3 en E2 → 216 mg, 154 %, bloqueante', () => {
    const lines = [3, 3].map((carpules) => ({ anesthetic: LIDO, carpules }));
    const summary = summarizeAnesthesiaDose({
      lines,
      weightKg: 20,
      anamnesis: { allergens: [], anestheticAllergyFlag: false },
    });
    expect(summary.totalMg).toBe(216);
    expect(summary.percent).toBe(154);
    expect(summary.level).toBe('EXCEEDED');
    expect(summary.alerts.map((a) => a.code)).toEqual(['DOSE_OVER_MAX']);
  });

  it('desglosa por evolución y profesional, en orden de administración', () => {
    const parts = doseWindowBreakdown(
      [
        record({
          clinicalEntryId: E2,
          carpules: 1,
          authorId: 'dr-luis',
          authorName: 'Dr. Luis',
          locationId: 'sede-norte',
          locationName: 'Norte',
          administeredAt: new Date(AT.getTime() + HOUR),
        }),
        record({ carpules: 2 }),
        record({
          carpules: 1,
          administeredAt: new Date(AT.getTime() + 0.5 * HOUR),
        }),
        record({
          clinicalEntryId: E2,
          carpules: 0.5,
          authorId: 'dra-ana',
          administeredAt: new Date(AT.getTime() + 2 * HOUR),
        }),
      ],
      20,
      E2,
    );
    expect(
      parts.map((p) => [
        p.clinicalEntryId,
        p.authorName,
        p.locationName,
        p.current,
        p.carpules,
        p.mg,
        p.percent,
      ]),
    ).toEqual([
      [E1, 'Dra. Ana', 'Centro', false, 3, 108, 77],
      [E2, 'Dr. Luis', 'Norte', true, 1, 36, 26],
      [E2, 'Dra. Ana', 'Centro', true, 0.5, 18, 13],
    ]);
    expect(parts[0].firstAdministeredAt).toEqual(AT);
    expect(parts[0].lastAdministeredAt).toEqual(
      new Date(AT.getTime() + 0.5 * HOUR),
    );
  });

  it('sin peso: mg sí, % no', () => {
    const [part] = doseWindowBreakdown([record({ carpules: 2 })], null, E1);
    expect(part).toEqual(
      expect.objectContaining({ mg: 72, percent: null, current: true }),
    );
  });
});
