import {
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { SessionCookieService } from './session-cookie.service';

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
