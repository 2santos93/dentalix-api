import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MfaSecretCipher } from '../../../../shared/crypto/mfa-secret-cipher';
import {
  decodeBase32,
  totpCode,
  totpStep,
} from '../../../../shared/crypto/totp';
import type {
  PlatformMfaRepository,
  PlatformMfaState,
} from '../../domain/ports/platform-mfa-repository.port';
import { PlatformMfaUseCase } from './platform-mfa.use-case';

const USER = '6f0c3f9e-7d1b-4c2a-9e1f-0a1b2c3d4e5f';

class InMemoryMfaRepo implements PlatformMfaRepository {
  state:
    | (PlatformMfaState & { secretEnc: string | null; step: number | null })
    | null = {
    email: 'soporte@dentalix.app',
    enabledAt: null,
    pendingSecretEnc: null,
    secretEnc: null,
    step: null,
  };

  find(): Promise<PlatformMfaState | null> {
    return Promise.resolve(this.state);
  }

  savePending(_id: string, enc: string): Promise<boolean> {
    if (!this.state || this.state.enabledAt) return Promise.resolve(false);
    this.state.pendingSecretEnc = enc;
    return Promise.resolve(true);
  }

  confirm(_id: string, enc: string, step: number): Promise<Date | null> {
    if (
      !this.state ||
      this.state.enabledAt ||
      this.state.pendingSecretEnc !== enc
    ) {
      return Promise.resolve(null);
    }
    const enabledAt = new Date();
    Object.assign(this.state, {
      enabledAt,
      secretEnc: enc,
      pendingSecretEnc: null,
      step,
    });
    return Promise.resolve(enabledAt);
  }
}

function setup(env: Record<string, string> = {}) {
  const repo = new InMemoryMfaRepo();
  const cipher = new MfaSecretCipher(randomBytes(32));
  const config = new ConfigService(env);
  return { repo, cipher, uc: new PlatformMfaUseCase(repo, cipher, config) };
}

describe('PlatformMfaUseCase (SEC-008)', () => {
  it('alta en dos pasos: secreto cifrado pendiente → confirmado con un código válido', async () => {
    const { repo, cipher, uc } = setup();
    await expect(uc.status(USER)).resolves.toEqual({
      enabled: false,
      enabledAt: null,
      breakGlassAvailableAt: null,
    });

    const { secret, otpauthUri } = await uc.start(USER);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain('Dentalix:soporte%40dentalix.app');
    expect(repo.state!.pendingSecretEnc).not.toContain(secret);
    expect(cipher.decrypt(repo.state!.pendingSecretEnc!, USER)).toBe(secret);

    const step = totpStep(Date.now());
    const status = await uc.confirm(USER, totpCode(decodeBase32(secret), step));
    expect(status.enabled).toBe(true);
    // Espera de seguridad (SEC-008): por defecto 24 h tras el alta.
    expect(status.breakGlassAvailableAt!.getTime()).toBe(
      status.enabledAt!.getTime() + 24 * 60 * 60 * 1000,
    );
    expect(repo.state!.secretEnc).not.toBeNull();
    expect(repo.state!.step).toBe(step);
  });

  it('un código erróneo no activa nada (400)', async () => {
    const { repo, uc } = setup();
    const { secret } = await uc.start(USER);
    const valid = totpCode(decodeBase32(secret), totpStep(Date.now()));
    await expect(
      uc.confirm(USER, valid === '000000' ? '111111' : '000000'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.state!.enabledAt).toBeNull();
  });

  it('confirmar sin alta pendiente → 400', async () => {
    const { uc } = setup();
    await expect(uc.confirm(USER, '123456')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('con el MFA activo no se puede volver a enrolar ni confirmar (409)', async () => {
    const { uc } = setup();
    const { secret } = await uc.start(USER);
    await uc.confirm(
      USER,
      totpCode(decodeBase32(secret), totpStep(Date.now())),
    );
    await expect(uc.start(USER)).rejects.toBeInstanceOf(ConflictException);
    await expect(uc.confirm(USER, '123456')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('un usuario que ya no es superadmin → 403', async () => {
    const { repo, uc } = setup();
    repo.state = null;
    await expect(uc.status(USER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('breakGlassAvailableAt sigue BREAK_GLASS_MFA_COOLDOWN_MINUTES', async () => {
    const { repo, uc } = setup({ BREAK_GLASS_MFA_COOLDOWN_MINUTES: '90' });
    const enabledAt = new Date('2026-10-17T10:00:00.000Z');
    repo.state!.enabledAt = enabledAt;
    const status = await uc.status(USER);
    expect(status.breakGlassAvailableAt).toEqual(
      new Date('2026-10-17T11:30:00.000Z'),
    );
  });
});
