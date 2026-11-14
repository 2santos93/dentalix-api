import { UnauthorizedException } from '@nestjs/common';
import { LoginUseCase } from './login.use-case';
import type {
  BreakGlassInput,
  BreakGlassService,
} from '../break-glass.service';
import {
  AuthRepository,
  AuthUserRecord,
} from '../../domain/ports/auth-repository.port';
import { TestPasswordHasher } from '../../../../shared/testing/test-password-hasher';
import { IssuablePayload } from '../../../../shared/crypto/token.service';

const password = new TestPasswordHasher();

/**
 * Repo con NINGUNA membresía (`findMembership` → null): es exactamente la
 * situación del superadmin de plataforma en la clínica de un cliente, y la que
 * antes de esta feature terminaba siempre en 401.
 */
function makeRepo(user: AuthUserRecord | null): AuthRepository {
  return {
    findUserByEmail: () => Promise.resolve(null),
    findUserForAuth: () => Promise.resolve(user),
    findTenantBySubdomain: () => Promise.resolve(null),
    createClinicWithOwner: () =>
      Promise.resolve({ tenantId: 't1', userId: 'u1' }),
    findMembership: () => Promise.resolve(null),
    revokeToken: jest.fn(),
    findSessionState: jest.fn(),
    consumeRefreshToken: jest.fn(),
    rotateRefreshSession: jest.fn(),
    revokeRefreshSession: jest.fn(),
  };
}

/** Captura el payload firmado para poder afirmar sobre su FORMA. */
function makeTokens() {
  const issued: IssuablePayload[] = [];
  return {
    issued,
    service: {
      issue: (payload: IssuablePayload) => {
        issued.push(payload);
        return Promise.resolve({ accessToken: 'acc', refreshToken: 'ref' });
      },
    } as never,
  };
}

/** Captura lo que el login delega al break-glass (SEC-008). */
function makeBreakGlass() {
  const opened: BreakGlassInput[] = [];
  const expiresAt = new Date('2026-10-17T12:30:00.000Z');
  const service = {
    open: (input: BreakGlassInput) => {
      opened.push(input);
      return Promise.resolve({
        accessToken: 'bg-acc',
        breakGlass: true as const,
        expiresAt,
      });
    },
  } as unknown as BreakGlassService;
  return { opened, service, expiresAt };
}

async function platformUser(pass: string): Promise<AuthUserRecord> {
  return {
    id: 'super-1',
    passwordHash: await password.hash(pass),
    isPlatformAdmin: true,
    tokenVersion: 2,
  };
}

describe('LoginUseCase — superadmin de plataforma', () => {
  describe('en el host de una clínica donde NO tiene membresía', () => {
    it('SEC-008: ya NO emite un token ADMIN con la contraseña: delega en el break-glass (MFA + motivo, sin refresh)', async () => {
      const tokens = makeTokens();
      const breakGlass = makeBreakGlass();
      const uc = new LoginUseCase(
        makeRepo(await platformUser('S3cret!')),
        password,
        tokens.service,
        breakGlass.service,
        {} as never,
        {} as never,
        {} as never,
      );

      const result = await uc.execute({
        tenantId: 'tenant-ajeno',
        email: 'super@dentalix.com',
        password: 'S3cret!',
        mfaCode: '123456',
        breakGlassReason: 'Ticket 42: no cuadra la caja',
        ip: '10.0.0.1',
        userAgent: 'UA',
      });

      // Nada de par con refresh de 30 días.
      expect(tokens.issued).toEqual([]);
      expect(result).toEqual({
        accessToken: 'bg-acc',
        breakGlass: true,
        expiresAt: breakGlass.expiresAt,
      });
      expect(breakGlass.opened).toHaveLength(1);
      const [{ user, ...rest }] = breakGlass.opened;
      expect(user).toMatchObject({ id: 'super-1', tokenVersion: 2 });
      expect([rest]).toEqual([
        {
          tenantId: 'tenant-ajeno',
          mfaCode: '123456',
          reason: 'Ticket 42: no cuadra la caja',
          ip: '10.0.0.1',
          userAgent: 'UA',
        },
      ]);
    });

    it('rechaza a un usuario que NO es superadmin (sin membresía → 401)', async () => {
      const tokens = makeTokens();
      const uc = new LoginUseCase(
        makeRepo({
          id: 'u-normal',
          passwordHash: await password.hash('S3cret!'),
          isPlatformAdmin: false,
          tokenVersion: 0,
        }),
        password,
        tokens.service,
        makeBreakGlass().service,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        uc.execute({
          tenantId: 't1',
          email: 'normal@ejemplo.com',
          password: 'S3cret!',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issued).toEqual([]);
    });

    it('rechaza al superadmin con contraseña incorrecta', async () => {
      const tokens = makeTokens();
      const uc = new LoginUseCase(
        makeRepo(await platformUser('S3cret!')),
        password,
        tokens.service,
        makeBreakGlass().service,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        uc.execute({
          tenantId: 't1',
          email: 'super@dentalix.com',
          password: 'la-que-no-es',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issued).toEqual([]);
    });
  });

  describe('en el apex (sin tenant)', () => {
    function apexUseCase(
      user: AuthUserRecord,
      enabledAt: Date | null,
      tokens: ReturnType<typeof makeTokens>,
      accepted = true,
    ) {
      const issued: unknown[] = [];
      const sent: unknown[] = [];
      const uc = new LoginUseCase(
        makeRepo(user),
        password,
        tokens.service,
        makeBreakGlass().service,
        {
          state: () =>
            Promise.resolve({
              email: 'super@dentalix.com',
              tokenVersion: 2,
              enabledAt,
            }),
        } as never,
        {
          issue: (input: unknown) => {
            issued.push(input);
            return Promise.resolve({
              token: 'mfa-token',
              expiresAt: new Date('2030-01-01T00:00:00Z'),
              jti: 'jti-1',
            });
          },
          emailCode: () => '12345678',
          emailCodeRef: () => 'A1F3',
        } as never,
        {
          sendEnrollmentCode: (input: unknown) => {
            sent.push(input);
            return Promise.resolve(accepted);
          },
        } as never,
      );
      return { uc, issued, sent };
    }

    it('DX-021-bis: con MFA, la contraseña no abre sesión: pide el código (token sin clínica)', async () => {
      const tokens = makeTokens();
      const { uc, issued, sent } = apexUseCase(
        await platformUser('S3cret!'),
        new Date(),
        tokens,
      );

      const result = await uc.executePlatform({
        email: 'super@dentalix.com',
        password: 'S3cret!',
      });

      expect(tokens.issued).toEqual([]);
      expect(result).toMatchObject({ mfa: 'MFA_REQUIRED' });
      expect(result).not.toHaveProperty('emailCodeRequired');
      expect(issued).toEqual([
        {
          userId: 'super-1',
          tenantId: null,
          tokenVersion: 2,
          purpose: 'MFA_VERIFY',
        },
      ]);
      expect(sent).toEqual([]);
    });

    it('DX-021-bis: sin MFA, alta forzada con código enviado a su correo', async () => {
      const tokens = makeTokens();
      const { uc, sent } = apexUseCase(
        await platformUser('S3cret!'),
        null,
        tokens,
      );

      const result = await uc.executePlatform({
        email: 'super@dentalix.com',
        password: 'S3cret!',
        ip: '10.0.0.1',
      });

      expect(tokens.issued).toEqual([]);
      expect(result).toMatchObject({
        mfa: 'MFA_ENROLLMENT_REQUIRED',
        emailCodeRequired: true,
        emailCodeRef: 'A1F3',
      });
      expect(sent).toEqual([
        {
          userId: 'super-1',
          ip: '10.0.0.1',
          to: 'super@dentalix.com',
          code: '12345678',
          ref: 'A1F3',
          expiresInMinutes: 10,
        },
      ]);
    });

    it('DX-021-bis: si el correo no sale, no dice que salió: 429 con la espera', async () => {
      const { uc } = apexUseCase(
        await platformUser('S3cret!'),
        null,
        makeTokens(),
        false,
      );
      await expect(
        uc.executePlatform({
          email: 'super@dentalix.com',
          password: 'S3cret!',
          ip: '10.0.0.1',
        }),
      ).rejects.toMatchObject({ retryAfterSeconds: 60 });
    });

    it('rechaza a un usuario normal', async () => {
      const uc = new LoginUseCase(
        makeRepo({
          id: 'u-normal',
          passwordHash: await password.hash('S3cret!'),
          isPlatformAdmin: false,
          tokenVersion: 0,
        }),
        password,
        makeTokens().service,
        makeBreakGlass().service,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        uc.executePlatform({
          email: 'normal@ejemplo.com',
          password: 'S3cret!',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rechaza un email inexistente sin distinguirlo de una contraseña mala', async () => {
      const uc = new LoginUseCase(
        makeRepo(null),
        password,
        makeTokens().service,
        makeBreakGlass().service,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        uc.executePlatform({ email: 'nadie@ejemplo.com', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
