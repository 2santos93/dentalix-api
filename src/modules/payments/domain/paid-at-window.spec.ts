import {
  PAID_AT_IN_FUTURE_MESSAGE,
  isPaidAtTooFarInFuture,
} from './paid-at-window';

const NOW = new Date('2026-10-31T15:00:00.000Z');

describe('abono con fecha futura (DX-054)', () => {
  it('un instante hasta 24 h por delante vale (relojes desfasados, otra zona)', () => {
    expect(isPaidAtTooFarInFuture(NOW, NOW)).toBe(false);
    expect(
      isPaidAtTooFarInFuture(new Date('2026-11-01T15:00:00.000Z'), NOW),
    ).toBe(false);
    expect(
      isPaidAtTooFarInFuture(new Date('2026-10-01T10:00:00.000Z'), NOW),
    ).toBe(false);
  });

  it('un instante a más de 24 h es futuro', () => {
    expect(
      isPaidAtTooFarInFuture(new Date('2026-11-01T15:00:00.001Z'), NOW),
    ).toBe(true);
    expect(
      isPaidAtTooFarInFuture(new Date('2026-12-25T12:00:00.000Z'), NOW),
    ).toBe(true);
  });

  it('un día civil cuenta desde su primer instante en cualquier zona (UTC+14)', () => {
    // 2026-11-02 empieza en UTC+14 el 2026-11-01T10:00Z: dentro de 24 h.
    expect(isPaidAtTooFarInFuture({ civilDate: '2026-11-02' }, NOW)).toBe(
      false,
    );
    // 2026-11-03 empieza como pronto el 2026-11-02T10:00Z: más de 24 h.
    expect(isPaidAtTooFarInFuture({ civilDate: '2026-11-03' }, NOW)).toBe(true);
    expect(isPaidAtTooFarInFuture({ civilDate: '2026-10-31' }, NOW)).toBe(
      false,
    );
  });

  it('el mensaje es en español', () => {
    expect(PAID_AT_IN_FUTURE_MESSAGE).toBe(
      'La fecha del abono no puede estar más de 24 horas en el futuro.',
    );
  });
});
