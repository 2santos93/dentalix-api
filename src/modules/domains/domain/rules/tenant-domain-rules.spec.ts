import {
  PENDING_DOMAIN_TTL_MS,
  domainState,
  hasVerificationToken,
  isExpired,
  nextCheckState,
  pendingExpiresAt,
  verificationRecordName,
} from './tenant-domain-rules';

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('reglas de dominios personalizados (SEC-009)', () => {
  it('un PENDING caduca a las 72 h del alta', () => {
    expect(PENDING_DOMAIN_TTL_MS).toBe(72 * 3600 * 1000);
    expect(pendingExpiresAt(NOW).toISOString()).toBe(
      '2026-10-20T12:00:00.000Z',
    );
  });

  it('EXPIRED solo para un PENDING con expiresAt ya pasado (incluido el instante exacto)', () => {
    const past = new Date(NOW.getTime() - 1);
    const future = new Date(NOW.getTime() + 1);
    expect(isExpired({ status: 'PENDING', expiresAt: past }, NOW)).toBe(true);
    expect(isExpired({ status: 'PENDING', expiresAt: NOW }, NOW)).toBe(true);
    expect(isExpired({ status: 'PENDING', expiresAt: future }, NOW)).toBe(
      false,
    );
    expect(isExpired({ status: 'VERIFIED', expiresAt: past }, NOW)).toBe(false);
    expect(isExpired({ status: 'DISABLED', expiresAt: past }, NOW)).toBe(false);
    expect(domainState({ status: 'PENDING', expiresAt: past }, NOW)).toBe(
      'EXPIRED',
    );
    expect(domainState({ status: 'DISABLED', expiresAt: null }, NOW)).toBe(
      'DISABLED',
    );
  });

  it('busca el token en los TXT de _dentalix-verify.<host>', () => {
    expect(verificationRecordName('citas.miclinica.com')).toBe(
      '_dentalix-verify.citas.miclinica.com',
    );
    expect(
      hasVerificationToken(
        ['otro', 'dentalix-verify=abc'],
        'dentalix-verify=abc',
      ),
    ).toBe(true);
    expect(hasVerificationToken([], 'dentalix-verify=abc')).toBe(false);
  });

  it('cuenta fallos seguidos y desactiva al llegar al máximo; un acierto reinicia', () => {
    expect(nextCheckState(0, false, 3)).toEqual({
      failedChecks: 1,
      disable: false,
    });
    expect(nextCheckState(1, false, 3)).toEqual({
      failedChecks: 2,
      disable: false,
    });
    expect(nextCheckState(2, false, 3)).toEqual({
      failedChecks: 3,
      disable: true,
    });
    expect(nextCheckState(2, true, 3)).toEqual({
      failedChecks: 0,
      disable: false,
    });
    expect(nextCheckState(0, false, 1)).toEqual({
      failedChecks: 1,
      disable: true,
    });
  });
});
