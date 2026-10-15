import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { ChangeMyPasswordUseCase } from './change-my-password.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import type { SessionClaimsService } from '../../../auth/application/session-claims.service';
import type { TenantJwtPayload } from '../../../../shared/crypto/token.service';

const password = new PasswordService();

const session: TenantJwtPayload = {
  sub: 'u1',
  tenantId: 't1',
  role: ClinicRole.DENTIST,
};

function setup(hash: string | null) {
  const sink: { saved?: string } = {};
  const repo = {
    getPasswordHash: () => Promise.resolve(hash),
    updatePasswordAndRevokeSessions: jest.fn(
      (_userId: string, newHash: string) => {
        sink.saved = newHash;
        return Promise.resolve(4);
      },
    ),
  };
  const claims = {
    current: jest.fn().mockResolvedValue({
      claims: { sub: 'u1', tenantId: 't1', role: ClinicRole.ASSISTANT },
      tokenVersion: 3,
    }),
  };
  const tokens = {
    issue: jest
      .fn()
      .mockResolvedValue({ accessToken: 'new-acc', refreshToken: 'new-ref' }),
  };
  const uc = new ChangeMyPasswordUseCase(
    repo as unknown as UserProfileRepository,
    password,
    claims as unknown as SessionClaimsService,
    tokens as never,
  );
  return { uc, repo, claims, tokens, sink };
}

describe('ChangeMyPasswordUseCase', () => {
  it('re-hashes the password, revokes previous sessions and returns a fresh pair', async () => {
    const { uc, repo, tokens, sink } = setup(await password.hash('OldPass1'));

    const result = await uc.execute({
      session,
      currentPassword: 'OldPass1',
      newPassword: 'NewPass9',
    });

    expect(sink.saved).toBeDefined();
    expect(await password.verify('NewPass9', sink.saved!)).toBe(true);
    expect(repo.updatePasswordAndRevokeSessions).toHaveBeenCalledWith(
      'u1',
      sink.saved,
    );
    // El par nuevo lleva la versión NUEVA (la que devolvió el bump) y los
    // claims ACTUALES de la sesión (rol vigente, no el del access token).
    expect(tokens.issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.ASSISTANT,
      tv: 4,
    });
    expect(result).toEqual({ accessToken: 'new-acc', refreshToken: 'new-ref' });
  });

  it('does not touch the password when the session is no longer valid', async () => {
    const { uc, repo, claims, tokens } = setup(await password.hash('OldPass1'));
    claims.current.mockRejectedValue(new UnauthorizedException());

    await expect(
      uc.execute({
        session,
        currentPassword: 'OldPass1',
        newPassword: 'NewPass9',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.updatePasswordAndRevokeSessions).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects when the current password is wrong', async () => {
    const { uc, repo, tokens } = setup(await password.hash('OldPass1'));
    await expect(
      uc.execute({
        session,
        currentPassword: 'WRONG',
        newPassword: 'NewPass9',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.updatePasswordAndRevokeSessions).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects when the user has no stored hash', async () => {
    const { uc } = setup(null);
    await expect(
      uc.execute({
        session,
        currentPassword: 'x',
        newPassword: 'NewPass9',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
