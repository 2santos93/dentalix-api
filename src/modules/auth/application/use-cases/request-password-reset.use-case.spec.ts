import { Logger } from '@nestjs/common';
import {
  PASSWORD_RESET_DROP_LOG_INTERVAL_MS,
  RequestPasswordResetUseCase,
} from './request-password-reset.use-case';
import {
  DEFAULT_PASSWORD_RESET_LIMITS,
  loadPasswordResetLimits,
} from '../password-reset-limits';
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

  it('DX-149-quater: el tope es POR USUARIO sumando sus clínicas: alcanzado en una, otra no emite (ni token ni email, ni siquiera lo prepara) y el log dice por qué', async () => {
    const { repo, notifier } = setup();
    repo.addMember({
      tenantId: 'tenant-b',
      userId: 'u1',
      email: 'ana@clinica.co',
    });
    const useCase = new RequestPasswordResetUseCase(repo, notifier, {
      userDailyLimit: 2,
    });
    const prepare = jest.spyOn(notifier, 'prepare');
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

    // El aviso temprano ya lo frena: sin renderizar ni cifrar nada.
    expect(prepare).toHaveBeenCalledTimes(2);
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

  it('DX-149-quater: el tope por usuario que salta bajo el bloqueo de la fila (otra petición ganó) también es THROTTLED USER_QUOTA', async () => {
    const { repo, notifier, useCase } = setup();
    repo.failNextIssue = new PasswordResetThrottledError('USER_QUOTA');
    expect(
      await useCase.execute({
        tenantId: TENANT,
        email: 'ana@clinica.co',
        linkBase: LINK_BASE,
      }),
    ).toBe('THROTTLED');
    expect(repo.tokens).toHaveLength(0);
    expect(notifier.kicks).toBe(0);
    expect(logSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: 'THROTTLED', reason: 'USER_QUOTA' }),
    );
  });

  /**
   * `prepare` no termina hasta que el test lo suelta: así se ve quién tiene
   * turno. Cinco personas de la clínica.
   */
  function parked(
    limits: ConstructorParameters<typeof RequestPasswordResetUseCase>[2],
    now?: () => number,
  ) {
    const repo = new InMemoryPasswordResetRepository();
    const notifier = new FakePasswordResetNotifier();
    for (let i = 0; i < 5; i++) {
      repo.addMember({
        tenantId: TENANT,
        userId: `u${i}`,
        email: `persona${i}@clinica.co`,
      });
    }
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
    const lookups = jest.spyOn(repo, 'findActiveMember');
    const useCase = new RequestPasswordResetUseCase(
      repo,
      notifier,
      limits,
      now,
    );
    const fire = (i: number) =>
      useCase.execute({
        tenantId: TENANT,
        email: `persona${i}@clinica.co`,
        linkBase: LINK_BASE,
      });
    return { repo, notifier, useCase, releases, inside, lookups, fire };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('DX-149-quater: como mucho `concurrency` en curso a la vez; el resto espera turno en orden y sale, sin error', async () => {
    const { releases, inside, fire } = parked({ concurrency: 2 });

    const all = [0, 1, 2, 3, 4].map(fire);
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

  it('DX-149-quater: cola acotada: con concurrencia 1 y cola 2, de 5 a la vez uno trabaja, 2 esperan y 2 se descartan al momento (sin tocar la BD)', async () => {
    const { releases, inside, lookups, fire } = parked({
      concurrency: 1,
      maxQueue: 2,
    });
    const results: (string | undefined)[] = [];
    const all = [0, 1, 2, 3, 4].map((i) =>
      fire(i).then((outcome) => (results[i] = outcome)),
    );
    await flush();

    // El turno sigue ocupado y aun así los dos de más ya terminaron.
    expect(inside).toEqual(['u0']);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      undefined,
      undefined,
      undefined,
      'THROTTLED',
      'THROTTLED',
    ]);

    while (inside.length < 3 || releases.length > 0) {
      releases.shift()?.();
      await flush();
    }
    await Promise.all(all);
    expect(results).toEqual(['SENT', 'SENT', 'SENT', 'THROTTLED', 'THROTTLED']);
    expect(lookups).toHaveBeenCalledTimes(3);
  });

  it('DX-149-quater: quien esperó más de `queueMaxWaitMs` se descarta al llegarle el turno, y el turno pasa al siguiente', async () => {
    let now = 1_000_000;
    const { releases, inside, lookups, fire } = parked(
      { concurrency: 1, maxQueue: 5, queueMaxWaitMs: 30_000 },
      () => now,
    );
    const results: (string | undefined)[] = [];
    const track = (i: number) =>
      fire(i).then((outcome) => (results[i] = outcome));
    const first = [track(0), track(1)];
    await flush();
    now += 30_001; // u1 ya lleva más de 30 s esperando
    const late = track(2); // u2 acaba de llegar
    await flush();

    releases.shift()!();
    await flush();
    expect(results[1]).toBe('THROTTLED');
    expect(inside).toEqual(['u0', 'u2']);

    releases.shift()!();
    await Promise.all([...first, late]);
    expect(results).toEqual(['SENT', 'THROTTLED', 'SENT']);
    expect(lookups).toHaveBeenCalledTimes(2);
  });

  it('DX-149-quater: los descartes no dejan una línea por petición: como mucho una cada 10 s, solo con recuentos', async () => {
    let now = 5_000_000;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { releases, inside, fire } = parked(
        { concurrency: 1, maxQueue: 1 },
        () => now,
      );
      const held = [fire(0), fire(1)];
      await flush();
      // Tres descartes seguidos: una sola línea, la primera.
      await Promise.all([fire(2), fire(3), fire(4)]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenLastCalledWith({
        event: 'password_reset.dropped',
        queueFull: 1,
        queueExpired: 0,
        queued: 1,
        concurrency: 1,
      });
      // Pasados 10 s, el siguiente descarte cuenta también los callados.
      now += PASSWORD_RESET_DROP_LOG_INTERVAL_MS;
      await fire(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ queueFull: 3, queueExpired: 0 }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /persona|clinica|tenant-a/,
      );
      while (inside.length < 2 || releases.length > 0) {
        releases.shift()?.();
        await flush();
      }
      await Promise.all(held);
    } finally {
      warn.mockRestore();
    }
  });

  it('DX-149-quater: un fallo no se queda con el turno', async () => {
    const { repo } = setup();
    const one = new RequestPasswordResetUseCase(
      repo,
      new FakePasswordResetNotifier(),
      { concurrency: 1 },
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

  it('DX-149-quater: límites del entorno; vacíos = 4 en curso, 1000 en cola, 30 s de espera y 5 por usuario', () => {
    expect(DEFAULT_PASSWORD_RESET_LIMITS).toEqual({
      concurrency: 4,
      maxQueue: 1000,
      queueMaxWaitMs: 30_000,
      userDailyLimit: 5,
    });
    expect(loadPasswordResetLimits(() => undefined)).toEqual(
      DEFAULT_PASSWORD_RESET_LIMITS,
    );
    const env: Record<string, string> = {
      PASSWORD_RESET_MAX_CONCURRENCY: ' 8 ',
      PASSWORD_RESET_MAX_QUEUE: '200',
      PASSWORD_RESET_USER_DAILY_LIMIT: '3',
      // Subir el tope de correos por destinatario no mueve el de usuario.
      MAIL_RECIPIENT_DAILY_LIMIT: '15',
    };
    expect(loadPasswordResetLimits((k) => env[k])).toEqual({
      concurrency: 8,
      maxQueue: 200,
      queueMaxWaitMs: 30_000,
      userDailyLimit: 3,
    });
  });
});
