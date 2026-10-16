import {
  BadRequestException,
  GoneException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ResetPasswordUseCase } from './reset-password.use-case';
import { RequestPasswordResetUseCase } from './request-password-reset.use-case';
import {
  FakePasswordResetNotifier,
  InMemoryPasswordResetRepository,
} from './__fixtures__/in-memory-password-reset';
import type { PasswordService } from '../../../../shared/crypto/password.service';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';

const TENANT = 'tenant-a';
const meta = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-1' };

async function setup() {
  const repo = new InMemoryPasswordResetRepository();
  const notifier = new FakePasswordResetNotifier();
  repo.addMember({
    tenantId: TENANT,
    userId: 'u1',
    email: 'ana@clinica.co',
    role: 'RECEPTION',
  });
  repo.addMember({
    tenantId: 'tenant-b',
    userId: 'u1',
    email: 'ana@clinica.co',
    active: false,
  });
  const password = {
    hash: jest.fn((p: string) => Promise.resolve(`hash:${p}`)),
  } as unknown as PasswordService;
  const record = jest.fn().mockResolvedValue(undefined);
  const audit = { record } as unknown as RecordAuditEventUseCase;
  const useCase = new ResetPasswordUseCase(repo, password, audit);
  await new RequestPasswordResetUseCase(repo, notifier).execute({
    tenantId: TENANT,
    email: 'ana@clinica.co',
    linkBase: 'https://demo.dentalix.app',
  });
  const token = notifier.sent[0].resetUrl.split('/').pop()!;
  return { repo, notifier, useCase, token, record };
}

describe('ResetPasswordUseCase', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('token válido: cambia la contraseña, cierra sesiones, consume el token y audita sin datos sensibles', async () => {
    const { repo, useCase, token, record } = await setup();
    expect(await useCase.status({ tenantId: TENANT, token })).toBe('VALID');
    await useCase.execute({
      tenantId: TENANT,
      token,
      password: 'NuevaClave2026',
      meta,
    });
    expect(repo.passwords.get('u1')).toBe('hash:NuevaClave2026');
    expect(repo.tokenVersions.get('u1')).toBe(1);
    expect(await useCase.status({ tenantId: TENANT, token })).toBe('USED');
    expect(record).toHaveBeenCalledWith({
      tenantId: TENANT,
      locationId: null,
      actor: { kind: 'user', userId: 'u1', role: 'RECEPTION' },
      action: 'PASSWORD_RESET',
      resourceType: 'SESSION',
      resourceId: null,
      patient: null,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      metadata: {},
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain(token);
    expect(JSON.stringify(record.mock.calls)).not.toContain('NuevaClave2026');
  });

  it('un solo uso: el segundo intento responde 410 en español', async () => {
    const { useCase, token } = await setup();
    await useCase.execute({
      tenantId: TENANT,
      token,
      password: 'NuevaClave2026',
      meta,
    });
    await expect(
      useCase.execute({
        tenantId: TENANT,
        token,
        password: 'OtraClave2026',
        meta,
      }),
    ).rejects.toBeInstanceOf(GoneException);
    await expect(
      useCase.execute({
        tenantId: TENANT,
        token,
        password: 'OtraClave2026',
        meta,
      }),
    ).rejects.toThrow(/ya se usó/);
  });

  it('caducado a los 30 min: 410 y la cuenta no cambia', async () => {
    const { repo, useCase, token } = await setup();
    jest.useFakeTimers({ now: Date.now() + 30 * 60_000 + 1 });
    expect(await useCase.status({ tenantId: TENANT, token })).toBe('EXPIRED');
    await expect(
      useCase.execute({
        tenantId: TENANT,
        token,
        password: 'NuevaClave2026',
        meta,
      }),
    ).rejects.toThrow(/caducó/);
    expect(repo.passwords.has('u1')).toBe(false);
    expect(repo.tokenVersions.get('u1')).toBe(0);
  });

  it('inexistente, mal formado o reemplazado: 404 en español', async () => {
    const { notifier, repo, useCase, token } = await setup();
    for (const bad of ['no-es-un-token', 'A'.repeat(43)]) {
      await expect(
        useCase.execute({
          tenantId: TENANT,
          token: bad,
          password: 'NuevaClave2026',
          meta,
        }),
      ).rejects.toThrow(NotFoundException);
    }
    await new RequestPasswordResetUseCase(repo, notifier).execute({
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: 'https://demo.dentalix.app',
    });
    expect(await useCase.status({ tenantId: TENANT, token })).toBe('INVALID');
    await expect(
      useCase.execute({
        tenantId: TENANT,
        token,
        password: 'NuevaClave2026',
        meta,
      }),
    ).rejects.toThrow(/no es válido/);
  });

  it('en el host de otra clínica (sin membresía activa) el enlace no existe', async () => {
    const { repo, useCase, token } = await setup();
    expect(await useCase.status({ tenantId: 'tenant-b', token })).toBe(
      'INVALID',
    );
    expect(await useCase.status({ tenantId: 'tenant-c', token })).toBe(
      'INVALID',
    );
    await expect(
      useCase.execute({
        tenantId: 'tenant-b',
        token,
        password: 'NuevaClave2026',
        meta,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(repo.passwords.has('u1')).toBe(false);
  });

  it('exige la política de contraseña antes de tocar el token', async () => {
    const { useCase, token } = await setup();
    await expect(
      useCase.execute({ tenantId: TENANT, token, password: 'corta', meta }),
    ).rejects.toThrow(BadRequestException);
    expect(await useCase.status({ tenantId: TENANT, token })).toBe('VALID');
  });

  it('carrera: si otro lo consumió entre la lectura y el uso → 410', async () => {
    const { repo, useCase, token } = await setup();
    jest
      .spyOn(repo, 'consumeAndSetPassword')
      .mockImplementationOnce(async (input) => {
        await repo.consumeAndSetPassword(input);
        return false;
      });
    await expect(
      useCase.execute({
        tenantId: TENANT,
        token,
        password: 'NuevaClave2026',
        meta,
      }),
    ).rejects.toThrow(GoneException);
  });
});
