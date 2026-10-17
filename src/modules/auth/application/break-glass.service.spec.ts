import { randomBytes } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MfaSecretCipher } from '../../../shared/crypto/mfa-secret-cipher';
import { TokenService } from '../../../shared/crypto/token.service';
import {
  decodeBase32,
  generateTotpSecret,
  totpCode,
  totpStep,
} from '../../../shared/crypto/totp';
import type {
  BreakGlassAccessInput,
  BreakGlassRepository,
  UserMfaRecord,
} from '../domain/ports/break-glass-repository.port';
import { BreakGlassService } from './break-glass.service';
import { LoginLockoutService } from './login-lockout.service';
import { InMemoryLoginThrottleRepository } from './__fixtures__/in-memory-login-throttle';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LoginLockedError,
} from '../domain/login-lockout';

const DAY_MS = 24 * 60 * 60 * 1000;

const USER = { id: '6f0c3f9e-7d1b-4c2a-9e1f-0a1b2c3d4e5f', tokenVersion: 3 };
const TENANT = '0b9d1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4';
const REASON = 'Ticket 42: la clínica no cuadra la caja';

class InMemoryBreakGlassRepo implements BreakGlassRepository {
  mfa: UserMfaRecord | null = null;
  accesses: BreakGlassAccessInput[] = [];
  failInsert = false;

  findMfa(): Promise<UserMfaRecord | null> {
    return Promise.resolve(this.mfa);
  }

  consumeTotpStep(_userId: string, step: number): Promise<boolean> {
    if (!this.mfa?.secretEnc) return Promise.resolve(false);
    if (this.mfa.lastUsedStep !== null && this.mfa.lastUsedStep >= step) {
      return Promise.resolve(false);
    }
    this.mfa.lastUsedStep = step;
    return Promise.resolve(true);
  }

  recordAccess(input: BreakGlassAccessInput): Promise<void> {
    if (this.failInsert) return Promise.reject(new Error('db down'));
    this.accesses.push(input);
    return Promise.resolve();
  }
}

function setup(env: Record<string, string> = {}) {
  const cipher = new MfaSecretCipher(randomBytes(32));
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'r'.repeat(40),
    JWT_ACCESS_TTL: '900s',
    JWT_REFRESH_TTL: '30d',
    ...env,
  });
  const tokens = new TokenService(new JwtService({}), config);
  const repo = new InMemoryBreakGlassRepo();
  const throttle = new InMemoryLoginThrottleRepository();
  const lockout = new LoginLockoutService(throttle, DEFAULT_LOGIN_LOCKOUT);
  const service = new BreakGlassService(repo, cipher, tokens, lockout, config);
  const secret = generateTotpSecret();
  /** Por defecto, enrolado hace 2 días (ya pasó la espera de seguridad). */
  const enroll = (enabledAt = new Date(Date.now() - 2 * DAY_MS)) => {
    repo.mfa = {
      secretEnc: cipher.encrypt(secret, USER.id),
      enabledAt,
      lastUsedStep: null,
    };
  };
  const code = (offset = 0) =>
    totpCode(decodeBase32(secret), totpStep(Date.now()) + offset);
  return { service, repo, tokens, enroll, code, throttle };
}

function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof UnauthorizedException)) throw err;
    return (err.getResponse() as { code?: string }).code;
  }
  throw new Error('debía lanzar');
}

describe('BreakGlassService (SEC-008)', () => {
  it('sin MFA enrolado → MFA_NOT_ENROLLED aunque traiga código y motivo', async () => {
    const { service, repo } = setup();
    await expect(
      codeOf(
        service.open({
          tenantId: TENANT,
          user: USER,
          mfaCode: '123456',
          reason: REASON,
        }),
      ),
    ).resolves.toBe('MFA_NOT_ENROLLED');
    expect(repo.accesses).toEqual([]);
  });

  it.each([
    ['sin código ni motivo', {}],
    ['sin motivo', { mfaCode: '123456' }],
    ['motivo en blanco', { mfaCode: '123456', reason: '   ' }],
    ['sin código', { reason: REASON }],
  ])('%s → BREAK_GLASS_REQUIRED', async (_label, extra) => {
    const { service, repo, enroll } = setup();
    enroll();
    await expect(
      codeOf(service.open({ tenantId: TENANT, user: USER, ...extra })),
    ).resolves.toBe('BREAK_GLASS_REQUIRED');
    expect(repo.accesses).toEqual([]);
  });

  it('código erróneo → 401 genérico (sin code) y sin fila', async () => {
    const { service, repo, enroll, code } = setup();
    enroll();
    const wrong = code() === '000000' ? '111111' : '000000';
    await expect(
      codeOf(
        service.open({
          tenantId: TENANT,
          user: USER,
          mfaCode: wrong,
          reason: REASON,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(repo.accesses).toEqual([]);
  });

  it('código válido + motivo → token ADMIN break-glass con el TTL configurado y fila de auditoría', async () => {
    const { service, repo, enroll, code } = setup({
      BREAK_GLASS_TTL_MINUTES: '15',
    });
    enroll();
    const session = await service.open({
      tenantId: TENANT,
      user: USER,
      mfaCode: code(),
      reason: `  ${REASON} `,
      ip: '203.0.113.9',
      userAgent: 'x'.repeat(600),
    });

    const claims = claimsOf(session.accessToken);
    expect(claims).toMatchObject({
      sub: USER.id,
      tenantId: TENANT,
      role: 'ADMIN',
      tv: 3,
      breakGlass: true,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);
    expect(session.breakGlass).toBe(true);
    expect(session.expiresAt.getTime()).toBe((claims.exp as number) * 1000);

    expect(repo.accesses).toHaveLength(1);
    const [row] = repo.accesses;
    expect(row).toMatchObject({
      tenantId: TENANT,
      userId: USER.id,
      reason: REASON,
      ip: '203.0.113.9',
      expiresAt: session.expiresAt,
    });
    expect(row.userAgent).toHaveLength(512);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(15 * 60_000);
  });

  it('por defecto el token dura 30 min (nunca más de 60)', async () => {
    const { service, enroll, code } = setup({ BREAK_GLASS_TTL_MINUTES: '600' });
    enroll();
    const { accessToken } = await service.open({
      tenantId: TENANT,
      user: USER,
      mfaCode: code(),
      reason: REASON,
    });
    const claims = claimsOf(accessToken);
    expect((claims.exp as number) - (claims.iat as number)).toBe(30 * 60);
  });

  it('el mismo código no vale dos veces (anti-replay)', async () => {
    const { service, repo, enroll, code } = setup();
    enroll();
    const used = code();
    await service.open({
      tenantId: TENANT,
      user: USER,
      mfaCode: used,
      reason: REASON,
    });
    await expect(
      codeOf(
        service.open({
          tenantId: TENANT,
          user: USER,
          mfaCode: used,
          reason: REASON,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(repo.accesses).toHaveLength(1);
  });

  it('si la fila de auditoría no se puede escribir, no hay token', async () => {
    const { service, repo, enroll, code } = setup();
    enroll();
    repo.failInsert = true;
    await expect(
      service.open({
        tenantId: TENANT,
        user: USER,
        mfaCode: code(),
        reason: REASON,
      }),
    ).rejects.toThrow('db down');
  });

  describe('espera de seguridad tras el alta del MFA (riesgo de transición)', () => {
    it('recién activado → MFA_COOLDOWN con availableAt, sin mirar el código ni dejar fila', async () => {
      const { service, repo, enroll, code } = setup();
      const enabledAt = new Date(Date.now() - 60_000);
      enroll(enabledAt);
      let body: Record<string, unknown> = {};
      try {
        await service.open({
          tenantId: TENANT,
          user: USER,
          mfaCode: code(),
          reason: REASON,
        });
      } catch (err) {
        body = (err as UnauthorizedException).getResponse() as Record<
          string,
          unknown
        >;
      }
      expect(body.code).toBe('MFA_COOLDOWN');
      expect(body.availableAt).toBe(
        new Date(enabledAt.getTime() + DAY_MS).toISOString(),
      );
      expect(repo.mfa?.lastUsedStep).toBeNull();
      expect(repo.accesses).toEqual([]);
    });

    it('la espera es configurable (0 = sin espera)', async () => {
      const { service, repo, enroll, code } = setup({
        BREAK_GLASS_MFA_COOLDOWN_MINUTES: '0',
      });
      enroll(new Date());
      await service.open({
        tenantId: TENANT,
        user: USER,
        mfaCode: code(),
        reason: REASON,
      });
      expect(repo.accesses).toHaveLength(1);
    });
  });

  describe('fuerza bruta del código', () => {
    const wrongFor = (valid: string): string =>
      ['000000', '111111', '222222'].find((c) => c !== valid)!;

    it('tras 5 códigos erróneos queda en espera (LoginLockedError) aunque el siguiente sea bueno', async () => {
      const { service, repo, enroll, code } = setup();
      enroll();
      for (let i = 0; i < 5; i++) {
        await expect(
          codeOf(
            service.open({
              tenantId: TENANT,
              user: USER,
              mfaCode: wrongFor(code()),
              reason: REASON,
            }),
          ),
        ).resolves.toBeUndefined();
      }
      await expect(
        service.open({
          tenantId: TENANT,
          user: USER,
          mfaCode: code(),
          reason: REASON,
        }),
      ).rejects.toBeInstanceOf(LoginLockedError);
      expect(repo.accesses).toEqual([]);
    });

    it('un código bueno reinicia el contador', async () => {
      const { service, enroll, code, throttle } = setup();
      enroll();
      for (let i = 0; i < 4; i++) {
        await codeOf(
          service.open({
            tenantId: TENANT,
            user: USER,
            mfaCode: wrongFor(code()),
            reason: REASON,
          }),
        );
      }
      await service.open({
        tenantId: TENANT,
        user: USER,
        mfaCode: code(),
        reason: REASON,
      });
      expect(throttle.size()).toBe(0);
    });
  });
});
