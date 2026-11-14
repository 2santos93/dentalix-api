import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { LoginUseCase } from './login.use-case';
import { AuthRepository } from '../../domain/ports/auth-repository.port';
import { DUMMY_PASSWORD_HASH } from '../../../../shared/crypto/password.service';
import { TestPasswordHasher } from '../../../../shared/testing/test-password-hasher';

// Un miembro de la clínica nunca pasa por el break-glass (SEC-008).
const unusedBreakGlass = {
  open: () => Promise.reject(new Error('break-glass no esperado')),
} as never;

/** DX-021: miembro sin MFA y sin obligación (el login de siempre). */
const noMfa = {
  state: () => Promise.resolve({ enabledAt: null, isPlatformAdmin: false }),
  isRequired: () => Promise.resolve(false),
  isTrustedDevice: () => Promise.resolve(false),
} as never;
const unusedChallenges = {
  issue: () => Promise.reject(new Error('paso MFA no esperado')),
} as never;

const password = new TestPasswordHasher();

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
    rotateRefreshSession: jest.fn(),
    revokeRefreshSession: jest.fn(),
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
      allowedLocationIds: null,
    });
    const uc = new LoginUseCase(
      repo,
      password,
      tokens,
      unusedBreakGlass,
      noMfa,
      unusedChallenges,
      {} as never,
    );
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
      allowedLocationIds: null,
    });
    const issue = jest
      .fn()
      .mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' });
    const uc = new LoginUseCase(
      repo,
      password,
      { issue } as never,
      unusedBreakGlass,
      noMfa,
      unusedChallenges,
      {} as never,
    );
    await uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'S3cret!' });
    expect(issue).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: ClinicRole.DENTIST,
      tv: 5,
    });
  });

  describe('sedes permitidas en el token (DX-089)', () => {
    async function issuedFor(
      role: ClinicRole,
      allowedLocationIds: string[] | null,
    ): Promise<unknown> {
      const hash = await password.hash('S3cret!');
      const repo = makeRepo({
        userId: 'u1',
        passwordHash: hash,
        role,
        tokenVersion: 0,
        allowedLocationIds,
      });
      const issue = jest
        .fn()
        .mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' });
      const uc = new LoginUseCase(
        repo,
        password,
        { issue } as never,
        unusedBreakGlass,
        noMfa,
        unusedChallenges,
        {} as never,
      );
      await uc.execute({
        tenantId: 't1',
        email: 'a@b.com',
        password: 'S3cret!',
      });
      return (issue.mock.calls as unknown[][])[0][0];
    }

    it('un miembro restringido lleva `loc` con sus sedes', async () => {
      await expect(
        issuedFor(ClinicRole.RECEPTION, ['loc-a', 'loc-b']),
      ).resolves.toEqual({
        sub: 'u1',
        tenantId: 't1',
        role: ClinicRole.RECEPTION,
        tv: 0,
        loc: ['loc-a', 'loc-b'],
      });
    });

    it('restringido a sedes ya inactivas → `loc: []` (nunca todas)', async () => {
      await expect(issuedFor(ClinicRole.DENTIST, [])).resolves.toMatchObject({
        loc: [],
      });
    });

    it('sin filas → sin claim `loc` (todas las sedes)', async () => {
      const claims = await issuedFor(ClinicRole.RECEPTION, null);
      expect(claims).not.toHaveProperty('loc');
    });

    it('ADMIN nunca lleva `loc`, aunque tuviera filas', async () => {
      const claims = await issuedFor(ClinicRole.ADMIN, ['loc-a']);
      expect(claims).not.toHaveProperty('loc');
    });
  });

  describe('DX-021: segundo factor', () => {
    async function memberRepo(role: ClinicRole = ClinicRole.ADMIN) {
      return makeRepo({
        userId: 'u1',
        role,
        passwordHash: await password.hash('S3cret!'),
        tokenVersion: 7,
        allowedLocationIds: null,
      });
    }
    const challenges = {
      issue: jest.fn().mockResolvedValue({
        token: 'mfa-token',
        expiresAt: new Date('2026-11-01T10:05:00Z'),
      }),
    };
    const issue = jest.fn();

    beforeEach(() => {
      challenges.issue.mockClear();
      issue.mockReset();
    });

    it('con el MFA activo: solo el token intermedio (ni access ni refresh)', async () => {
      const mfa = {
        state: () =>
          Promise.resolve({ enabledAt: new Date(), isPlatformAdmin: false }),
        isRequired: () => Promise.resolve(false),
        isTrustedDevice: () => Promise.resolve(false),
      };
      const uc = new LoginUseCase(
        await memberRepo(ClinicRole.DENTIST),
        password,
        { issue } as never,
        unusedBreakGlass,
        mfa as never,
        challenges as never,
        {} as never,
      );
      const result = await uc.execute({
        tenantId: 't1',
        email: 'a@b.com',
        password: 'S3cret!',
      });
      expect(result).toEqual({
        mfa: 'MFA_REQUIRED',
        mfaToken: 'mfa-token',
        expiresAt: new Date('2026-11-01T10:05:00Z'),
      });
      expect(issue).not.toHaveBeenCalled();
      expect(challenges.issue).toHaveBeenCalledWith({
        userId: 'u1',
        tenantId: 't1',
        tokenVersion: 7,
        purpose: 'MFA_VERIFY',
      });
    });

    /** SEC-066: el alta forzada de un miembro también lleva código al correo. */
    function enrollingUseCase(repo: AuthRepository, delivered = true) {
      const sent: unknown[] = [];
      const mfa = {
        state: () =>
          Promise.resolve({
            enabledAt: null,
            isPlatformAdmin: false,
            email: 'ana@clinica.co',
          }),
        isRequired: () => Promise.resolve(true),
        isTrustedDevice: () => Promise.resolve(false),
      };
      const enrollChallenges = {
        issue: jest.fn().mockResolvedValue({
          token: 'mfa-token',
          expiresAt: new Date('2026-11-01T10:10:00Z'),
          jti: 'jti-1',
        }),
        emailCode: (jti: string) => (jti === 'jti-1' ? '12345678' : 'otro'),
        emailCodeRef: (jti: string) => (jti === 'jti-1' ? 'A1F3' : 'otro'),
      };
      const notifier = {
        sendEnrollmentCode: (input: unknown) => {
          sent.push(input);
          return Promise.resolve(delivered);
        },
      };
      const uc = new LoginUseCase(
        repo,
        password,
        { issue } as never,
        unusedBreakGlass,
        mfa as never,
        enrollChallenges as never,
        notifier as never,
      );
      return { uc, sent, enrollChallenges };
    }

    it('obligatorio y sin activar: alta forzada, sin tokens de sesión', async () => {
      const { uc, enrollChallenges } = enrollingUseCase(await memberRepo());
      const result = await uc.execute({
        tenantId: 't1',
        email: 'a@b.com',
        password: 'S3cret!',
      });
      expect(result).toMatchObject({ mfa: 'MFA_ENROLLMENT_REQUIRED' });
      expect(issue).not.toHaveBeenCalled();
      expect(enrollChallenges.issue).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'MFA_ENROLL', tenantId: 't1' }),
      );
    });

    it('SEC-066: el alta forzada de un miembro (no superadmin) envía el código a su correo, como la del superadmin', async () => {
      const { uc, sent } = enrollingUseCase(
        await memberRepo(ClinicRole.RECEPTION),
      );
      const result = await uc.execute({
        tenantId: 't1',
        email: 'a@b.com',
        password: 'S3cret!',
        ip: '10.0.0.1',
      });
      expect(result).toEqual({
        mfa: 'MFA_ENROLLMENT_REQUIRED',
        mfaToken: 'mfa-token',
        expiresAt: new Date('2026-11-01T10:10:00Z'),
        emailCodeRequired: true,
        emailCodeRef: 'A1F3',
      });
      // Al correo de la CUENTA, no al que se escribió en el formulario.
      expect(sent).toEqual([
        {
          userId: 'u1',
          ip: '10.0.0.1',
          to: 'ana@clinica.co',
          code: '12345678',
          ref: 'A1F3',
          expiresInMinutes: 10,
        },
      ]);
    });

    it('SEC-066: si el correo del miembro no sale, no dice que salió: 429 con la espera', async () => {
      const { uc } = enrollingUseCase(
        await memberRepo(ClinicRole.RECEPTION),
        false,
      );
      await expect(
        uc.execute({
          tenantId: 't1',
          email: 'a@b.com',
          password: 'S3cret!',
          ip: '10.0.0.1',
        }),
      ).rejects.toMatchObject({ retryAfterSeconds: 60 });
    });

    it('con el MFA activo no se envía ningún correo', async () => {
      const sendEnrollmentCode = jest.fn();
      const mfa = {
        state: () =>
          Promise.resolve({ enabledAt: new Date(), isPlatformAdmin: false }),
        isRequired: () => Promise.resolve(true),
        isTrustedDevice: () => Promise.resolve(false),
      };
      const uc = new LoginUseCase(
        await memberRepo(ClinicRole.RECEPTION),
        password,
        { issue } as never,
        unusedBreakGlass,
        mfa as never,
        challenges as never,
        { sendEnrollmentCode } as never,
      );
      const result = await uc.execute({
        tenantId: 't1',
        email: 'a@b.com',
        password: 'S3cret!',
      });
      expect(result).not.toHaveProperty('emailCodeRequired');
      expect(sendEnrollmentCode).not.toHaveBeenCalled();
    });

    it('con la contraseña mala ni siquiera se mira el MFA', async () => {
      const state = jest.fn();
      const uc = new LoginUseCase(
        await memberRepo(),
        password,
        { issue } as never,
        unusedBreakGlass,
        { state, isRequired: jest.fn() } as never,
        challenges as never,
        {} as never,
      );
      await expect(
        uc.execute({ tenantId: 't1', email: 'a@b.com', password: 'mala' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(state).not.toHaveBeenCalled();
      expect(challenges.issue).not.toHaveBeenCalled();
    });
  });

  it('rejects when there is no membership', async () => {
    const uc = new LoginUseCase(
      makeRepo(null),
      password,
      tokens,
      unusedBreakGlass,
      noMfa,
      unusedChallenges,
      {} as never,
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
      allowedLocationIds: null,
    });
    const uc = new LoginUseCase(
      repo,
      password,
      tokens,
      unusedBreakGlass,
      noMfa,
      unusedChallenges,
      {} as never,
    );
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
        noMfa,
        unusedChallenges,
        {} as never,
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
      const uc = new LoginUseCase(
        repo,
        password,
        tokens,
        unusedBreakGlass,
        noMfa,
        unusedChallenges,
        {} as never,
      );
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
        noMfa,
        unusedChallenges,
        {} as never,
      );
      await expect(
        uc.executePlatform({ email: 'nadie@x.com', password: 'pw' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
      expect(spy).toHaveBeenCalledWith('pw', DUMMY_PASSWORD_HASH);
      spy.mockRestore();
    });
  });
});
