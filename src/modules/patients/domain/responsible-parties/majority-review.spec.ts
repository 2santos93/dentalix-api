import { isMinor } from './majority-age';
import {
  majorityDateOf,
  majorityReviewState,
  noticesStayWithPatient,
  type MajorityReviewInput,
} from './majority-review';

const born = (day: string) => new Date(`${day}T00:00:00.000Z`);

describe('majorityDateOf (DX-342)', () => {
  it('birthday plus the clinic majority age at 16, 18, 19 and 20', () => {
    for (const n of [16, 18, 19, 20]) {
      const birth = born(`${2026 - n}-11-20`);
      expect(majorityDateOf(birth, n)).toBe('2026-11-20');
      // Coincide con isMinor: menor la víspera, adulto ese mismo día.
      expect(isMinor(birth, n, '2026-11-19')).toBe(true);
      expect(isMinor(birth, n, '2026-11-20')).toBe(false);
    }
  });

  it('29 February: 1 March in a non-leap year, 29 February in a leap year', () => {
    expect(majorityDateOf(born('2008-02-29'), 18)).toBe('2026-03-01');
    expect(isMinor(born('2008-02-29'), 18, '2026-02-28')).toBe(true);
    expect(isMinor(born('2008-02-29'), 18, '2026-03-01')).toBe(false);
    expect(majorityDateOf(born('2008-02-29'), 20)).toBe('2028-02-29');
    expect(isMinor(born('2008-02-29'), 20, '2028-02-28')).toBe(true);
    expect(isMinor(born('2008-02-29'), 20, '2028-02-29')).toBe(false);
  });

  it('no birth date, no majority date', () => {
    expect(majorityDateOf(null, 18)).toBeNull();
  });
});

describe('majorityReviewState (DX-342)', () => {
  // Cumple 18 el 2026-11-20; responsable dado de alta de niño.
  const base: MajorityReviewInput = {
    birthDate: born('2008-11-20'),
    majorityAge: 18,
    today: '2026-11-25',
    timeZone: 'America/Caracas',
    responsibles: [{ createdAt: new Date('2015-03-10T14:00:00.000Z') }],
    review: null,
  };

  it('minor, no birth date or no responsibles: NOT_APPLICABLE', () => {
    expect(majorityReviewState({ ...base, today: '2026-11-19' }).status).toBe(
      'NOT_APPLICABLE',
    );
    expect(majorityReviewState({ ...base, birthDate: null }).status).toBe(
      'NOT_APPLICABLE',
    );
    expect(majorityReviewState({ ...base, responsibles: [] }).status).toBe(
      'NOT_APPLICABLE',
    );
  });

  it('came of age with a responsible added while a minor: PENDING from the birthday itself', () => {
    const state = majorityReviewState({ ...base, today: '2026-11-20' });
    expect(state).toEqual({
      status: 'PENDING',
      majorityDate: '2026-11-20',
      decision: null,
    });
    expect(noticesStayWithPatient(state)).toBe(true);
  });

  it('a responsible added as an adult (elderly patient) keeps NOT_APPLICABLE', () => {
    const state = majorityReviewState({
      ...base,
      birthDate: born('1948-05-02'),
      responsibles: [{ createdAt: new Date('2026-10-01T12:00:00.000Z') }],
    });
    expect(state.status).toBe('NOT_APPLICABLE');
    expect(noticesStayWithPatient(state)).toBe(false);
  });

  it('the day of the responsible is the civil day of the sede (UTC-4 boundary)', () => {
    // 01:30 UTC del 20/11 = 21:30 del 19/11 en Caracas: aún era menor.
    const lateEvening = new Date('2026-11-20T01:30:00.000Z');
    expect(
      majorityReviewState({
        ...base,
        responsibles: [{ createdAt: lateEvening }],
      }).status,
    ).toBe('PENDING');
    // En Tokio ya es el 20/11: se dio de alta el día que cumplió, ya adulto.
    expect(
      majorityReviewState({
        ...base,
        timeZone: 'Asia/Tokyo',
        responsibles: [{ createdAt: lateEvening }],
      }).status,
    ).toBe('NOT_APPLICABLE');
  });

  it('a review for the current majority date wins; the latest decision rules', () => {
    const self = majorityReviewState({
      ...base,
      review: { decision: 'PATIENT_SELF', majorityDate: '2026-11-20' },
    });
    expect(self).toEqual({
      status: 'REVIEWED',
      majorityDate: '2026-11-20',
      decision: 'PATIENT_SELF',
    });
    expect(noticesStayWithPatient(self)).toBe(true);
    const keep = majorityReviewState({
      ...base,
      review: { decision: 'KEEP_RESPONSIBLE', majorityDate: '2026-11-20' },
    });
    expect(keep.status).toBe('REVIEWED');
    expect(noticesStayWithPatient(keep)).toBe(false);
  });

  it('a review is invalidated when the majority age or the birth date changes', () => {
    const review = {
      decision: 'KEEP_RESPONSIBLE' as const,
      majorityDate: '2026-11-20',
    };
    // La clínica baja la mayoría de edad a 16: su fecha pasa a 2024-11-20.
    const lowered = majorityReviewState({ ...base, majorityAge: 16, review });
    expect(lowered).toEqual({
      status: 'PENDING',
      majorityDate: '2024-11-20',
      decision: null,
    });
    expect(noticesStayWithPatient(lowered)).toBe(true);
    // Se corrige la fecha de nacimiento.
    expect(
      majorityReviewState({ ...base, birthDate: born('2008-10-02'), review })
        .status,
    ).toBe('PENDING');
  });
});
