import { NotFoundException } from '@nestjs/common';
import type { RequestPasswordResetUseCase } from '../application/use-cases/request-password-reset.use-case';
import type { ResetPasswordUseCase } from '../application/use-cases/reset-password.use-case';
import type { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import {
  FORGOT_PASSWORD_MESSAGE,
  PasswordResetController,
} from './password-reset.controller';

// SEC-033: el controlador arma el enlace con TenantLinkBaseService (host de
// plataforma de la clínica) y siempre responde el mismo 202.
describe('PasswordResetController.forgotPassword (SEC-033)', () => {
  const accept = jest.fn();
  const forTenant = jest.fn();
  const controller = new PasswordResetController(
    { accept } as unknown as RequestPasswordResetUseCase,
    {} as unknown as ResetPasswordUseCase,
    { forTenant } as unknown as TenantLinkBaseService,
  );
  const req = (host: string | undefined, tenantId: string | null) =>
    ({ headers: {}, tenantHost: { host, tenantId } }) as never;

  beforeEach(() => {
    accept.mockReset();
    forTenant.mockReset();
  });

  it('pasa al caso de uso el linkBase de plataforma que resuelve el servicio, no el host de la petición', async () => {
    forTenant.mockResolvedValue('https://demo.dentalix.app');
    await expect(
      controller.forgotPassword(req('clinica-propia.com', 't1'), {
        email: 'a@b.co',
      }),
    ).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(forTenant).toHaveBeenCalledWith('t1', 'clinica-propia.com');
    expect(accept).toHaveBeenCalledWith({
      tenantId: 't1',
      email: 'a@b.co',
      linkBase: 'https://demo.dentalix.app',
    });
  });

  it('host no reconocido (sin clínica): mismo 202 y no se envía nada', async () => {
    await expect(
      controller.forgotPassword(req('evil.example', null), { email: 'a@b.co' }),
    ).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(forTenant).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('sin host de plataforma posible: mismo 202 y no se envía nada', async () => {
    forTenant.mockResolvedValue(null);
    await expect(
      controller.forgotPassword(req('clinica-propia.com', 't1'), {
        email: 'a@b.co',
      }),
    ).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(accept).not.toHaveBeenCalled();
  });

  it('si falla la lectura del subdominio: mismo 202 (nunca un 500) y no se envía nada', async () => {
    forTenant.mockRejectedValue(new Error('db caída'));
    await expect(
      controller.forgotPassword(req('clinica-propia.com', 't1'), {
        email: 'a@b.co',
      }),
    ).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe('PasswordResetController.reset (DX-114)', () => {
  it('host sin clínica: 404 con code RESET_TOKEN_INVALID, sin llamar al caso de uso', async () => {
    const execute = jest.fn();
    const controller = new PasswordResetController(
      {} as unknown as RequestPasswordResetUseCase,
      { execute } as unknown as ResetPasswordUseCase,
      {} as unknown as TenantLinkBaseService,
    );
    const err: unknown = await controller
      .reset(
        { headers: {}, tenantHost: { host: 'x', tenantId: null } },
        {
          token: 'A'.repeat(43),
          password: 'NuevaClave2026',
        },
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({
      statusCode: 404,
      code: 'RESET_TOKEN_INVALID',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
