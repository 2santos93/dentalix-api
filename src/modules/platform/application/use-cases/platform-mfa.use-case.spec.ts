import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlatformMfaState } from '../../domain/ports/platform-mfa-repository.port';
import { PlatformMfaUseCase } from './platform-mfa.use-case';

const USER = '6f0c3f9e-7d1b-4c2a-9e1f-0a1b2c3d4e5f';
const ACTOR = { userId: USER, requestId: 'r', ip: null, userAgent: null };

function setup(state: PlatformMfaState | null) {
  const regenerateRecoveryCodes = jest.fn().mockResolvedValue(['A']);
  const useCase = new PlatformMfaUseCase(
    { find: () => Promise.resolve(state) },
    { regenerateRecoveryCodes } as never,
    new ConfigService({ BREAK_GLASS_MFA_COOLDOWN_MINUTES: '60' }),
  );
  return { useCase, regenerateRecoveryCodes };
}

describe('PlatformMfaUseCase (SEC-008, DX-021-bis)', () => {
  it('da la fecha desde la que sirve el break-glass y los códigos que quedan', async () => {
    const enabledAt = new Date('2026-11-01T10:00:00.000Z');
    const { useCase } = setup({ enabledAt, recoveryCodesRemaining: 7 });
    await expect(useCase.status(USER)).resolves.toEqual({
      enabled: true,
      enabledAt,
      breakGlassAvailableAt: new Date('2026-11-01T11:00:00.000Z'),
      recoveryCodesRemaining: 7,
    });
  });

  it('sin MFA no hay fecha ni códigos', async () => {
    const { useCase } = setup({ enabledAt: null, recoveryCodesRemaining: 3 });
    await expect(useCase.status(USER)).resolves.toEqual({
      enabled: false,
      enabledAt: null,
      breakGlassAvailableAt: null,
      recoveryCodesRemaining: 0,
    });
  });

  it('403 si ya no es superadmin', async () => {
    const { useCase } = setup(null);
    await expect(useCase.status(USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('renovar los códigos audita en plataforma: el actor va sin clínica', async () => {
    const { useCase, regenerateRecoveryCodes } = setup({
      enabledAt: new Date(),
      recoveryCodesRemaining: 0,
    });
    await useCase.regenerateRecoveryCodes(ACTOR, 'pw', { code: '123456' });
    expect(regenerateRecoveryCodes).toHaveBeenCalledWith(
      USER,
      'pw',
      { code: '123456' },
      ACTOR,
    );
  });
});
