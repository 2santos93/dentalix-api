import { ClinicRole } from '@prisma/client';
import type { ClinicMfaPolicy } from '../domain/user-mfa';
import type { SecondFactor } from './user-mfa.service';
import type { TrustedDevice } from '../domain/ports/user-mfa-repository.port';
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { MfaSecretCipher } from '../../../shared/crypto/mfa-secret-cipher';
import { TestPasswordHasher } from '../../../shared/testing/test-password-hasher';
import { decodeBase32, totpCode, totpStep } from '../../../shared/crypto/totp';
import { normalizeRecoveryCode } from '../../../shared/crypto/recovery-codes';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { BreakGlassRepository } from '../domain/ports/break-glass-repository.port';
import type {
  UserMfaRepository,
  UserMfaState,
} from '../domain/ports/user-mfa-repository.port';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LoginLockedError,
} from '../domain/login-lockout';
import { LoginLockoutService } from './login-lockout.service';
import { InMemoryLoginThrottleRepository } from './__fixtures__/in-memory-login-throttle';
import { UserMfaService } from './user-mfa.service';

const USER = '6f0c3f9e-7d1b-4c2a-9e1f-0a1b2c3d4e5f';
const TENANT = '0b9d1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4';
const PASSWORD = 'S3cret!!-largo';

const CTX: AuditRequestContext = {
  tenantId: TENANT,
  locationId: null,
  actor: { userId: USER, role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: '203.0.113.7',
  userAgent: 'jest',
};

/** Repositorio en memoria con la semántica del de Prisma. */
class InMemoryUserMfaRepo
  implements UserMfaRepository, Pick<BreakGlassRepository, 'consumeTotpStep'>
{
  state!: UserMfaState;
  codes: { hash: string; usedAt: Date | null }[] = [];
  audits: AuditEventDraft[] = [];
  requireAdminMfa = false;
  requireAllMfa = false;
  /** `roles` de la última política guardada y dispositivos en memoria. */
  policyRoles: ClinicRole[] = [];
  devices: {
    id: string;
    tokenHash: string;
    tokenVersion: number;
    label: string;
    expiresAt: Date;
    revoked: boolean;
  }[] = [];
  memberRole: ClinicRole | null = ClinicRole.ASSISTANT;
  otherClinic = false;
  platformEvents: unknown[] = [];

  find(): Promise<UserMfaState | null> {
    return Promise.resolve({
      ...this.state,
      recoveryCodesRemaining: this.state.enabledAt
        ? this.codes.filter((c) => !c.usedAt).length
        : 0,
    });
  }
  savePending(_u: string, enc: string): Promise<boolean> {
    if (this.state.enabledAt) return Promise.resolve(false);
    this.state.pendingSecretEnc = enc;
    return Promise.resolve(true);
  }
  enable(
    _u: string,
    enc: string,
    step: number,
    hashes: string[],
    audit: AuditEventDraft,
  ) {
    if (this.state.enabledAt || this.state.pendingSecretEnc !== enc)
      return Promise.resolve(null);
    const enabledAt = new Date();
    this.state = {
      ...this.state,
      secretEnc: enc,
      pendingSecretEnc: null,
      enabledAt,
      lastUsedStep: step,
      tokenVersion: this.state.tokenVersion + 1,
    };
    this.codes = hashes.map((hash) => ({ hash, usedAt: null }));
    this.audits.push(audit);
    return Promise.resolve({
      enabledAt,
      tokenVersion: this.state.tokenVersion,
    });
  }
  disable(_u: string, audit: AuditEventDraft): Promise<number | null> {
    if (!this.state.enabledAt) return Promise.resolve(null);
    this.state = {
      ...this.state,
      secretEnc: null,
      enabledAt: null,
      lastUsedStep: null,
      tokenVersion: this.state.tokenVersion + 1,
    };
    this.codes = [];
    this.audits.push(audit);
    return Promise.resolve(this.state.tokenVersion);
  }
  replaceRecoveryCodes(_u: string, hashes: string[], audit: AuditEventDraft) {
    this.codes = hashes.map((hash) => ({ hash, usedAt: null }));
    this.audits.push(audit);
    return Promise.resolve(true);
  }
  consumeRecoveryCode(_u: string, hash: string): Promise<boolean> {
    const row = this.codes.find((c) => c.hash === hash && !c.usedAt);
    if (!row) return Promise.resolve(false);
    row.usedAt = new Date();
    return Promise.resolve(true);
  }
  consumeTotpStep(_u: string, step: number): Promise<boolean> {
    if (this.state.lastUsedStep !== null && this.state.lastUsedStep >= step) {
      return Promise.resolve(false);
    }
    this.state.lastUsedStep = step;
    return Promise.resolve(true);
  }
  findClinicPolicy(): Promise<ClinicMfaPolicy | null> {
    return Promise.resolve({
      requireAdminMfa: this.requireAdminMfa,
      requireAllMfa: this.requireAllMfa,
    });
  }
  setClinicPolicy(
    _t: string,
    policy: ClinicMfaPolicy,
    roles: ClinicRole[],
    audit: AuditEventDraft,
  ): Promise<number> {
    this.requireAdminMfa = policy.requireAdminMfa;
    this.requireAllMfa = policy.requireAllMfa;
    this.policyRoles = roles;
    this.audits.push(audit);
    return Promise.resolve(0);
  }
  recordPlatformEvent(draft: unknown): Promise<void> {
    this.platformEvents.push(draft);
    return Promise.resolve();
  }
  findActiveMemberRole(): Promise<ClinicRole | null> {
    return Promise.resolve(this.memberRole);
  }
  hasOtherActiveMemberships(): Promise<boolean> {
    return Promise.resolve(this.otherClinic);
  }
  addTrustedDevice(
    input: Omit<(typeof this.devices)[number], 'id' | 'revoked'>,
  ) {
    this.devices.push({
      ...input,
      id: `d${this.devices.length}`,
      revoked: false,
    });
    return Promise.resolve();
  }
  touchTrustedDevice(
    _u: string,
    hash: string,
    tokenVersion: number,
  ): Promise<boolean> {
    return Promise.resolve(
      this.devices.some(
        (d) =>
          d.tokenHash === hash &&
          d.tokenVersion === tokenVersion &&
          !d.revoked &&
          d.expiresAt > new Date(),
      ),
    );
  }
  listTrustedDevices(): Promise<TrustedDevice[]> {
    return Promise.resolve([]);
  }
  revokeTrustedDevices(_u: string, id: string | null): Promise<number> {
    const hit = this.devices.filter((d) => !d.revoked && (!id || d.id === id));
    hit.forEach((d) => (d.revoked = true));
    return Promise.resolve(hit.length);
  }
}

async function setup(opts: { isPlatformAdmin?: boolean } = {}) {
  const cipher = new MfaSecretCipher(randomBytes(32));
  const password = new TestPasswordHasher();
  const repo = new InMemoryUserMfaRepo();
  repo.state = {
    email: 'ana@clinica.test',
    passwordHash: await password.hash(PASSWORD),
    isPlatformAdmin: opts.isPlatformAdmin ?? false,
    tokenVersion: 4,
    secretEnc: null,
    pendingSecretEnc: null,
    enabledAt: null,
    lastUsedStep: null,
    recoveryCodesRemaining: 0,
  };
  const throttle = new InMemoryLoginThrottleRepository();
  const lockout = new LoginLockoutService(throttle, DEFAULT_LOGIN_LOCKOUT);
  const recorded: AuditEventDraft[] = [];
  const audit = {
    record: (d: AuditEventDraft) => {
      recorded.push(d);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
  const notices: unknown[] = [];
  const notifier = {
    notice: (input: unknown) => {
      notices.push(input);
      return Promise.resolve();
    },
  } as never;
  const service = new UserMfaService(
    repo,
    repo as unknown as BreakGlassRepository,
    cipher,
    password,
    lockout,
    audit,
    notifier,
  );
  let secret = '';
  const code = (offset = 0) =>
    totpCode(decodeBase32(secret), totpStep(Date.now()) + offset);
  /** Alta completa: devuelve los códigos de recuperación. */
  const enroll = async () => {
    secret = (await service.startEnrollment(USER, PASSWORD, CTX)).secret;
    return service.confirmEnrollment(USER, code(), CTX);
  };
  /** Avanza el paso usado para que `code()` vuelva a valer en el siguiente caso. */
  const forgetLastStep = () => {
    repo.state.lastUsedStep = totpStep(Date.now()) - 5;
  };
  return {
    service,
    repo,
    enroll,
    code,
    forgetLastStep,
    throttle,
    recorded,
    cipher,
    notices,
  };
}

describe('UserMfaService (DX-021)', () => {
  describe('alta', () => {
    it('exige la contraseña actual para empezar', async () => {
      const { service } = await setup();
      await expect(
        service.startEnrollment(USER, 'mala', CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('guarda el secreto CIFRADO y el otpauth URI lleva emisor y cuenta', async () => {
      const { service, repo, recorded } = await setup();
      const { secret, otpauthUri } = await service.startEnrollment(
        USER,
        PASSWORD,
        CTX,
      );
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(otpauthUri).toContain(`secret=${secret}`);
      expect(otpauthUri).toContain('issuer=Dentalix');
      expect(otpauthUri).toContain('ana%40clinica.test');
      expect(repo.state.pendingSecretEnc).toMatch(/^v1\./);
      expect(repo.state.pendingSecretEnc).not.toContain(secret);
      expect(recorded.map((e) => e.metadata.reason)).toEqual([
        'MFA_ENROLLMENT_STARTED',
      ]);
      expect(JSON.stringify(recorded)).not.toContain(secret);
    });

    it('confirmar con un código correcto activa, sube tokenVersion y da 10 códigos de recuperación (solo su HMAC en la BD)', async () => {
      const { repo, enroll, cipher } = await setup();
      const enabled = await enroll();
      expect(enabled.recoveryCodes).toHaveLength(10);
      expect(enabled.tokenVersion).toBe(5);
      expect(repo.state.enabledAt).not.toBeNull();
      expect(repo.codes).toHaveLength(10);
      for (const [i, c] of enabled.recoveryCodes.entries()) {
        expect(repo.codes[i].hash).toBe(
          cipher.hashRecoveryCode(normalizeRecoveryCode(c)!, USER),
        );
        expect(repo.codes[i].hash).not.toContain(c);
      }
      expect(repo.audits.map((a) => a.metadata.reason)).toEqual([
        'MFA_ENABLED',
      ]);
      expect(JSON.stringify(repo.audits)).not.toMatch(/secret|otpauth/i);
    });

    it('un código incorrecto no activa', async () => {
      const { service, repo } = await setup();
      await service.startEnrollment(USER, PASSWORD, CTX);
      await expect(
        service.confirmEnrollment(USER, '000000', CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.state.enabledAt).toBeNull();
    });

    it('con el MFA activo no se puede volver a enrolar (409): no se sustituye el secreto', async () => {
      const { service, enroll } = await setup();
      await enroll();
      await expect(
        service.startEnrollment(USER, PASSWORD, CTX),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('verificación del código (ventana y anti-replay)', () => {
    it('acepta el código del paso actual y los de ±30 s, no los de ±60 s', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      await enroll();
      for (const offset of [-1, 0, 1]) {
        forgetLastStep();
        await expect(
          service.verifySecondFactor(
            USER,
            (await repo.find())!,
            {
              code: code(offset),
            },
            TENANT,
          ),
        ).resolves.toBe('TOTP');
      }
      for (const offset of [-2, 2]) {
        forgetLastStep();
        await expect(
          service.verifySecondFactor(
            USER,
            (await repo.find())!,
            {
              code: code(offset),
            },
            TENANT,
          ),
        ).resolves.toBeNull();
      }
    });

    it('replay: el mismo código, ya usado, no vale otra vez dentro de su ventana', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      await enroll();
      forgetLastStep();
      const c = code();
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          { code: c },
          TENANT,
        ),
      ).resolves.toBe('TOTP');
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          { code: c },
          TENANT,
        ),
      ).resolves.toBeNull();
      // Ni un código ANTERIOR al usado (también dentro de la ventana).
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            code: code(-1),
          },
          TENANT,
        ),
      ).resolves.toBeNull();
    });

    it('fuerza bruta: tras 5 códigos fallidos, espera (LoginLockedError) aunque el siguiente sea correcto', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      await enroll();
      forgetLastStep();
      for (let i = 0; i < DEFAULT_LOGIN_LOCKOUT.freeFailures; i++) {
        await expect(
          service.verifySecondFactor(
            USER,
            (await repo.find())!,
            {
              code: '000000',
            },
            TENANT,
          ),
        ).resolves.toBeNull();
      }
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            code: code(),
          },
          TENANT,
        ),
      ).rejects.toBeInstanceOf(LoginLockedError);
    });

    it('fuerza bruta: el alta (confirmar) cuenta en el mismo contador', async () => {
      const { service } = await setup();
      await service.startEnrollment(USER, PASSWORD, CTX);
      for (let i = 0; i < DEFAULT_LOGIN_LOCKOUT.freeFailures; i++) {
        await expect(
          service.confirmEnrollment(USER, '000000', CTX),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        service.confirmEnrollment(USER, '000000', CTX),
      ).rejects.toBeInstanceOf(LoginLockedError);
    });

    it('un acierto reinicia el contador', async () => {
      const { service, repo, enroll, code, forgetLastStep, throttle } =
        await setup();
      await enroll();
      forgetLastStep();
      await service.verifySecondFactor(
        USER,
        (await repo.find())!,
        {
          code: '000000',
        },
        TENANT,
      );
      await service.verifySecondFactor(
        USER,
        (await repo.find())!,
        {
          code: code(),
        },
        TENANT,
      );
      expect(throttle.size()).toBe(0);
    });
  });

  describe('códigos de recuperación', () => {
    it('un código de recuperación vale UNA sola vez (y se acepta en minúsculas/sin guiones)', async () => {
      const { service, repo, enroll } = await setup();
      const { recoveryCodes } = await enroll();
      const typed = recoveryCodes[3].toLowerCase().replace(/-/g, ' ');
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            recoveryCode: typed,
          },
          TENANT,
        ),
      ).resolves.toBe('RECOVERY_CODE');
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            recoveryCode: recoveryCodes[3],
          },
          TENANT,
        ),
      ).resolves.toBeNull();
      expect((await repo.find())!.recoveryCodesRemaining).toBe(9);
    });

    it('regenerar invalida los anteriores; exige contraseña + código', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      const { recoveryCodes: old } = await enroll();
      forgetLastStep();
      await expect(
        service.regenerateRecoveryCodes(USER, 'mala', { code: code() }, CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      const fresh = await service.regenerateRecoveryCodes(
        USER,
        PASSWORD,
        { code: code() },
        CTX,
      );
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toContain(old[0]);
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            recoveryCode: old[0],
          },
          TENANT,
        ),
      ).resolves.toBeNull();
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          {
            recoveryCode: fresh[0],
          },
          TENANT,
        ),
      ).resolves.toBe('RECOVERY_CODE');
      expect(repo.audits.map((a) => a.metadata.reason)).toContain(
        'MFA_RECOVERY_CODES_REGENERATED',
      );
    });
  });

  describe('desactivar (re-autenticación)', () => {
    const ADMIN_CTX = { ...CTX, role: ClinicRole.ADMIN };

    it('sin la contraseña correcta no desactiva, aunque el código sea bueno', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      await enroll();
      forgetLastStep();
      await expect(
        service.disable(USER, 'mala', { code: code() }, ADMIN_CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.state.enabledAt).not.toBeNull();
    });

    it('sin un segundo factor válido no desactiva, aunque la contraseña sea buena', async () => {
      const { service, repo, enroll } = await setup();
      await enroll();
      await expect(
        service.disable(USER, PASSWORD, { code: '000000' }, ADMIN_CTX),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.state.enabledAt).not.toBeNull();
    });

    it('con contraseña + código desactiva, borra los códigos, sube tokenVersion y audita', async () => {
      const { service, repo, enroll, code, forgetLastStep } = await setup();
      await enroll();
      forgetLastStep();
      const tv = await service.disable(
        USER,
        PASSWORD,
        { code: code() },
        ADMIN_CTX,
      );
      expect(tv).toBe(6);
      expect(repo.state.enabledAt).toBeNull();
      expect(repo.state.secretEnc).toBeNull();
      expect(repo.codes).toHaveLength(0);
      expect(repo.audits.at(-1)?.metadata.reason).toBe('MFA_DISABLED');
    });

    it('también con un código de recuperación', async () => {
      const { service, repo, enroll } = await setup();
      const { recoveryCodes } = await enroll();
      await service.disable(
        USER,
        PASSWORD,
        { recoveryCode: recoveryCodes[0] },
        ADMIN_CTX,
      );
      expect(repo.state.enabledAt).toBeNull();
    });

    it('no se puede si la clínica lo exige a los ADMIN (403), ni a un superadmin', async () => {
      const a = await setup();
      await a.enroll();
      a.forgetLastStep();
      a.repo.requireAdminMfa = true;
      await expect(
        a.service.disable(USER, PASSWORD, { code: a.code() }, ADMIN_CTX),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Un DENTIST de esa misma clínica sí puede (la política es de ADMIN).
      await expect(
        a.service.disable(
          USER,
          PASSWORD,
          { code: a.code() },
          { ...CTX, role: ClinicRole.DENTIST },
        ),
      ).resolves.toBe(6);

      const b = await setup();
      await b.enroll();
      b.repo.state.isPlatformAdmin = true;
      b.forgetLastStep();
      await expect(
        b.service.disable(
          USER,
          PASSWORD,
          { code: b.code() },
          { ...CTX, role: ClinicRole.DENTIST },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('política de la clínica', () => {
    it('obligatorio: superadmin siempre; ADMIN solo con la política; otros roles nunca', async () => {
      const { service, repo } = await setup();
      await expect(
        service.isRequired(
          { isPlatformAdmin: true },
          TENANT,
          ClinicRole.RECEPTION,
        ),
      ).resolves.toBe(true);
      await expect(
        service.isRequired(
          { isPlatformAdmin: false },
          TENANT,
          ClinicRole.ADMIN,
        ),
      ).resolves.toBe(false);
      repo.requireAdminMfa = true;
      await expect(
        service.isRequired(
          { isPlatformAdmin: false },
          TENANT,
          ClinicRole.ADMIN,
        ),
      ).resolves.toBe(true);
      await expect(
        service.isRequired(
          { isPlatformAdmin: false },
          TENANT,
          ClinicRole.DENTIST,
        ),
      ).resolves.toBe(false);
    });

    it('encenderla exige tener el MFA propio activo; el cambio se audita con antes y después', async () => {
      const { service, repo, enroll } = await setup();
      const on = { requireAdminMfa: true };
      await expect(service.setClinicPolicy(on, CTX)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await enroll();
      await expect(service.setClinicPolicy(on, CTX)).resolves.toEqual({
        requireAdminMfa: true,
        requireAllMfa: false,
      });
      expect(repo.policyRoles).toEqual([ClinicRole.ADMIN]);
      // Sin cambio, sin evento.
      await service.setClinicPolicy(on, CTX);
      const policy = repo.audits.filter(
        (e) => e.metadata.reason === 'MFA_POLICY',
      );
      expect(policy).toHaveLength(1);
      expect(policy[0].metadata).toEqual({
        reason: 'MFA_POLICY',
        statusChange: { from: 'ADMIN_MFA_OPTIONAL', to: 'ADMIN_MFA_REQUIRED' },
      });
    });

    it('DX-021-bis: «para todos» implica ADMIN y solo cierra a quienes quedan obligados de nuevo', async () => {
      const { service, repo, enroll } = await setup();
      await enroll();
      repo.requireAdminMfa = true;
      await expect(
        service.setClinicPolicy(
          { requireAdminMfa: false, requireAllMfa: true },
          CTX,
        ),
      ).resolves.toEqual({ requireAdminMfa: true, requireAllMfa: true });
      expect(repo.policyRoles).not.toContain(ClinicRole.ADMIN);
      expect(repo.policyRoles).toContain(ClinicRole.RECEPTION);
      // Relajarla no cierra nada ni exige MFA propio.
      await service.setClinicPolicy(
        { requireAdminMfa: false, requireAllMfa: false },
        CTX,
      );
      expect(repo.policyRoles).toEqual([]);
    });

    it('DX-021-bis: `requireAllMfa` obliga a un rol no ADMIN', async () => {
      const { service, repo } = await setup();
      repo.requireAllMfa = true;
      await expect(
        service.isRequired(
          { isPlatformAdmin: false },
          TENANT,
          ClinicRole.RECEPTION,
        ),
      ).resolves.toBe(true);
    });
  });

  describe('avisos por correo (DX-021-bis)', () => {
    it('usar un código de recuperación avisa, con los que quedan y sin el código', async () => {
      const { service, repo, enroll, notices } = await setup();
      const { recoveryCodes } = await enroll();
      await service.verifySecondFactor(
        USER,
        (await repo.find())!,
        { recoveryCode: recoveryCodes[0] },
        TENANT,
      );
      expect(notices.slice(1)).toEqual([
        {
          tenantId: TENANT,
          to: 'ana@clinica.test',
          kind: 'RECOVERY_CODE_USED',
          recoveryCodesRemaining: 9,
        },
      ]);
    });

    it('el fallo que deja la cuenta en espera avisa una sola vez', async () => {
      const { service, repo, enroll, notices } = await setup();
      await enroll();
      for (let i = 0; i < 5; i += 1) {
        await service.verifySecondFactor(
          USER,
          (await repo.find())!,
          { code: '000000' },
          TENANT,
        );
      }
      await expect(
        service.verifySecondFactor(
          USER,
          (await repo.find())!,
          { code: '000000' },
          TENANT,
        ),
      ).rejects.toThrow();
      expect(notices).toEqual([
        { tenantId: TENANT, to: 'ana@clinica.test', kind: 'ENABLED' },
        { tenantId: TENANT, to: 'ana@clinica.test', kind: 'ATTEMPTS_LOCKED' },
      ]);
    });
  });

  describe('dispositivo de confianza (DX-021-bis)', () => {
    it('vale con la cookie y deja de valer si cambia tokenVersion o se revoca', async () => {
      const { service, repo, enroll } = await setup();
      await enroll();
      const state = (await repo.find())!;
      const token = await service.trustDevice(USER, state.tokenVersion, CTX);
      expect(repo.devices[0].tokenHash).not.toContain(token);
      await expect(
        service.isTrustedDevice(USER, state, token, CTX),
      ).resolves.toBe(true);
      await expect(
        service.isTrustedDevice(USER, state, 'otra', CTX),
      ).resolves.toBe(false);
      await expect(
        service.isTrustedDevice(
          USER,
          { ...state, tokenVersion: state.tokenVersion + 1 },
          token,
          CTX,
        ),
      ).resolves.toBe(false);
      await service.revokeTrustedDevices(USER, null, CTX);
      await expect(
        service.isTrustedDevice(USER, state, token, CTX),
      ).resolves.toBe(false);
    });

    it('un superadmin nunca se salta el código', async () => {
      const { service, repo, enroll } = await setup();
      await enroll();
      repo.state.isPlatformAdmin = true;
      const state = (await repo.find())!;
      const token = await service.trustDevice(USER, state.tokenVersion, CTX);
      await expect(
        service.isTrustedDevice(USER, state, token, CTX),
      ).resolves.toBe(false);
    });
  });

  describe('un superadmin no se enrola desde «Mi perfil» (DX-021-bis)', () => {
    it('403 con su contraseña; el alta del login (`null`) sí llega', async () => {
      const { service } = await setup({ isPlatformAdmin: true });
      await expect(
        service.startEnrollment(USER, PASSWORD, CTX),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.startEnrollment(USER, null, CTX),
      ).resolves.toMatchObject({ secret: expect.any(String) as string });
    });
  });

  describe('reseteo por otro ADMIN (DX-021-bis)', () => {
    const TARGET = '11111111-1111-4111-8111-111111111111';
    const input = (factor: SecondFactor) => ({
      currentPassword: PASSWORD,
      factor,
      reason: 'LOST_DEVICE' as const,
    });

    it('no vale para la propia cuenta ni para quien no es de la clínica', async () => {
      const { service, repo, enroll } = await setup();
      await enroll();
      await expect(
        service.resetForMember(USER, input({ code: '000000' }), CTX),
      ).rejects.toBeInstanceOf(ConflictException);
      repo.memberRole = null;
      await expect(
        service.resetForMember(TARGET, input({ code: '000000' }), CTX),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('una cuenta con acceso a otra clínica se rechaza y queda auditado, sin tocarla', async () => {
      const { service, repo, enroll, forgetLastStep, code, recorded } =
        await setup();
      await enroll();
      forgetLastStep();
      repo.otherClinic = true;
      await expect(
        service.resetForMember(TARGET, input({ code: code() }), CTX),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(recorded.at(-1)?.metadata).toEqual({
        reason: 'MFA_RESET_REFUSED',
      });
      expect(repo.state.enabledAt).not.toBeNull();
    });
  });
});
