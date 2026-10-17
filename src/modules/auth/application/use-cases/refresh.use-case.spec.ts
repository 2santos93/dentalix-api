import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { RefreshUseCase } from './refresh.use-case';
import { SessionClaimsService } from '../session-claims.service';
import type {
  AuthRepository,
  SessionState,
} from '../../domain/ports/auth-repository.port';

const EXP = 1893456000;

const tenantPayload = {
  sub: 'u1',
  tenantId: 't1',
  role: ClinicRole.ADMIN,
  tv: 0,
  jti: 'jti-1',
  exp: EXP,
};

const platformPayload = {
  sub: 'u1',
  platform: true as const,
  tv: 0,
  jti: 'jti-p',
  exp: EXP,
};

function activeMember(role: ClinicRole, tokenVersion = 0): SessionState {
  return {
    tokenVersion,
    isPlatformAdmin: false,
    tenant: { membershipRole: role },
  };
}

function setup(opts: {
  payload?: object;
  verifyError?: boolean;
  state: SessionState | null;
  consumed?: boolean;
}) {
  const tokens = {
    verifyRefresh: opts.verifyError
      ? jest.fn().mockRejectedValue(new Error('bad token'))
      : jest.fn().mockResolvedValue(opts.payload ?? tenantPayload),
    issue: jest
      .fn()
      .mockResolvedValue({ accessToken: 'new-acc', refreshToken: 'new-ref' }),
  };
  const repo = {
    findSessionState: jest.fn().mockResolvedValue(opts.state),
    consumeRefreshToken: jest.fn().mockResolvedValue(opts.consumed ?? true),
  };
  const uc = new RefreshUseCase(
    tokens as never,
    repo as never,
    new SessionClaimsService(repo as unknown as AuthRepository),
  );
  return { uc, tokens, repo };
}

describe('RefreshUseCase', () => {
  it('re-issues from CURRENT state and consumes the used jti (rotation)', async () => {
    const { uc, tokens, repo } = setup({
      state: activeMember(ClinicRole.ADMIN),
    });

    const result = await uc.execute({ refreshToken: 'old-ref' });

    expect(result).toEqual({ accessToken: 'new-acc', refreshToken: 'new-ref' });
    expect(repo.findSessionState).toHaveBeenCalledWith('u1', 't1');
    expect(repo.consumeRefreshToken).toHaveBeenCalledWith(
      'jti-1',
      new Date(EXP * 1000),
    );
    expect(tokens.issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.ADMIN,
      tv: 0,
    });
  });

  it('uses the CURRENT membership role, not the one in the old token', async () => {
    const { uc, tokens } = setup({
      state: activeMember(ClinicRole.ASSISTANT),
    });

    await uc.execute({ refreshToken: 'old-ref' });

    expect(tokens.issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.ASSISTANT,
      tv: 0,
    });
  });

  it('rejects (401) when the membership is no longer active', async () => {
    const { uc, tokens, repo } = setup({
      state: {
        tokenVersion: 0,
        isPlatformAdmin: false,
        tenant: { membershipRole: null },
      },
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(repo.consumeRefreshToken).not.toHaveBeenCalled();
  });

  it('rejects (401) when the clinic no longer exists', async () => {
    const { uc, tokens } = setup({
      state: { tokenVersion: 0, isPlatformAdmin: true, tenant: null },
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects (401) when the user no longer exists (or was deleted)', async () => {
    const { uc, tokens } = setup({ state: null });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('SEC-008: NO renueva la sesión de clínica de un superadmin sin membresía (los refresh de antes)', async () => {
    const { uc, tokens, repo } = setup({
      state: {
        tokenVersion: 0,
        isPlatformAdmin: true,
        tenant: { membershipRole: null },
      },
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(repo.consumeRefreshToken).not.toHaveBeenCalled();
  });

  it('SEC-008: rechaza un refresh break-glass sin mirar la BD', async () => {
    const { uc, tokens, repo } = setup({
      payload: { ...tenantPayload, breakGlass: true },
      state: activeMember(ClinicRole.ADMIN),
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.findSessionState).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('renews a platform session while the user is still platform admin', async () => {
    const { uc, tokens, repo } = setup({
      payload: platformPayload,
      state: { tokenVersion: 0, isPlatformAdmin: true, tenant: null },
    });

    await uc.execute({ refreshToken: 'old-ref' });

    expect(repo.findSessionState).toHaveBeenCalledWith('u1', null);
    expect(tokens.issue).toHaveBeenCalledWith({
      sub: 'u1',
      platform: true,
      tv: 0,
    });
  });

  it('rejects (401) a platform session whose platform-admin flag was revoked', async () => {
    const { uc, tokens } = setup({
      payload: platformPayload,
      state: { tokenVersion: 0, isPlatformAdmin: false, tenant: null },
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects (401) a reused jti: the refresh token is single-use', async () => {
    // consumeRefreshToken === false → el jti ya estaba en la denylist (otro
    // refresh concurrente lo ganó, o se cerró la sesión con /auth/logout).
    const { uc, tokens } = setup({
      state: activeMember(ClinicRole.ADMIN),
      consumed: false,
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects (401) a token minted before the last password change', async () => {
    const { uc, tokens, repo } = setup({
      state: activeMember(ClinicRole.ADMIN, 1),
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(repo.consumeRefreshToken).not.toHaveBeenCalled();
  });

  it('accepts a legacy token without `tv` while the user is still on version 0', async () => {
    const legacy = { ...tenantPayload, tv: undefined };
    const { uc, tokens } = setup({
      payload: legacy,
      state: activeMember(ClinicRole.DENTIST),
    });

    await uc.execute({ refreshToken: 'old-ref' });

    expect(tokens.issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.DENTIST,
      tv: 0,
    });
  });

  it('rejects (401) a legacy token without `tv` once the user changed the password', async () => {
    // Sin claim `tv` cuenta como versión 0: tras un cambio de contraseña
    // (tokenVersion=1) un token anterior al despliegue también muere.
    const legacy = { ...tenantPayload, tv: undefined };
    const { uc, tokens, repo } = setup({
      payload: legacy,
      state: activeMember(ClinicRole.DENTIST, 1),
    });

    await expect(
      uc.execute({ refreshToken: 'old-ref' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(repo.consumeRefreshToken).not.toHaveBeenCalled();
  });

  describe('tenant of the session (DX-062)', () => {
    it('rejects (401) a clinic token presented on ANOTHER clinic host, without consuming it', async () => {
      const { uc, tokens, repo } = setup({
        state: activeMember(ClinicRole.ADMIN),
      });

      await expect(
        uc.execute({ refreshToken: 'old-ref', expectedTenantId: 't2' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issue).not.toHaveBeenCalled();
      expect(repo.consumeRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects (401) a clinic token presented on the apex (no clinic host)', async () => {
      const { uc, tokens } = setup({ state: activeMember(ClinicRole.ADMIN) });

      await expect(
        uc.execute({ refreshToken: 'old-ref', expectedTenantId: null }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('rejects (401) a platform token presented on a clinic host', async () => {
      const { uc, tokens } = setup({
        payload: platformPayload,
        state: { tokenVersion: 0, isPlatformAdmin: true, tenant: null },
      });

      await expect(
        uc.execute({ refreshToken: 'old-ref', expectedTenantId: 't1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('renews when the host is the clinic of the token', async () => {
      const { uc, tokens } = setup({ state: activeMember(ClinicRole.ADMIN) });

      await uc.execute({ refreshToken: 'old-ref', expectedTenantId: 't1' });

      expect(tokens.issue).toHaveBeenCalled();
    });

    it('renews a platform token on the apex', async () => {
      const { uc, tokens } = setup({
        payload: platformPayload,
        state: { tokenVersion: 0, isPlatformAdmin: true, tenant: null },
      });

      await uc.execute({ refreshToken: 'old-ref', expectedTenantId: null });

      expect(tokens.issue).toHaveBeenCalled();
    });
  });

  it('rejects when the refresh token is invalid/expired', async () => {
    const { uc, tokens, repo } = setup({ verifyError: true, state: null });

    await expect(
      uc.execute({ refreshToken: 'garbage' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.issue).not.toHaveBeenCalled();
    expect(repo.findSessionState).not.toHaveBeenCalled();
  });
});
