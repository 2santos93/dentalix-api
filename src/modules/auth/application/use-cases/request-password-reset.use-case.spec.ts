import { Logger } from '@nestjs/common';
import { RequestPasswordResetUseCase } from './request-password-reset.use-case';
import {
  FakePasswordResetNotifier,
  InMemoryPasswordResetRepository,
} from './__fixtures__/in-memory-password-reset';
import { hashPasswordResetToken } from '../password-reset-token';

const TENANT = 'tenant-a';
const LINK_BASE = 'https://demo.dentalix.app';

function setup() {
  const repo = new InMemoryPasswordResetRepository();
  const notifier = new FakePasswordResetNotifier();
  repo.addMember({ tenantId: TENANT, userId: 'u1', email: 'ana@clinica.co' });
  const useCase = new RequestPasswordResetUseCase(repo, notifier);
  return { repo, notifier, useCase };
}

describe('RequestPasswordResetUseCase', () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  it('miembro activo: guarda solo el hash y envía el enlace al host de la clínica', async () => {
    const { repo, notifier, useCase } = setup();
    const outcome = await useCase.execute({
      tenantId: TENANT,
      email: '  ANA@clinica.co ',
      linkBase: LINK_BASE,
    });
    expect(outcome).toBe('SENT');
    expect(notifier.sent).toHaveLength(1);
    const [email] = notifier.sent;
    expect(email).toMatchObject({
      tenantId: TENANT,
      userId: 'u1',
      to: 'ana@clinica.co',
      expiresInMinutes: 30,
    });
    const match =
      /^https:\/\/demo\.dentalix\.app\/restablecer\/([A-Za-z0-9_-]{43})$/.exec(
        email.resetUrl,
      );
    expect(match).not.toBeNull();
    const token = match![1];
    expect(repo.tokens).toHaveLength(1);
    expect(repo.tokens[0].tokenHash).toBe(hashPasswordResetToken(token));
    expect(JSON.stringify(repo.tokens)).not.toContain(token);
    const expiresInMs = repo.tokens[0].expiresAt.getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(29 * 60_000);
    expect(expiresInMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it('pedir otro invalida los anteriores', async () => {
    const { repo, useCase } = setup();
    const input = {
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: LINK_BASE,
    };
    await useCase.execute(input);
    await useCase.execute(input);
    expect(repo.tokens).toHaveLength(2);
    expect(repo.tokens[0].invalidatedAt).not.toBeNull();
    expect(repo.tokens[1].invalidatedAt).toBeNull();
  });

  it('email desconocido, inactivo o de otra clínica: no hace nada', async () => {
    const { repo, notifier, useCase } = setup();
    repo.addMember({
      tenantId: TENANT,
      userId: 'u2',
      email: 'baja@clinica.co',
      active: false,
    });
    repo.addMember({
      tenantId: 'tenant-b',
      userId: 'u3',
      email: 'otra@clinica.co',
    });
    for (const email of [
      'nadie@clinica.co',
      'baja@clinica.co',
      'otra@clinica.co',
    ]) {
      expect(
        await useCase.execute({ tenantId: TENANT, email, linkBase: LINK_BASE }),
      ).toBe('NO_MEMBER');
    }
    expect(repo.tokens).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('tope de emails superado: no crea token ni envía (y no lo dice)', async () => {
    const { repo, notifier, useCase } = setup();
    notifier.quotaOk = false;
    expect(
      await useCase.execute({
        tenantId: TENANT,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      }),
    ).toBe('THROTTLED');
    expect(repo.tokens).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
  });

  it('el log no lleva ni el email ni el token', async () => {
    const { notifier, useCase } = setup();
    await useCase.execute({
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: LINK_BASE,
    });
    const token = notifier.sent[0].resetUrl.split('/').pop()!;
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).toContain('password_reset.requested');
    expect(logged).not.toContain('ana@clinica.co');
    expect(logged).not.toContain(token);
  });

  it('accept no espera y nunca rechaza (un fallo queda en el log sin datos)', async () => {
    const { repo, useCase } = setup();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest
      .spyOn(repo, 'findActiveMember')
      .mockRejectedValue(new Error('db down ana@clinica.co'));
    expect(
      useCase.accept({
        tenantId: TENANT,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      }),
    ).toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ana@clinica.co');
    warn.mockRestore();
  });
});
