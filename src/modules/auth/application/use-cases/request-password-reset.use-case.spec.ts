import { Logger } from '@nestjs/common';
import {
  DEFAULT_PASSWORD_RESET_CONCURRENCY,
  RequestPasswordResetUseCase,
  passwordResetConcurrency,
} from './request-password-reset.use-case';
import {
  FakePasswordResetNotifier,
  InMemoryPasswordResetRepository,
} from './__fixtures__/in-memory-password-reset';
import { hashPasswordResetToken } from '../password-reset-token';
import { PasswordResetThrottledError } from '../../domain/password-reset-throttled.error';
import type { PreparedPasswordResetEmail } from '../../domain/ports/password-reset-notifier.port';

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

  it('DX-149-ter: el tope que salta DENTRO de la transacción (otra petición ganó la carrera): THROTTLED, el token anterior sigue vigente y no hay email nuevo', async () => {
    const { repo, notifier, useCase } = setup();
    const input = {
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: LINK_BASE,
    };
    await useCase.execute(input);
    const before = repo.tokens.map((t) => ({ ...t }));
    // El aviso temprano pasa (aún no veía el email del ganador), pero el
    // recuento bajo candado, en la transacción del token, ya lo ve.
    notifier.throttleInTx = true;

    expect(await useCase.execute(input)).toBe('THROTTLED');

    expect(repo.tokens).toEqual(before);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.kicks).toBe(1);
  });

  it('DX-149-ter: el candado ocupado más allá del lock_timeout cuenta como tope (THROTTLED, nada cambia)', async () => {
    const { repo, notifier, useCase } = setup();
    repo.failNextIssue = new PasswordResetThrottledError('LOCK_TIMEOUT');

    expect(
      await useCase.execute({
        tenantId: TENANT,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      }),
    ).toBe('THROTTLED');

    expect(repo.tokens).toHaveLength(0);
    expect(notifier.sent).toHaveLength(0);
    expect(notifier.kicks).toBe(0);
  });

  it('DX-149-ter: el email entra en la MISMA transacción que el token y el despachador se despierta tras el COMMIT', async () => {
    const { repo, notifier, useCase } = setup();
    await useCase.execute({
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: LINK_BASE,
    });
    expect(repo.issuedWithEmail).toEqual([TENANT]);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.kicks).toBe(1);
  });

  it('otro fallo de la transacción no es un tope: se propaga (accept lo deja en el log)', async () => {
    const { repo, useCase } = setup();
    repo.failNextIssue = new Error('db down');
    await expect(
      useCase.execute({
        tenantId: TENANT,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      }),
    ).rejects.toThrow('db down');
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

  it('DX-149-quater: el tope es POR USUARIO sumando sus clínicas: alcanzado en una, otra no emite (ni token ni email) y el log dice por qué', async () => {
    const { repo, notifier, useCase } = setup();
    repo.addMember({
      tenantId: 'tenant-b',
      userId: 'u1',
      email: 'ana@clinica.co',
    });
    notifier.dailyLimit = 2;
    const from = (tenantId: string) =>
      useCase.execute({
        tenantId,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      });
    expect(await from(TENANT)).toBe('SENT');
    expect(await from(TENANT)).toBe('SENT');
    const before = repo.tokens.map((t) => ({ ...t }));

    expect(await from('tenant-b')).toBe('THROTTLED');

    expect(repo.tokens).toEqual(before);
    expect(notifier.sent).toHaveLength(2);
    expect(notifier.kicks).toBe(2);
    expect(logSpy).toHaveBeenLastCalledWith({
      event: 'password_reset.requested',
      tenantId: 'tenant-b',
      outcome: 'THROTTLED',
      reason: 'USER_QUOTA',
    });
  });

  it('DX-149-quater: como mucho `concurrency` en curso a la vez; el resto espera turno en orden y sale, sin error', async () => {
    const repo = new InMemoryPasswordResetRepository();
    const notifier = new FakePasswordResetNotifier();
    for (let i = 0; i < 5; i++) {
      repo.addMember({
        tenantId: TENANT,
        userId: `u${i}`,
        email: `persona${i}@clinica.co`,
      });
    }
    // `prepare` no termina hasta que el test lo suelta: así se ve cuántos
    // hay dentro a la vez.
    const releases: (() => void)[] = [];
    const inside: string[] = [];
    const prepare = notifier.prepare.bind(notifier);
    jest
      .spyOn(notifier, 'prepare')
      .mockImplementation(
        async (email): Promise<PreparedPasswordResetEmail> => {
          inside.push(email.userId);
          await new Promise<void>((resolve) => releases.push(resolve));
          return prepare(email);
        },
      );
    const useCase = new RequestPasswordResetUseCase(repo, notifier, 2);
    const flush = () => new Promise((r) => setImmediate(r));

    const all = [0, 1, 2, 3, 4].map((i) =>
      useCase.execute({
        tenantId: TENANT,
        email: `persona${i}@clinica.co`,
        linkBase: LINK_BASE,
      }),
    );
    await flush();
    expect(inside).toEqual(['u0', 'u1']);

    releases.shift()!();
    await flush();
    expect(inside).toEqual(['u0', 'u1', 'u2']);

    while (inside.length < 5 || releases.length > 0) {
      releases.shift()?.();
      await flush();
    }
    await expect(Promise.all(all)).resolves.toEqual([
      'SENT',
      'SENT',
      'SENT',
      'SENT',
      'SENT',
    ]);
  });

  it('DX-149-quater: un fallo no se queda con el turno', async () => {
    const { repo } = setup();
    const one = new RequestPasswordResetUseCase(
      repo,
      new FakePasswordResetNotifier(),
      1,
    );
    repo.failNextIssue = new Error('db down');
    const input = {
      tenantId: TENANT,
      email: 'ana@clinica.co',
      linkBase: LINK_BASE,
    };
    await expect(one.execute(input)).rejects.toThrow('db down');
    await expect(one.execute(input)).resolves.toBe('SENT');
  });

  it('DX-149-quater: PASSWORD_RESET_MAX_CONCURRENCY vacío = 4; si no, su valor', () => {
    expect(DEFAULT_PASSWORD_RESET_CONCURRENCY).toBe(4);
    expect(passwordResetConcurrency(undefined)).toBe(4);
    expect(passwordResetConcurrency('  ')).toBe(4);
    expect(passwordResetConcurrency(' 8 ')).toBe(8);
  });
});
