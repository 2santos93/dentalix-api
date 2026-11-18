import { PATIENT_ACCESS_LOCK_MINUTES } from '../domain/patient-access';
import { UnknownTokenAttempts } from './unknown-token-attempts';

const NOW = new Date('2026-11-18T15:00:00.000Z');

describe('UnknownTokenAttempts (DX-101): el 429 no revela si el token existe', () => {
  it('sigue la regla de un enlace real: 4 fallos y el quinto bloquea 30 min', () => {
    const attempts = new UnknownTokenAttempts();
    const kinds = [1, 2, 3, 4, 5].map(() => attempts.fail('t', NOW).kind);
    expect(kinds).toEqual(['WRONG', 'WRONG', 'WRONG', 'WRONG', 'LOCK']);
    expect(attempts.fail('t', NOW)).toEqual({
      kind: 'LOCKED',
      lockedUntil: new Date(
        NOW.getTime() + PATIENT_ACCESS_LOCK_MINUTES * 60_000,
      ),
    });
  });

  it('cada token lleva su cuenta', () => {
    const attempts = new UnknownTokenAttempts();
    for (let i = 0; i < 5; i++) attempts.fail('a', NOW);
    expect(attempts.fail('b', NOW).kind).toBe('WRONG');
  });

  it('pasado el bloqueo, vuelve a empezar', () => {
    const attempts = new UnknownTokenAttempts();
    for (let i = 0; i < 5; i++) attempts.fail('t', NOW);
    const after = new Date(
      NOW.getTime() + PATIENT_ACCESS_LOCK_MINUTES * 60_000 + 1,
    );
    expect(attempts.fail('t', after)).toEqual({
      kind: 'WRONG',
      failedAttempts: 1,
    });
  });

  it('está acotado: no crece sin límite con millones de tokens', () => {
    const attempts = new UnknownTokenAttempts();
    for (let i = 0; i < 10_050; i++) attempts.fail(`t${i}`, NOW);
    expect(attempts.size()).toBeLessThanOrEqual(10_000);
  });
});
