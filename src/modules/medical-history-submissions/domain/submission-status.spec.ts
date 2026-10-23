import {
  effectiveSubmissionStatus,
  isOpenForPatient,
} from './submission-status';

describe('estado de un envío de anamnesis (DX-099)', () => {
  const now = new Date('2026-10-23T15:00:00.000Z');
  const later = new Date('2026-10-24T15:00:00.000Z');
  const earlier = new Date('2026-10-22T15:00:00.000Z');

  it('un enlace sin usar caduca con la hora, sin barrido', () => {
    expect(
      effectiveSubmissionStatus(
        { status: 'PENDING_PATIENT', expiresAt: earlier },
        now,
      ),
    ).toBe('EXPIRED');
    expect(
      effectiveSubmissionStatus(
        { status: 'PENDING_PATIENT', expiresAt: now },
        now,
      ),
    ).toBe('EXPIRED');
    expect(
      effectiveSubmissionStatus(
        { status: 'PENDING_PATIENT', expiresAt: later },
        now,
      ),
    ).toBe('PENDING_PATIENT');
  });

  it('un envío ya hecho no «caduca» por la fecha del enlace', () => {
    expect(
      effectiveSubmissionStatus(
        { status: 'SUBMITTED', expiresAt: earlier },
        now,
      ),
    ).toBe('SUBMITTED');
  });

  it('el paciente solo puede usar un enlace pendiente, vigente y sin anular', () => {
    const base = {
      status: 'PENDING_PATIENT' as const,
      expiresAt: later,
      revokedAt: null,
    };
    expect(isOpenForPatient(base, now)).toBe(true);
    expect(isOpenForPatient({ ...base, revokedAt: earlier }, now)).toBe(false);
    expect(isOpenForPatient({ ...base, expiresAt: earlier }, now)).toBe(false);
    expect(isOpenForPatient({ ...base, status: 'SUBMITTED' }, now)).toBe(false);
  });
});
