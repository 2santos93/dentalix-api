import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClinicRole } from '@prisma/client';
import { CompleteMfaLoginUseCase } from './complete-mfa-login.use-case';
import { MfaChallengeService } from '../mfa-challenge.service';
import { LoginLockoutService } from '../login-lockout.service';
import { InMemoryLoginThrottleRepository } from '../__fixtures__/in-memory-login-throttle';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LoginLockedError,
} from '../../domain/login-lockout';
import { MFA_MESSAGES } from '../../domain/user-mfa';
import type {
  AuthRepository,
  SessionState,
} from '../../domain/ports/auth-repository.port';

/**
 * SEC-066: el alta forzada del MFA de un miembro de clínica exige, además de la
 * contraseña (el `mfaToken`), el código de un solo uso enviado a su correo: el
 * mismo mecanismo que el alta del superadmin (DX-021-bis).
 */

const request = { requestId: 'req-1', ip: '10.0.0.1', userAgent: 'jest' };

const config = {
  getOrThrow: () => 'jwt-access-secret-de-prueba',
} as unknown as ConfigService;

function member(role: ClinicRole): SessionState {
  return {
    tokenVersion: 3,
    isPlatformAdmin: false,
    tenant: { membershipRole: role, allowedLocationIds: null },
  };
}

function setup() {
  const challenges = new MfaChallengeService(new JwtService({}), config);
  const throttles = new InMemoryLoginThrottleRepository();
  const lockout = new LoginLockoutService(throttles, DEFAULT_LOGIN_LOCKOUT);
  const consumed = new Set<string>();
  const memberships: Record<string, Record<string, SessionState>> = {
    u1: { t1: member(ClinicRole.RECEPTION) },
    u2: { t1: member(ClinicRole.DENTIST) },
  };
  const repo = {
    findSessionState: (userId: string, tenantId: string | null) =>
      Promise.resolve(
        tenantId ? (memberships[userId]?.[tenantId] ?? null) : null,
      ),
    consumeRefreshToken: (jti: string) => {
      if (consumed.has(jti)) return Promise.resolve(false);
      consumed.add(jti);
      return Promise.resolve(true);
    },
  } as unknown as AuthRepository;
  const mfa = {
    state: jest.fn().mockResolvedValue({
      isPlatformAdmin: false,
      enabledAt: null,
      email: 'ana@clinica.co',
      tokenVersion: 3,
    }),
    startEnrollment: jest
      .fn()
      .mockResolvedValue({ secret: 'SECRETO', otpauthUri: 'otpauth://x' }),
    confirmEnrollment: jest.fn().mockResolvedValue({
      enabledAt: new Date(),
      tokenVersion: 4,
      recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'],
    }),
  };
  const tokens = {
    issue: jest
      .fn()
      .mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const mfaRepo = { recordPlatformEvent: jest.fn() };
  const uc = new CompleteMfaLoginUseCase(
    repo,
    challenges,
    mfa as never,
    tokens as never,
    audit as never,
    lockout,
    mfaRepo as never,
  );
  const issue = async (userId = 'u1', tenantId = 't1') => {
    const { token, jti } = await challenges.issue({
      userId,
      tenantId,
      tokenVersion: 3,
      purpose: 'MFA_ENROLL',
    });
    return { token, code: challenges.emailCode(jti) };
  };
  return { uc, mfa, tokens, audit, mfaRepo, issue };
}

/** Un código de 8 dígitos que no es `code`. */
const wrong = (code: string) => (code === '00000000' ? '11111111' : '00000000');

describe('CompleteMfaLoginUseCase — alta forzada de un miembro de clínica (SEC-066)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('empezar el alta', () => {
    it('sin el código del correo no hay secreto (400) y queda LOGIN_FAILED INVALID_EMAIL_CODE en su clínica', async () => {
      const { uc, mfa, audit, mfaRepo, issue } = setup();
      const { token } = await issue();
      await expect(
        uc.startEnrollment({ mfaToken: token, hostTenantId: 't1', request }),
      ).rejects.toThrow(new BadRequestException(MFA_MESSAGES.emailCodeInvalid));
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          actor: { kind: 'user', userId: 'u1', role: ClinicRole.RECEPTION },
          action: 'LOGIN_FAILED',
          resourceType: 'SESSION',
          metadata: { reason: 'INVALID_EMAIL_CODE' },
        }),
      );
      expect(mfaRepo.recordPlatformEvent).not.toHaveBeenCalled();
      // Ni el código ni el token en la auditoría.
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(token);
    });

    it('con un código incorrecto, tampoco (400)', async () => {
      const { uc, mfa, issue } = setup();
      const { token, code } = await issue();
      await expect(
        uc.startEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          emailCode: wrong(code),
          request,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });

    it('con el código de su correo: el secreto pendiente, con la auditoría de la clínica', async () => {
      const { uc, mfa, issue } = setup();
      const { token, code } = await issue();
      await expect(
        uc.startEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          emailCode: code,
          request,
        }),
      ).resolves.toEqual({ secret: 'SECRETO', otpauthUri: 'otpauth://x' });
      expect(mfa.startEnrollment).toHaveBeenCalledWith(
        'u1',
        null,
        expect.objectContaining({
          tenantId: 't1',
          actor: { userId: 'u1', role: ClinicRole.RECEPTION },
        }),
      );
    });

    it('el código de otra cuenta, o de otro intento de la misma, no vale', async () => {
      const { uc, mfa, issue } = setup();
      const mine = await issue('u1');
      const other = await issue('u2');
      const earlier = await issue('u1');
      for (const emailCode of [other.code, earlier.code]) {
        if (emailCode === mine.code) continue;
        await expect(
          uc.startEnrollment({
            mfaToken: mine.token,
            hostTenantId: 't1',
            emailCode,
            request,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });

    it('el token (y con él su código) no vale en otra clínica: 401', async () => {
      const { uc, mfa, issue } = setup();
      const { token, code } = await issue('u1', 't1');
      await expect(
        uc.startEnrollment({
          mfaToken: token,
          hostTenantId: 't2',
          emailCode: code,
          request,
        }),
      ).rejects.toMatchObject({
        response: { code: 'MFA_CHALLENGE_EXPIRED' },
      });
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });

    it('caduca con su token (10 min)', async () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(Date.UTC(2026, 10, 6, 9, 0, 0));
      const { uc, mfa, issue } = setup();
      const { token, code } = await issue();
      now.mockReturnValue(Date.UTC(2026, 10, 6, 9, 10, 1));
      await expect(
        uc.startEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          emailCode: code,
          request,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });

    it('10 fallos agotan el código: luego ni el correcto vale (hay que volver a entrar)', async () => {
      const { uc, mfa, issue } = setup();
      const { token, code } = await issue();
      for (let i = 0; i < 10; i += 1) {
        // Cada intento desde otra IP: solo se mide el tope del código.
        await expect(
          uc.startEnrollment({
            mfaToken: token,
            hostTenantId: 't1',
            emailCode: wrong(code),
            request: { ...request, ip: `10.0.1.${i}` },
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        uc.startEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          emailCode: code,
          request: { ...request, ip: '10.0.2.1' },
        }),
      ).rejects.toMatchObject({
        response: { code: 'MFA_CHALLENGE_EXPIRED' },
      });
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });

    it('los fallos cuentan para el bloqueo por cuenta y cliente: el 6.º intento espera (429), aunque traiga otro token y su código bueno', async () => {
      const { uc, mfa, issue } = setup();
      for (let i = 0; i < 5; i += 1) {
        const { token, code } = await issue();
        await expect(
          uc.startEnrollment({
            mfaToken: token,
            hostTenantId: 't1',
            emailCode: wrong(code),
            request,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      const fresh = await issue();
      await expect(
        uc.startEnrollment({
          mfaToken: fresh.token,
          hostTenantId: 't1',
          emailCode: fresh.code,
          request,
        }),
      ).rejects.toBeInstanceOf(LoginLockedError);
      expect(mfa.startEnrollment).not.toHaveBeenCalled();
    });
  });

  describe('confirmar el alta', () => {
    it('sin el código del correo: ni se activa, ni sesión, ni códigos de recuperación', async () => {
      const { uc, mfa, tokens, issue } = setup();
      const { token } = await issue();
      await expect(
        uc.confirmEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          code: '123456',
          request,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mfa.confirmEnrollment).not.toHaveBeenCalled();
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('con el código del correo: activa, sesión de la clínica y LOGIN MFA_ENROLLED; el token es de un solo uso', async () => {
      const { uc, mfa, tokens, audit, issue } = setup();
      const { token, code } = await issue();
      const result = await uc.confirmEnrollment({
        mfaToken: token,
        hostTenantId: 't1',
        code: '123456',
        emailCode: code,
        request,
      });
      expect(result).toEqual({
        accessToken: 'acc',
        refreshToken: 'ref',
        recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'],
      });
      expect(mfa.confirmEnrollment).toHaveBeenCalledWith(
        'u1',
        '123456',
        expect.objectContaining({ tenantId: 't1' }),
      );
      expect(tokens.issue).toHaveBeenCalledWith({
        sub: 'u1',
        tenantId: 't1',
        role: ClinicRole.RECEPTION,
        tv: 4,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOGIN',
          metadata: { reason: 'MFA_ENROLLED' },
        }),
      );
      await expect(
        uc.confirmEnrollment({
          mfaToken: token,
          hostTenantId: 't1',
          code: '123456',
          emailCode: code,
          request,
        }),
      ).rejects.toMatchObject({
        response: { code: 'MFA_CHALLENGE_EXPIRED' },
      });
    });
  });
});
