import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetDeviceDraftKeyUseCase } from './get-device-draft-key.use-case';
import type { DraftKeyGate } from '../../domain/ports/draft-key-gate.port';

const SECRET = 'solo-test-drafts-7c1e4a9b2d5f8e3a6c0b9d2e5f8a1c4b';
const USER = {
  sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: '11111111-1111-4111-8111-111111111111',
  role: 'DENTIST' as const,
  sid: '99999999-9999-4999-8999-999999999999',
  tv: 2,
};

function useCase(live: number | null, secret: string | undefined = SECRET) {
  const liveTokenVersion = jest.fn(() => Promise.resolve(live));
  const gate: DraftKeyGate = { liveTokenVersion };
  const config = new ConfigService({ DEVICE_DRAFT_KEY_SECRET: secret });
  return { uc: new GetDeviceDraftKeyUseCase(gate, config), liveTokenVersion };
}

describe('GetDeviceDraftKeyUseCase (DX-574)', () => {
  it('con la sesión viva y la versión vigente entrega 32 bytes', async () => {
    const { uc, liveTokenVersion } = useCase(2);
    const res = await uc.execute(USER);
    expect(Buffer.from(res.key, 'base64')).toHaveLength(32);
    expect(liveTokenVersion).toHaveBeenCalledWith({
      userId: USER.sub,
      tenantId: USER.tenantId,
      sessionId: USER.sid,
    });
  });

  it('la clave cambia cuando sube la tokenVersion', async () => {
    const before = await useCase(2).uc.execute(USER);
    const after = await useCase(3).uc.execute({ ...USER, tv: 3 });
    expect(after.key).not.toBe(before.key);
  });

  it('token con una versión vieja: 401', async () => {
    await expect(useCase(3).uc.execute(USER)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('sesión revocada, membresía o clínica inactivas (gate null): 401', async () => {
    await expect(useCase(null).uc.execute(USER)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('token sin familia de sesión: 401', async () => {
    await expect(
      useCase(2).uc.execute({ ...USER, sid: undefined }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('break-glass: 403', async () => {
    await expect(
      useCase(2).uc.execute({ ...USER, breakGlass: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin secreto configurado: avisa al construirse (arranque) y el endpoint da 503', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { uc } = useCase(2, '');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('DEVICE_DRAFT_KEY_SECRET no está configurada'),
    );
    warn.mockRestore();
    await expect(uc.execute(USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('sin secreto configurado: 503', async () => {
    await expect(useCase(2, '').uc.execute(USER)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
