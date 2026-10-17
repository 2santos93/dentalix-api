import {
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { SessionCookieService } from './session-cookie.service';
import { LoginLockedError } from '../domain/login-lockout';

function setup(refreshError: Error) {
  const refresh = { execute: jest.fn().mockRejectedValue(refreshError) };
  const cookie = {
    read: jest.fn().mockReturnValue('cookie-refresh'),
    assertTrustedOrigin: jest.fn(),
    wantsCookie: jest.fn().mockReturnValue(true),
    clear: jest.fn(),
    deliver: jest.fn(),
  };
  const controller = new AuthController(
    {} as never,
    {} as never,
    refresh as never,
    {} as never,
    {} as never,
    cookie as unknown as SessionCookieService,
    { get: () => undefined } as never,
  );
  const req = {
    headers: {},
    tenantHost: { host: 'a.localhost', tenantId: 't1' },
  };
  return { controller, cookie, req, res: {} as never };
}

describe('AuthController.refreshHandler (cookie, DX-062)', () => {
  it('un 401 borra la cookie muerta', async () => {
    const { controller, cookie, req, res } = setup(
      new UnauthorizedException('Invalid refresh token'),
    );

    await expect(
      controller.refreshHandler(req, res, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cookie.clear).toHaveBeenCalledWith(res);
  });

  it('un fallo transitorio (5xx) NO borra la cookie: la sesión no se sabe muerta', async () => {
    const { controller, cookie, req, res } = setup(
      new InternalServerErrorException(),
    );

    await expect(
      controller.refreshHandler(req, res, {}),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(cookie.clear).not.toHaveBeenCalled();
  });
});

function loginSetup(
  opts: {
    locked?: number;
    loginError?: Error;
    tenantId?: string | null;
  } = {},
) {
  const pair = { accessToken: 'a', refreshToken: 'r' };
  const login = {
    execute: opts.loginError
      ? jest.fn().mockRejectedValue(opts.loginError)
      : jest.fn().mockResolvedValue(pair),
    executePlatform: opts.loginError
      ? jest.fn().mockRejectedValue(opts.loginError)
      : jest.fn().mockResolvedValue(pair),
  };
  const lockout = {
    assertCanAttempt: opts.locked
      ? jest.fn().mockRejectedValue(new LoginLockedError(opts.locked))
      : jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
  };
  const cookie = {
    wantsCookie: jest.fn().mockReturnValue(false),
    deliver: jest.fn().mockReturnValue(pair),
  };
  const controller = new AuthController(
    {} as never,
    login as never,
    {} as never,
    {} as never,
    lockout as never,
    cookie as unknown as SessionCookieService,
    { get: () => undefined } as never,
  );
  const req = {
    headers: {},
    ip: '203.0.113.10',
    tenantHost: {
      host: 'a.localhost',
      tenantId: opts.tenantId === undefined ? 't1' : opts.tenantId,
    },
  };
  const res = { setHeader: jest.fn() };
  const dto = { email: 'Doctora@Sonrisa.com', password: 'Clave-123' };
  return { controller, login, lockout, req, res, dto, pair };
}

describe('AuthController.loginHandler (bloqueo por fallos, DX-048)', () => {
  it('en espera: 429 con Retry-After y mensaje en español, sin mirar la contraseña', async () => {
    const { controller, login, lockout, req, res, dto } = loginSetup({
      locked: 61,
    });
    const err = await controller
      .loginHandler(req as never, res as never, dto)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Demasiados intentos. Vuelve a intentarlo en 2 min.',
    });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '61');
    expect(lockout.assertCanAttempt).toHaveBeenCalledWith(
      dto.email,
      '203.0.113.10',
    );
    expect(login.execute).not.toHaveBeenCalled();
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('401: cuenta el fallo (cuenta + IP) y propaga el mismo error', async () => {
    const error = new UnauthorizedException('Invalid credentials');
    const { controller, lockout, req, res, dto } = loginSetup({
      loginError: error,
    });
    await expect(
      controller.loginHandler(req as never, res as never, dto),
    ).rejects.toBe(error);
    expect(lockout.recordFailure).toHaveBeenCalledWith(
      dto.email,
      '203.0.113.10',
    );
    expect(lockout.recordSuccess).not.toHaveBeenCalled();
  });

  it('login correcto: reinicia el contador de la cuenta', async () => {
    const { controller, lockout, req, res, dto, pair } = loginSetup();
    await expect(
      controller.loginHandler(req as never, res as never, dto),
    ).resolves.toEqual(pair);
    expect(lockout.recordSuccess).toHaveBeenCalledWith(dto.email);
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('un error que no es de credenciales (5xx) no cuenta como fallo', async () => {
    const { controller, lockout, req, res, dto } = loginSetup({
      loginError: new InternalServerErrorException(),
    });
    await expect(
      controller.loginHandler(req as never, res as never, dto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(lockout.recordFailure).not.toHaveBeenCalled();
  });

  it('el login de plataforma (apex) usa el mismo contador', async () => {
    const error = new UnauthorizedException('Invalid credentials');
    const { controller, login, lockout, req, res, dto } = loginSetup({
      tenantId: null,
      loginError: error,
    });
    await expect(
      controller.loginHandler(req as never, res as never, dto),
    ).rejects.toBe(error);
    expect(login.executePlatform).toHaveBeenCalled();
    expect(lockout.recordFailure).toHaveBeenCalledWith(
      dto.email,
      '203.0.113.10',
    );
  });
});
