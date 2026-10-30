import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { ChangeMyPasswordUseCase } from './change-my-password.use-case';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import type { SessionClaimsService } from '../../../auth/application/session-claims.service';
import type { TenantJwtPayload } from '../../../../shared/crypto/token.service';

const password = new PasswordService();

// DX-359: desde dónde llega el cambio.
const REQ = { requestId: 'req-1', ip: '10.0.0.1', userAgent: 'jest' };

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
  it('DX-359: con sesión de clínica deja PASSWORD_CHANGE en su auditoría, solo el hecho (sin contraseña ni hash)', async () => {
    const { uc, repo, sink } = setup(await password.hash('OldPass1'));
    await uc.execute(
      {
        session,
        currentPassword: 'OldPass1',
        newPassword: 'NewPass9',
        locationId: 'loc-activa',
      },
      REQ,
    );
    const [, , audit] = repo.updatePasswordAndRevokeSessions.mock
      .calls[0] as unknown as [string, string, unknown];
    expect(audit).toEqual({
      kind: 'tenant',
      event: {
        tenantId: 't1',
        // La sede activa del actor (DX-359, revisión).
        locationId: 'loc-activa',
        // El rol vigente de la sesión (claims actuales), no el del token.
        actor: { kind: 'user', userId: 'u1', role: ClinicRole.ASSISTANT },
        patient: null,
        requestId: 'req-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
        action: 'PASSWORD_CHANGE',
        resourceType: 'SESSION',
        resourceId: null,
        metadata: { reason: 'SESSIONS_REVOKED' },
      },
    });
    const stored = JSON.stringify(audit);
    for (const secret of ['OldPass1', 'NewPass9', sink.saved!]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('DX-359: con sesión de plataforma va a platform_audit_events', async () => {
    const { uc, repo, claims } = setup(await password.hash('OldPass1'));
    claims.current.mockResolvedValue({
      claims: { sub: 'u1', platform: true },
      tokenVersion: 3,
    });
    await uc.execute(
      {
        session: { sub: 'u1', platform: true },
        currentPassword: 'OldPass1',
        newPassword: 'NewPass9',
        locationId: null,
      },
      REQ,
    );
    expect(repo.updatePasswordAndRevokeSessions).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      {
        kind: 'platform',
        event: {
          actor: { userId: 'u1', ...REQ },
          action: 'PASSWORD_CHANGE',
          resourceType: 'USER',
          resourceId: 'u1',
        },
      },
    );
  });

  it('re-hashes the password, revokes previous sessions and returns a fresh pair', async () => {
    const { uc, repo, tokens, sink } = setup(await password.hash('OldPass1'));

    const result = await uc.execute(
      {
        session,
        currentPassword: 'OldPass1',
        newPassword: 'NewPass9',
        locationId: null,
      },
      REQ,
    );

    expect(sink.saved).toBeDefined();
    expect(await password.verify('NewPass9', sink.saved!)).toBe(true);
    expect(repo.updatePasswordAndRevokeSessions).toHaveBeenCalledWith(
      'u1',
      sink.saved,
      expect.anything(),
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
    // La sesión se valida ANTES de verificar la contraseña: una sesión muerta
    // no debe poder usarse como oráculo de la contraseña actual (ni gastar un
    // argon2.verify).
    const verify = jest.spyOn(password, 'verify');

    await expect(
      uc.execute(
        {
          session,
          currentPassword: 'OldPass1',
          newPassword: 'NewPass9',
          locationId: null,
        },
        REQ,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
    verify.mockRestore();
    expect(repo.updatePasswordAndRevokeSessions).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects when the current password is wrong', async () => {
    const { uc, repo, tokens } = setup(await password.hash('OldPass1'));
    await expect(
      uc.execute(
        {
          session,
          currentPassword: 'WRONG',
          newPassword: 'NewPass9',
          locationId: null,
        },
        REQ,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.updatePasswordAndRevokeSessions).not.toHaveBeenCalled();
    expect(tokens.issue).not.toHaveBeenCalled();
  });

  it('rejects when the user has no stored hash', async () => {
    const { uc } = setup(null);
    await expect(
      uc.execute(
        {
          session,
          currentPassword: 'x',
          newPassword: 'NewPass9',
          locationId: null,
        },
        REQ,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
