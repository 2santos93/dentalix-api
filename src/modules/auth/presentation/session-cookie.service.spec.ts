import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  SessionCookieService,
} from './session-cookie.service';

const EXP = Math.floor(Date.now() / 1000) + 3600;

// Solo el payload importa: el servicio lee `exp` de un token que la propia API
// acaba de firmar.
const fakeJwt = (payload: object): string =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'firma',
  ].join('.');

function configOf(vars: Record<string, string>): ConfigService {
  return { get: (k: string) => vars[k] } as unknown as ConfigService;
}

const devConfig = configOf({
  CORS_ORIGINS: 'http://localhost:3001',
  CORS_ROOT_DOMAIN: 'localhost',
});

function fakeRes() {
  return { cookie: jest.fn(), clearCookie: jest.fn() };
}

function req(
  headers: Record<string, string>,
  host?: string,
): {
  headers: Record<string, string>;
  tenantHost?: { host?: string; tenantId: string | null };
} {
  return { headers, tenantHost: { host, tenantId: null } };
}

describe('SessionCookieService', () => {
  const service = new SessionCookieService(devConfig);

  describe('read', () => {
    it('lee el refresh de la cookie de sesión entre otras cookies', () => {
      expect(
        service.read(
          req({ cookie: `a=1; ${REFRESH_COOKIE}=tok.en.value; b=2` }),
        ),
      ).toBe('tok.en.value');
    });

    it('devuelve undefined sin cookie o con la cookie vacía', () => {
      expect(service.read(req({}))).toBeUndefined();
      expect(service.read(req({ cookie: 'otra=1' }))).toBeUndefined();
      expect(
        service.read(req({ cookie: `${REFRESH_COOKIE}=` })),
      ).toBeUndefined();
    });
  });

  describe('wantsCookie', () => {
    it('solo con la cabecera X-Refresh-Transport: cookie', () => {
      expect(
        service.wantsCookie(req({ 'x-refresh-transport': 'cookie' })),
      ).toBe(true);
      expect(service.wantsCookie(req({ 'x-refresh-transport': 'body' }))).toBe(
        false,
      );
      expect(service.wantsCookie(req({}))).toBe(false);
    });
  });

  describe('write / clear', () => {
    it('emite la cookie HttpOnly, SameSite=Strict, acotada a /api/v1/auth, sin Domain y con la vida del token', () => {
      const res = fakeRes();
      const token = fakeJwt({ sub: 'u1', exp: EXP });

      service.write(res as never, token);

      expect(res.cookie).toHaveBeenCalledTimes(1);
      const [name, value, opts] = res.cookie.mock.calls[0] as [
        string,
        string,
        Record<string, unknown>,
      ];
      expect(name).toBe(REFRESH_COOKIE);
      expect(value).toBe(token);
      expect(opts).toMatchObject({
        httpOnly: true,
        sameSite: 'strict',
        path: REFRESH_COOKIE_PATH,
        secure: false,
      });
      expect(opts).not.toHaveProperty('domain');
      const maxAge = opts.maxAge as number;
      expect(maxAge).toBeGreaterThan(3500_000);
      expect(maxAge).toBeLessThanOrEqual(3600_000);
    });

    it('marca la cookie Secure en producción', () => {
      const prod = new SessionCookieService(
        configOf({ NODE_ENV: 'production', CORS_ROOT_DOMAIN: 'dentalix.app' }),
      );
      const res = fakeRes();

      prod.write(res as never, fakeJwt({ exp: EXP }));

      const [, , opts] = res.cookie.mock.calls[0] as [string, string, object];
      expect(opts).toMatchObject({ secure: true });
    });

    it('borra la cookie con los mismos atributos de ámbito', () => {
      const res = fakeRes();

      service.clear(res as never);

      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: REFRESH_COOKIE_PATH,
        }),
      );
    });
  });

  describe('deliver', () => {
    const pair = {
      accessToken: 'acc',
      refreshToken: fakeJwt({ exp: EXP }),
    };

    it('modo cookie: guarda el refresh en la cookie y NO lo devuelve en el body', () => {
      const res = fakeRes();

      const body = service.deliver(res as never, pair, true);

      expect(body).toEqual({ accessToken: 'acc' });
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        pair.refreshToken,
        expect.any(Object),
      );
    });

    it('cliente antiguo (sin modo cookie): el par en el body y sin cookie', () => {
      const res = fakeRes();

      expect(service.deliver(res as never, pair, false)).toEqual(pair);
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe('assertTrustedOrigin (CSRF)', () => {
    it('acepta el origen de la web en el mismo host de la clínica', () => {
      expect(() =>
        service.assertTrustedOrigin(
          req({ origin: 'http://demo.localhost:3001' }, 'demo.localhost:3001'),
        ),
      ).not.toThrow();
    });

    it('acepta el host sin distinguir mayúsculas', () => {
      expect(() =>
        service.assertTrustedOrigin(
          req({ origin: 'http://Demo.localhost:3001' }, 'demo.LOCALHOST:3001'),
        ),
      ).not.toThrow();
    });

    it('rechaza (403) una petición sin Origin', () => {
      expect(() =>
        service.assertTrustedOrigin(req({}, 'demo.localhost:3001')),
      ).toThrow(ForbiddenException);
    });

    it('rechaza (403) un origen ajeno', () => {
      expect(() =>
        service.assertTrustedOrigin(
          req({ origin: 'https://evil.example' }, 'demo.localhost:3001'),
        ),
      ).toThrow(ForbiddenException);
    });

    it('rechaza (403) un origen permitido pero de OTRO host (otra clínica)', () => {
      expect(() =>
        service.assertTrustedOrigin(
          req({ origin: 'http://otra.localhost:3001' }, 'demo.localhost:3001'),
        ),
      ).toThrow(ForbiddenException);
    });

    it('rechaza (403) un Origin "null" o mal formado', () => {
      for (const origin of ['null', 'no es una url']) {
        expect(() =>
          service.assertTrustedOrigin(req({ origin }, 'demo.localhost:3001')),
        ).toThrow(ForbiddenException);
      }
    });
  });
});
