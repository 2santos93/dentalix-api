import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
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

function setup() {
  const repo = new InMemoryMfaRepo();
  const cipher = new MfaSecretCipher(randomBytes(32));
  return { repo, cipher, uc: new PlatformMfaUseCase(repo, cipher) };
}

describe('PlatformMfaUseCase (SEC-008)', () => {
  it('alta en dos pasos: secreto cifrado pendiente → confirmado con un código válido', async () => {
    const { repo, cipher, uc } = setup();
    await expect(uc.status(USER)).resolves.toEqual({
      enabled: false,
      enabledAt: null,
    });

    const { secret, otpauthUri } = await uc.start(USER);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain('Dentalix:soporte%40dentalix.app');
    expect(repo.state!.pendingSecretEnc).not.toContain(secret);
    expect(cipher.decrypt(repo.state!.pendingSecretEnc!, USER)).toBe(secret);

    const step = totpStep(Date.now());
    const status = await uc.confirm(USER, totpCode(decodeBase32(secret), step));
    expect(status.enabled).toBe(true);
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
});
