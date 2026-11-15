import {
  computeOnboardingStatus,
  ONBOARDING_STEP_KEYS,
  type OnboardingFacts,
  type OnboardingStepKey,
} from './onboarding-steps';

function facts(
  done: Partial<Record<OnboardingStepKey, boolean>> = {},
  dismissedAt: Date | null = null,
): OnboardingFacts {
  const all = Object.fromEntries(
    ONBOARDING_STEP_KEYS.map((k) => [k, done[k] ?? false]),
  ) as Record<OnboardingStepKey, boolean>;
  return { dismissedAt, done: all };
}

describe('computeOnboardingStatus (DX-020)', () => {
  it('una clínica nueva: los 5 obligatorios pendientes, en orden, y el opcional al final', () => {
    const status = computeOnboardingStatus(facts());
    expect(status.steps.map((s) => [s.key, s.done, s.optional])).toEqual([
      ['BUSINESS_HOURS', false, false],
      ['APPOINTMENT_TYPES', false, false],
      ['CATALOG_PRICES', false, false],
      ['STAFF', false, false],
      ['FIRST_APPOINTMENT', false, false],
      ['PATIENT_IMPORT', false, true],
    ]);
    expect(status.completedCount).toBe(0);
    expect(status.requiredCount).toBe(5);
    expect(status.allDone).toBe(false);
    expect(status.dismissedAt).toBeNull();
  });

  it('cuenta solo los obligatorios hechos', () => {
    const status = computeOnboardingStatus(
      facts({ APPOINTMENT_TYPES: true, STAFF: true }),
    );
    expect(status.completedCount).toBe(2);
    expect(status.steps.find((s) => s.key === 'STAFF')?.done).toBe(true);
    expect(status.allDone).toBe(false);
  });

  it('el opcional no cuenta para «listo» ni lo impide', () => {
    expect(
      computeOnboardingStatus(facts({ PATIENT_IMPORT: true })).completedCount,
    ).toBe(0);
    const ready = computeOnboardingStatus(
      facts({
        BUSINESS_HOURS: true,
        APPOINTMENT_TYPES: true,
        CATALOG_PRICES: true,
        STAFF: true,
        FIRST_APPOINTMENT: true,
      }),
    );
    expect(ready.completedCount).toBe(5);
    expect(ready.allDone).toBe(true);
    expect(ready.steps.find((s) => s.key === 'PATIENT_IMPORT')?.done).toBe(
      false,
    );
  });

  it('devuelve la fecha de descarte tal cual', () => {
    const at = new Date('2026-12-26T12:00:00Z');
    expect(computeOnboardingStatus(facts({}, at)).dismissedAt).toBe(at);
  });
});
