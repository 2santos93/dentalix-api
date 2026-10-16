import {
  loginAccountRateLimitKey,
  loginRateLimitKey,
  passwordRateLimitKey,
  staffActorRateLimitKey,
} from './rate-limit.keys';

// JWT sin firma válida: la clave solo DECODIFICA el payload (la verificación
// la hace JwtAuthGuard después).
const fakeJwt = (payload: object): string =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'firma',
  ].join('.');

describe('loginRateLimitKey', () => {
  const prefix = 'AuthController-loginHandler-login';

  it('separa el balde por email para la misma IP', () => {
    const a = loginRateLimitKey(prefix, '1.2.3.4', { email: 'a@x.com' });
    const b = loginRateLimitKey(prefix, '1.2.3.4', { email: 'b@x.com' });
    expect(a).not.toBe(b);
  });

  it('separa el balde por IP para el mismo email', () => {
    const a = loginRateLimitKey(prefix, '1.2.3.4', { email: 'a@x.com' });
    const b = loginRateLimitKey(prefix, '5.6.7.8', { email: 'a@x.com' });
    expect(a).not.toBe(b);
  });

  it('normaliza el email (mayúsculas y espacios no abren baldes nuevos)', () => {
    const a = loginRateLimitKey(prefix, '1.2.3.4', { email: 'a@x.com' });
    const b = loginRateLimitKey(prefix, '1.2.3.4', { email: '  A@X.COM ' });
    expect(b).toBe(a);
  });

  it('sin email válido cae a un balde solo por IP, estable', () => {
    const a = loginRateLimitKey(prefix, '1.2.3.4', { email: 42 });
    const b = loginRateLimitKey(prefix, '1.2.3.4', undefined);
    expect(a).toBe(b);
    expect(a).not.toBe(
      loginRateLimitKey(prefix, '1.2.3.4', { email: 'a@x.com' }),
    );
  });

  it('no deja el email en claro en la clave', () => {
    const key = loginRateLimitKey(prefix, '1.2.3.4', { email: 'a@x.com' });
    expect(key).not.toContain('a@x.com');
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('loginAccountRateLimitKey', () => {
  const prefix = 'AuthController-loginHandler-login-account';

  it('depende solo del email normalizado, no de la IP', () => {
    const a = loginAccountRateLimitKey(prefix, { email: 'a@x.com' });
    expect(loginAccountRateLimitKey(prefix, { email: ' A@X.com' })).toBe(a);
    expect(loginAccountRateLimitKey(prefix, { email: 'b@x.com' })).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain('a@x.com');
  });

  it('no coincide con la clave IP+email del mismo email', () => {
    expect(loginAccountRateLimitKey(prefix, { email: 'a@x.com' })).not.toBe(
      loginRateLimitKey(prefix, '', { email: 'a@x.com' }),
    );
  });
});

describe('passwordRateLimitKey', () => {
  const prefix = 'MeController-changePassword-password';

  it('separa por usuario (sub del token) dentro de la misma IP', () => {
    const a = passwordRateLimitKey(
      prefix,
      '1.2.3.4',
      `Bearer ${fakeJwt({ sub: 'u1' })}`,
    );
    const b = passwordRateLimitKey(
      prefix,
      '1.2.3.4',
      `Bearer ${fakeJwt({ sub: 'u2' })}`,
    );
    expect(a).not.toBe(b);
  });

  it('el mismo usuario con otro token (renovado) comparte balde', () => {
    const a = passwordRateLimitKey(
      prefix,
      '1.2.3.4',
      `Bearer ${fakeJwt({ sub: 'u1', iat: 1 })}`,
    );
    const b = passwordRateLimitKey(
      prefix,
      '1.2.3.4',
      `Bearer ${fakeJwt({ sub: 'u1', iat: 2 })}`,
    );
    expect(b).toBe(a);
  });

  it('separa por IP para el mismo usuario', () => {
    const token = `Bearer ${fakeJwt({ sub: 'u1' })}`;
    expect(passwordRateLimitKey(prefix, '1.2.3.4', token)).not.toBe(
      passwordRateLimitKey(prefix, '5.6.7.8', token),
    );
  });

  it('si el token no se puede decodificar usa la cabecera completa (hasheada)', () => {
    const a = passwordRateLimitKey(prefix, '1.2.3.4', 'Bearer basura');
    const b = passwordRateLimitKey(prefix, '1.2.3.4', 'Bearer otra-basura');
    expect(a).not.toBe(b);
    expect(passwordRateLimitKey(prefix, '1.2.3.4', 'Bearer basura')).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sin cabecera cae a un balde solo por IP', () => {
    expect(passwordRateLimitKey(prefix, '1.2.3.4', undefined)).toBe(
      passwordRateLimitKey(prefix, '1.2.3.4', ''),
    );
  });
});

describe('staffActorRateLimitKey (DX-088)', () => {
  const token = (claims: object): string =>
    `Bearer x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  it('mismo usuario y clínica comparten balde; otro usuario u otra clínica no', () => {
    const a = staffActorRateLimitKey('p', token({ sub: 'u1', tenantId: 't1' }));
    expect(a).toBe(
      staffActorRateLimitKey('p', token({ sub: 'u1', tenantId: 't1', iat: 2 })),
    );
    expect(a).not.toBe(
      staffActorRateLimitKey('p', token({ sub: 'u2', tenantId: 't1' })),
    );
    expect(a).not.toBe(
      staffActorRateLimitKey('p', token({ sub: 'u1', tenantId: 't2' })),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sin token decodificable usa la cabecera (acabará en 401)', () => {
    expect(staffActorRateLimitKey('p', 'Bearer basura')).toBe(
      staffActorRateLimitKey('p', 'Bearer basura'),
    );
    expect(staffActorRateLimitKey('p', undefined)).toMatch(/^[0-9a-f]{64}$/);
  });
});
