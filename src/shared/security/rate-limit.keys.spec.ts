import { loginRateLimitKey } from './rate-limit.keys';

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
