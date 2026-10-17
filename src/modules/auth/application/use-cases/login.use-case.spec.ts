import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { LoginUseCase } from './login.use-case';
import { AuthRepository } from '../../domain/ports/auth-repository.port';
import {
  DUMMY_PASSWORD_HASH,
  PasswordService,
} from '../../../../shared/crypto/password.service';

// Un miembro de la clínica nunca pasa por el break-glass (SEC-008).
const unusedBreakGlass = {
  open: () => Promise.reject(new Error('break-glass no esperado')),
} as never;

const password = new PasswordService();

function makeRepo(
  membership: Awaited<ReturnType<AuthRepository['findMembership']>>,
): AuthRepository {
  return {
    findUserByEmail: () => Promise.resolve(null),
    findUserForAuth: () => Promise.resolve(null),
    findTenantBySubdomain: () => Promise.resolve(null),
    createClinicWithOwner: () =>
      Promise.resolve({ tenantId: 't1', userId: 'u1' }),
    findMembership: () => Promise.resolve(membership),
    revokeToken: jest.fn(),
    findSessionState: jest.fn(),
    consumeRefreshToken: jest.fn(),
  };
}

const tokens = {
  issue: () => Promise.resolve({ accessToken: 'acc', refreshToken: 'ref' }),
} as never;

describe('LoginUseCase', () => {
  it('returns tokens for valid credentials', async () => {
    const hash = await password.hash('S3cret!');
    const repo = makeRepo({
      userId: 'u1',
      passwordHash: hash,
      role: ClinicRole.ADMIN,
      tokenVersion: 0,
    });
    const uc = new LoginUseCase(repo, password, tokens, unusedBreakGlass);
    const result = await uc.execute({
      tenantId: 't1',
      email: 'A@B.com',
      password: 'S3cret!',
    });
    expect(result).toEqual({ accessToken: 'acc', refreshToken: 'ref' });
  });

  it("stamps the user's CURRENT session version (tv) on the issued pair", async () => {
    const hash = await password.hash('S3cret!');
    const repo = makeRepo({
      userId: 'u1',
      passwordHash: hash,
      role: ClinicRole.DENTIST,
      tokenVersion: 5,
    });
    const issue = jest
      .fn()
      .mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' });
    const uc = new LoginUseCase(
      repo,
      password,
      { issue } as never,
      unusedBreakGlass,
    );
    await uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'S3cret!' });
    expect(issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.DENTIST,
      tv: 5,
    });
  });

  it('rejects when there is no membership', async () => {
    const uc = new LoginUseCase(
      makeRepo(null),
      password,
      tokens,
      unusedBreakGlass,
    );
    await expect(
      uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'x' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const hash = await password.hash('right');
    const repo = makeRepo({
      userId: 'u1',
      passwordHash: hash,
      role: ClinicRole.ADMIN,
      tokenVersion: 0,
    });
    const uc = new LoginUseCase(repo, password, tokens, unusedBreakGlass);
    await expect(
      uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'wrong' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // SEC-017: sin usuario/membresía no se responde antes que con un usuario
  // real. Se verifica contra un hash ficticio constante para que el coste de
  // argon2 sea el mismo y el tiempo de respuesta no delate el email.
  describe('timing parity (SEC-017)', () => {
    it('runs argon2 against the dummy hash when the email does not exist', async () => {
      const spy = jest.spyOn(password, 'verify');
      const uc = new LoginUseCase(
        makeRepo(null),
        password,
        tokens,
        unusedBreakGlass,
      );
      await expect(
        uc.execute({ tenantId: 't1', email: 'nadie@x.com', password: 'pw' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('pw', DUMMY_PASSWORD_HASH);
      spy.mockRestore();
    });

    it('runs argon2 against the dummy hash when the user exists but is not a member nor superadmin', async () => {
      const repo = makeRepo(null);
      repo.findUserForAuth = () =>
        Promise.resolve({
          id: 'u9',
          passwordHash: 'real-hash-never-checked',
          isPlatformAdmin: false,
          tokenVersion: 0,
        });
      const spy = jest.spyOn(password, 'verify');
      const uc = new LoginUseCase(repo, password, tokens, unusedBreakGlass);
      await expect(
        uc.execute({ tenantId: 't1', email: 'otra@x.com', password: 'pw' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('pw', DUMMY_PASSWORD_HASH);
      spy.mockRestore();
    });

    it('runs argon2 against the dummy hash on the apex login when the email does not exist', async () => {
      const spy = jest.spyOn(password, 'verify');
      const uc = new LoginUseCase(
        makeRepo(null),
        password,
        tokens,
        unusedBreakGlass,
      );
      await expect(
        uc.executePlatform({ email: 'nadie@x.com', password: 'pw' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
      expect(spy).toHaveBeenCalledWith('pw', DUMMY_PASSWORD_HASH);
      spy.mockRestore();
    });
  });
});
