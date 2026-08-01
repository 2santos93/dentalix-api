import { UnauthorizedException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { LoginUseCase } from './login.use-case';
import {
  AuthRepository,
  AuthUserRecord,
} from '../../domain/ports/auth-repository.port';
import { PasswordService } from '../../../../shared/crypto/password.service';
import { JwtPayload } from '../../../../shared/crypto/token.service';

const password = new PasswordService();

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
    isTokenRevoked: jest.fn(),
  };
}

/** Captura el payload firmado para poder afirmar sobre su FORMA. */
function makeTokens() {
  const issued: JwtPayload[] = [];
  return {
    issued,
    service: {
      issue: (payload: JwtPayload) => {
        issued.push(payload);
        return Promise.resolve({ accessToken: 'acc', refreshToken: 'ref' });
      },
    } as never,
  };
}

async function platformUser(pass: string): Promise<AuthUserRecord> {
  return {
    id: 'super-1',
    passwordHash: await password.hash(pass),
    isPlatformAdmin: true,
  };
}

describe('LoginUseCase — superadmin de plataforma', () => {
  describe('en el host de una clínica donde NO tiene membresía', () => {
    it('le emite un token de CLÍNICA con rol ADMIN para ese tenant', async () => {
      const tokens = makeTokens();
      const uc = new LoginUseCase(
        makeRepo(await platformUser('S3cret!')),
        password,
        tokens.service,
      );

      const result = await uc.execute({
        tenantId: 'tenant-ajeno',
        email: 'super@dentalix.com',
        password: 'S3cret!',
      });

      expect(result.accessToken).toBe('acc');
      // Token de clínica normal: el aislamiento sigue siendo por tenant, no hay
      // ningún permiso "global" viajando dentro del token.
      expect(tokens.issued).toEqual([
        { sub: 'super-1', tenantId: 'tenant-ajeno', role: ClinicRole.ADMIN },
      ]);
    });

    it('rechaza a un usuario que NO es superadmin (sin membresía → 401)', async () => {
      const tokens = makeTokens();
      const uc = new LoginUseCase(
        makeRepo({
          id: 'u-normal',
          passwordHash: await password.hash('S3cret!'),
          isPlatformAdmin: false,
        }),
        password,
        tokens.service,
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
    it('le emite un token de PLATAFORMA, sin tenant ni rol', async () => {
      const tokens = makeTokens();
      const uc = new LoginUseCase(
        makeRepo(await platformUser('S3cret!')),
        password,
        tokens.service,
      );

      await uc.executePlatform({
        email: 'super@dentalix.com',
        password: 'S3cret!',
      });

      expect(tokens.issued).toEqual([{ sub: 'super-1', platform: true }]);
    });

    it('rechaza a un usuario normal', async () => {
      const uc = new LoginUseCase(
        makeRepo({
          id: 'u-normal',
          passwordHash: await password.hash('S3cret!'),
          isPlatformAdmin: false,
        }),
        password,
        makeTokens().service,
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
      );

      await expect(
        uc.executePlatform({ email: 'nadie@ejemplo.com', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
