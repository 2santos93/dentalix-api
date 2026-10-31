import {
  decideRefreshRotation,
  loadRefreshReuseGraceMs,
  refreshReuseGraceProblems,
  type RefreshSessionState,
} from './refresh-rotation';

const T0 = new Date('2026-10-31T12:00:00.000Z');
const GRACE = 30_000;
const at = (ms: number) => new Date(T0.getTime() + ms);

const rotated: RefreshSessionState = {
  currentJti: 'j2',
  previousJti: 'j1',
  rotatedAt: T0,
  expiresAt: at(30 * 86_400_000),
  revokedAt: null,
};

describe('decideRefreshRotation', () => {
  it('rota el token vigente', () => {
    expect(decideRefreshRotation(rotated, 'j2', at(1), GRACE)).toBe('rotate');
  });

  it('familia recién nacida (sin rotar): el token del login es el vigente', () => {
    const fresh = {
      ...rotated,
      currentJti: 'j1',
      previousJti: null,
      rotatedAt: null,
    };
    expect(decideRefreshRotation(fresh, 'j1', at(1), GRACE)).toBe('rotate');
  });

  it('el anterior dentro de la gracia recibe el vigente (respuesta perdida)', () => {
    expect(decideRefreshRotation(rotated, 'j1', at(GRACE), GRACE)).toBe(
      'grace',
    );
  });

  it('el anterior fuera de la gracia es reuso (robo)', () => {
    expect(decideRefreshRotation(rotated, 'j1', at(GRACE + 1), GRACE)).toBe(
      'reused',
    );
  });

  it('un token más viejo que el anterior es reuso aunque esté en la gracia', () => {
    expect(decideRefreshRotation(rotated, 'j0', at(1), GRACE)).toBe('reused');
  });

  it('sin gracia (0), el anterior es reuso al instante', () => {
    expect(decideRefreshRotation(rotated, 'j1', at(1), 0)).toBe('reused');
  });

  it('una familia revocada no rota ni con el token vigente', () => {
    const revoked = { ...rotated, revokedAt: at(5) };
    expect(decideRefreshRotation(revoked, 'j2', at(6), GRACE)).toBe('revoked');
    expect(decideRefreshRotation(revoked, 'j1', at(6), GRACE)).toBe('revoked');
  });
});

describe('JWT_REFRESH_REUSE_GRACE_SECONDS', () => {
  it('30 s por defecto; 0–60 válidos', () => {
    expect(loadRefreshReuseGraceMs(undefined)).toBe(30_000);
    expect(loadRefreshReuseGraceMs('')).toBe(30_000);
    expect(loadRefreshReuseGraceMs('0')).toBe(0);
    expect(loadRefreshReuseGraceMs('60')).toBe(60_000);
    expect(refreshReuseGraceProblems(undefined)).toEqual([]);
    expect(refreshReuseGraceProblems('0')).toEqual([]);
    expect(refreshReuseGraceProblems('60')).toEqual([]);
  });

  it.each(['61', '-1', '1.5', 'abc', '3600'])('rechaza %p', (raw) => {
    expect(refreshReuseGraceProblems(raw)).toHaveLength(1);
  });
});
