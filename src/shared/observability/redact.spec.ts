import { REDACTED, redactSensitive } from './redact';

describe('redactSensitive', () => {
  it('oculta Authorization, Cookie y Set-Cookie sin distinguir mayúsculas', () => {
    expect(
      redactSensitive({
        Authorization: 'Bearer eyJhbGciOi.payload.firma',
        cookie: 'dx_refresh=abc',
        'set-cookie': ['dx_refresh=abc; HttpOnly'],
        'proxy-authorization': 'Basic Zm9vOmJhcg==',
        'user-agent': 'curl/8',
      }),
    ).toEqual({
      Authorization: REDACTED,
      cookie: REDACTED,
      'set-cookie': REDACTED,
      'proxy-authorization': REDACTED,
      'user-agent': 'curl/8',
    });
  });

  it('oculta contraseñas, tokens y secretos también anidados y en arrays', () => {
    expect(
      redactSensitive({
        user: { email: 'x', password: 'S3cret!!', currentPassword: 'a' },
        items: [{ refreshToken: 'r' }, { accessToken: 'a', ok: 1 }],
        jwtSecret: 's',
        apiKey: 'k',
      }),
    ).toEqual({
      user: { email: 'x', password: REDACTED, currentPassword: REDACTED },
      items: [{ refreshToken: REDACTED }, { accessToken: REDACTED, ok: 1 }],
      jwtSecret: REDACTED,
      apiKey: REDACTED,
    });
  });

  it('oculta el nº de afiliado de una cobertura, con cualquier prefijo (SEC-049)', () => {
    expect(
      redactSensitive({
        memberNumber: '1020304050',
        checkedMemberNumber: '1020304050',
        member_number: 'x',
        planName: 'Plan Oro',
      }),
    ).toEqual({
      memberNumber: REDACTED,
      checkedMemberNumber: REDACTED,
      member_number: REDACTED,
      planName: 'Plan Oro',
    });
  });

  it('oculta el triaje de una urgencia (DX-470): es un dato de salud', () => {
    expect(
      redactSensitive({
        triageFlags: ['PAIN'],
        triageNote: 'Muela 36',
        walkIn: true,
      }),
    ).toEqual({ triageFlags: REDACTED, triageNote: REDACTED, walkIn: true });
  });

  it('no modifica el objeto original', () => {
    const headers = { authorization: 'Bearer x' };
    redactSensitive(headers);
    expect(headers.authorization).toBe('Bearer x');
  });

  it('deja intactos los valores primitivos y aguanta ciclos', () => {
    expect(redactSensitive('texto')).toBe('texto');
    expect(redactSensitive(null)).toBeNull();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redactSensitive(cyclic)).toEqual({ a: 1, self: '[Circular]' });
  });
});
