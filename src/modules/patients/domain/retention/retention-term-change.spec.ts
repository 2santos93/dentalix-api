import {
  CORRECTION_WINDOW_MS,
  effectiveRetentionYears,
  openCorrectionWindow,
  planRetentionTermChange,
  retentionTermAuditSpec,
  type RetentionTermPlan,
  type StoredRetentionTerm,
} from './retention-term-change';

const T = new Date('2026-11-01T10:00:00.000Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const TENANT = '0192f0a0-0000-7000-8000-000000000001';

const plain = (years: number): StoredRetentionTerm => ({
  years,
  raisedAt: null,
  yearsBeforeRaise: null,
});
const raised = (years: number, before: number): StoredRetentionTerm => ({
  years,
  raisedAt: T,
  yearsBeforeRaise: before,
});
const change = (plan: RetentionTermPlan) => {
  if (plan.kind !== 'CHANGE') throw new Error('expected CHANGE');
  return plan;
};

describe('effectiveRetentionYears', () => {
  it('never goes below the platform minimum', () => {
    expect(effectiveRetentionYears(15, 20)).toBe(20);
    expect(effectiveRetentionYears(25, 20)).toBe(25);
  });
});

describe('openCorrectionWindow', () => {
  it('24 hours is a millisecond boundary', () => {
    expect(CORRECTION_WINDOW_MS).toBe(86_400_000);
    const stored = raised(30, 20);
    expect(openCorrectionWindow(stored, at(86_399_999))).toEqual({
      previousYears: 20,
      until: at(86_400_000),
    });
    expect(openCorrectionWindow(stored, at(86_400_000))).toBeNull();
  });

  it('fails closed on an invalid date', () => {
    expect(openCorrectionWindow(raised(30, 20), new Date('nope'))).toBeNull();
    expect(
      openCorrectionWindow(
        { years: 30, raisedAt: new Date('nope'), yearsBeforeRaise: 20 },
        T,
      ),
    ).toBeNull();
  });

  it('is closed without a raise', () => {
    expect(openCorrectionWindow(plain(30), T)).toBeNull();
  });
});

describe('planRetentionTermChange', () => {
  it('the same stored value is no change', () => {
    expect(planRetentionTermChange(plain(20), 20, 15, T)).toEqual({
      kind: 'UNCHANGED',
    });
  });

  it('stored 15 with minimum 20 saving 20 is UP without moving the effective term', () => {
    const plan = change(planRetentionTermChange(plain(15), 20, 20, T));
    expect(plan.direction).toBe('UP');
    expect(plan.effectiveBefore).toBe(20);
    expect(plan.effectiveAfter).toBe(20);
    expect(plan.nextWindow).toEqual({ raisedAt: null, yearsBeforeRaise: null });
    const open = change(
      planRetentionTermChange(raised(15, 15), 20, 20, at(HOUR)),
    );
    expect(open.nextWindow).toEqual({ raisedAt: T, yearsBeforeRaise: 15 });
  });

  it('a raise opens a window from the previous effective term', () => {
    const plan = change(planRetentionTermChange(plain(20), 30, 15, T));
    expect(plan.direction).toBe('UP');
    expect(plan.nextWindow).toEqual({ raisedAt: T, yearsBeforeRaise: 20 });
    const floored = change(planRetentionTermChange(plain(15), 30, 20, T));
    expect(floored.nextWindow.yearsBeforeRaise).toBe(20);
  });

  it('a chained raise does not move an open window', () => {
    const plan = change(
      planRetentionTermChange(raised(30, 20), 40, 15, at(23 * HOUR)),
    );
    expect(plan.nextWindow).toEqual({ raisedAt: T, yearsBeforeRaise: 20 });
    const expired = change(
      planRetentionTermChange(raised(30, 20), 40, 15, at(24 * HOUR)),
    );
    expect(expired.nextWindow).toEqual({
      raisedAt: at(24 * HOUR),
      yearsBeforeRaise: 30,
    });
  });

  it('a reduction inside the window references max(new, before the raise)', () => {
    const now = at(HOUR);
    const stored = raised(30, 20);
    const ref = (to: number) => {
      const plan = change(planRetentionTermChange(stored, to, 15, now));
      expect(plan.direction).toBe('DOWN');
      expect(plan.withinCorrectionWindow).toBe(true);
      return plan.referenceYears;
    };
    expect(ref(25)).toBe(25);
    expect(ref(20)).toBe(20);
    expect(ref(15)).toBe(20);
  });

  it('a reduction outside the window references the previous effective term', () => {
    const plan = change(
      planRetentionTermChange(raised(30, 20), 20, 15, at(24 * HOUR)),
    );
    expect(plan.referenceYears).toBe(30);
    expect(plan.withinCorrectionWindow).toBe(false);
    expect(plan.nextWindow).toEqual({ raisedAt: null, yearsBeforeRaise: null });
  });

  it('closes or keeps the window as R13 says', () => {
    const now = at(HOUR);
    const stored = raised(30, 20);
    const back = change(planRetentionTermChange(stored, 20, 15, now));
    expect(back.nextWindow).toEqual({ raisedAt: null, yearsBeforeRaise: null });
    const below = change(planRetentionTermChange(stored, 15, 15, now));
    expect(below.nextWindow).toEqual({
      raisedAt: null,
      yearsBeforeRaise: null,
    });
    const partial = change(planRetentionTermChange(stored, 25, 15, now));
    expect(partial.nextWindow).toEqual({ raisedAt: T, yearsBeforeRaise: 20 });
  });
});

describe('retentionTermAuditSpec', () => {
  it('the audit spec carries stored values and the term change', () => {
    const plan = change(planRetentionTermChange(plain(15), 30, 20, T));
    const spec = retentionTermAuditSpec(TENANT, 15, 30, plan, 0);
    expect(spec).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: TENANT,
      reason: 'CLINICAL_RECORD_RETENTION_SETTINGS',
      before: { clinicalRecordRetentionYears: 15 },
      after: { clinicalRecordRetentionYears: 30 },
      extra: {
        retentionTermChange: {
          direction: 'UP',
          protectedPatients: 0,
          effectiveBefore: 20,
          effectiveAfter: 30,
          withinCorrectionWindow: false,
        },
      },
    });
  });

  it('a raise always records zero protected patients', () => {
    const plan = change(planRetentionTermChange(plain(20), 30, 15, T));
    const spec = retentionTermAuditSpec(TENANT, 20, 30, plan, 9);
    expect(spec.extra?.retentionTermChange?.protectedPatients).toBe(0);
  });

  it('keeps protectedPatients on a reduction', () => {
    const plan = change(
      planRetentionTermChange(raised(30, 20), 25, 15, at(HOUR)),
    );
    const spec = retentionTermAuditSpec(TENANT, 30, 25, plan, 7);
    expect(spec.extra?.retentionTermChange).toEqual({
      direction: 'DOWN',
      protectedPatients: 7,
      effectiveBefore: 30,
      effectiveAfter: 25,
      withinCorrectionWindow: true,
    });
  });
});
