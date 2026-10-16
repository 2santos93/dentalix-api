import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { OutgoingEmail } from '../domain/email-message';
import { Mailer } from '../domain/ports/mailer.port';
import { EmailPayloadCipher } from '../infrastructure/email-payload-cipher';
import { MailConfig } from '../infrastructure/mail-config';
import { InMemoryEmailOutboxRepository } from './__fixtures__/in-memory-email-outbox.repository';
import { EmailDispatcher } from './email-dispatcher.service';
import { EmailOutbox } from './email-outbox.service';
import { EmailQuotaExceededError } from '../domain/email-quota-exceeded.error';

const TENANT = '11111111-1111-4111-8111-111111111111';

function setup(mailer: Mailer, overrides: Partial<MailConfig> = {}) {
  const key = randomBytes(32);
  const config: MailConfig = {
    transport: 'console',
    smtpUrl: null,
    fileDir: null,
    from: 'no-reply@x.co',
    dispatchIntervalMs: 0,
    retryBaseMs: 60_000,
    leaseSeconds: 300,
    batchSize: 20,
    encryptionKey: key,
    ephemeralKey: false,
    production: false,
    quotas: {
      tenantDaily: 1000,
      recipientDaily: 1000,
      recipientCooldownSeconds: 0,
    },
    ...overrides,
  };
  const repo = new InMemoryEmailOutboxRepository();
  repo.brands.set(TENANT, {
    name: 'Clínica Demo',
    logoUrl: null,
    primaryColor: '#0F5E9C',
  });
  const cipher = new EmailPayloadCipher(key);
  const dispatcher = new EmailDispatcher(repo, mailer, cipher, config);
  const outbox = new EmailOutbox(repo, cipher, dispatcher, config);
  return { repo, cipher, dispatcher, outbox, config };
}

const invitationInput = {
  tenantId: TENANT,
  to: 'ana.perez@clinica.co',
  template: 'invitation' as const,
  vars: {
    inviteeName: 'Ana',
    roleLabel: 'Asistente',
    acceptUrl: 'https://demo.dentalix.app/invitacion/TOKEN-SECRETO',
    expiresInDays: 7,
  },
  referenceId: '22222222-2222-4222-8222-222222222222',
};

class RecordingMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  send(message: OutgoingEmail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

class FailingMailer implements Mailer {
  calls = 0;
  send(): Promise<void> {
    this.calls += 1;
    return Promise.reject(
      Object.assign(new Error('550 <ana.perez@clinica.co> unknown'), {
        responseCode: 550,
      }),
    );
  }
}

describe('EmailOutbox + EmailDispatcher', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(() => {
    Logger.overrideLogger(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('encolar guarda UNA fila sin el email ni el token en claro y el despachador la envía', async () => {
    const mailer = new RecordingMailer();
    const { repo, outbox, dispatcher, cipher } = setup(mailer);

    const { id } = await outbox.enqueue(invitationInput);
    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0];
    expect(row.id).toBe(id);
    expect(row.toMasked).toBe('an***@clinica.co');
    expect(row.toHash).toBe(cipher.hashRecipient('ana.perez@clinica.co'));
    expect(
      JSON.stringify({ ...row, payload: undefined, storedPayload: undefined }),
    ).not.toMatch(/ana\.perez|TOKEN-SECRETO/);
    expect(row.payload.toString('latin1')).not.toMatch(
      /ana\.perez|TOKEN-SECRETO/,
    );

    await dispatcher.whenIdle();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('ana.perez@clinica.co');
    expect(mailer.sent[0].subject).toBe('Te invitaron a unirte a Clínica Demo');
    expect(mailer.sent[0].text).toContain('TOKEN-SECRETO');
    expect(row.status).toBe('SENT');
    expect(row.attempts).toBe(1);
    expect(row.storedPayload).toBeNull();
    expect(row.sentAt).toBeInstanceOf(Date);
  });

  it('enqueue no espera al proveedor (un mailer de 3 s no frena la respuesta)', async () => {
    let release: () => void = () => undefined;
    const slow: Mailer = {
      send: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const { outbox, dispatcher, repo } = setup(slow);
    const started = Date.now();
    await outbox.enqueue(invitationInput);
    expect(Date.now() - started).toBeLessThan(300);
    expect(repo.rows[0].status).not.toBe('SENT');
    release();
    await dispatcher.whenIdle();
    expect(repo.rows[0].status).toBe('SENT');
  });

  it('fallo del proveedor: attempts++, backoff exponencial y FAILED al 3.er fallo', async () => {
    const mailer = new FailingMailer();
    const { repo, outbox, dispatcher } = setup(mailer, { retryBaseMs: 60_000 });
    await outbox.enqueue(invitationInput);
    await dispatcher.whenIdle();
    const row = repo.rows[0];

    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('Error 550');
    const firstDelay = row.nextAttemptAt.getTime() - Date.now();
    expect(firstDelay).toBeGreaterThan(55_000);
    expect(firstDelay).toBeLessThanOrEqual(60_000);

    // Aún no vence: el barrido no lo toca.
    expect(await dispatcher.dispatchBatch()).toBe(0);

    row.nextAttemptAt = new Date(Date.now() - 1);
    await dispatcher.dispatchBatch();
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(2);
    const secondDelay = row.nextAttemptAt.getTime() - Date.now();
    expect(secondDelay).toBeGreaterThan(115_000);
    expect(secondDelay).toBeLessThanOrEqual(120_000);

    row.nextAttemptAt = new Date(Date.now() - 1);
    await dispatcher.dispatchBatch();
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(3);
    expect(row.storedPayload).toBeNull();
    expect(mailer.calls).toBe(3);
    // El error guardado no repite el destinatario del mensaje del proveedor.
    expect(row.lastError).not.toContain('@');

    row.nextAttemptAt = new Date(Date.now() - 1);
    expect(await dispatcher.dispatchBatch()).toBe(0);
  });

  it('un SENDING huérfano con los intentos gastados queda FAILED sin reenviarse', async () => {
    const mailer = new RecordingMailer();
    const { repo, outbox, dispatcher } = setup(mailer);
    await outbox.enqueue(invitationInput);
    await dispatcher.whenIdle();
    repo.rows[0].status = 'SENDING';
    repo.rows[0].attempts = 3;
    repo.rows[0].storedPayload = repo.rows[0].payload;
    repo.rows[0].nextAttemptAt = new Date(Date.now() - 1);
    await dispatcher.dispatchBatch();
    expect(repo.rows[0].status).toBe('FAILED');
    expect(repo.rows[0].lastError).toBe('MaxAttemptsExceeded');
    expect(mailer.sent).toHaveLength(1);
  });

  it('un payload de otra clave queda FAILED (DecryptError) sin reintentos', async () => {
    const mailer = new RecordingMailer();
    const { repo, dispatcher } = setup(mailer);
    const foreign = new EmailPayloadCipher(randomBytes(32));
    const payload = foreign.encrypt({
      to: 'x@y.co',
      subject: 's',
      html: 'h',
      text: 't',
    });
    await repo.insert({
      tenantId: TENANT,
      template: 'invitation',
      toHash: 'a'.repeat(64),
      toMasked: 'x***@y.co',
      referenceId: null,
      payload,
    });
    await dispatcher.dispatchBatch();
    expect(repo.rows[0].status).toBe('FAILED');
    expect(repo.rows[0].lastError).toBe('DecryptError');
    expect(mailer.sent).toHaveLength(0);
  });

  it('una BD caída durante el barrido no lanza (se reintenta en el próximo)', async () => {
    const mailer = new RecordingMailer();
    const { repo, dispatcher } = setup(mailer);
    jest.spyOn(repo, 'claimDue').mockRejectedValueOnce(new Error('db down'));
    dispatcher.kick();
    await expect(dispatcher.whenIdle()).resolves.toBeUndefined();
  });

  it('cancela los pendientes de una referencia (reenviar/revocar)', async () => {
    const mailer = new RecordingMailer();
    const { repo, outbox, dispatcher } = setup(mailer);
    await dispatcher.onModuleDestroy(); // sin despachos: queda PENDING
    await outbox.enqueue(invitationInput);
    expect(
      await outbox.supersedePending(
        TENANT,
        invitationInput.referenceId,
        'invitation',
      ),
    ).toBe(1);
    expect(repo.rows[0].status).toBe('FAILED');
    expect(repo.rows[0].lastError).toBe('Superseded');
    expect(repo.rows[0].storedPayload).toBeNull();
  });

  it('sin tenant: email de plataforma firmado por Dentalix', async () => {
    const mailer = new RecordingMailer();
    const { repo, outbox, dispatcher } = setup(mailer);
    await outbox.enqueue({ ...invitationInput, tenantId: undefined });
    await dispatcher.whenIdle();
    expect(repo.rows[0].tenantId).toBeNull();
    expect(mailer.sent[0].subject).toBe('Te invitaron a unirte a Dentalix');
  });

  it('barrido periódico: arranca con la app y se apaga ordenadamente', async () => {
    jest.useFakeTimers();
    const mailer = new RecordingMailer();
    const { dispatcher, repo } = setup(mailer, { dispatchIntervalMs: 1_000 });
    const claim = jest.spyOn(repo, 'claimDue');
    await dispatcher.onApplicationBootstrap();
    expect(claim).toHaveBeenCalledTimes(1);
    await dispatcher.whenIdle();
    jest.advanceTimersByTime(1_000);
    expect(claim).toHaveBeenCalledTimes(2);
    await dispatcher.onModuleDestroy();
    jest.advanceTimersByTime(5_000);
    expect(claim).toHaveBeenCalledTimes(2);
    dispatcher.kick();
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('con el barrido a 0 no programa nada', async () => {
    const spy = jest.spyOn(global, 'setInterval');
    const { dispatcher } = setup(new RecordingMailer());
    await dispatcher.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  describe('acceso del despachador al arrancar (revisión D4)', () => {
    it('en producción, sin acceso, la API no arranca', async () => {
      const { dispatcher, repo } = setup(new RecordingMailer(), {
        production: true,
      });
      repo.access = { executable: true, ownerSeesAllRows: false };
      await expect(dispatcher.onApplicationBootstrap()).rejects.toThrow(
        /dentalix_email_dispatcher/,
      );
      repo.access = { executable: false, ownerSeesAllRows: true };
      await expect(dispatcher.onApplicationBootstrap()).rejects.toThrow(
        /EXECUTE/,
      );
    });

    it('fuera de producción solo lo registra; con la BD caída no decide nada', async () => {
      const { dispatcher, repo } = setup(new RecordingMailer());
      repo.access = { executable: false, ownerSeesAllRows: false };
      await expect(
        dispatcher.onApplicationBootstrap(),
      ).resolves.toBeUndefined();
      const prod = setup(new RecordingMailer(), { production: true });
      jest
        .spyOn(prod.repo, 'dispatcherAccess')
        .mockRejectedValueOnce(new Error('db down'));
      await expect(prod.dispatcher.onModuleDestroy()).resolves.toBeUndefined();
      await expect(
        prod.dispatcher.onApplicationBootstrap(),
      ).resolves.toBeUndefined();
    });
  });

  it('al apagar cierra el transporte del proveedor', async () => {
    const close = jest.fn();
    const mailer: Mailer = { send: () => Promise.resolve(), close };
    const { dispatcher } = setup(mailer);
    await dispatcher.onModuleDestroy();
    expect(close).toHaveBeenCalled();
  });

  it('topes: enfriamiento por destinatario, máximo diario por destinatario y por clínica', async () => {
    const { outbox, dispatcher, repo } = setup(new RecordingMailer(), {
      quotas: {
        tenantDaily: 3,
        recipientDaily: 2,
        recipientCooldownSeconds: 60,
      },
    });
    await dispatcher.onModuleDestroy();
    await outbox.assertWithinQuota(TENANT, invitationInput.to);
    await outbox.enqueue(invitationInput);
    await expect(
      outbox.assertWithinQuota(TENANT, ' ANA.perez@clinica.co '),
    ).rejects.toBeInstanceOf(EmailQuotaExceededError);
    for (const r of repo.rows) r.createdAt = new Date(Date.now() - 120_000);
    await outbox.enqueue(invitationInput);
    for (const r of repo.rows) r.createdAt = new Date(Date.now() - 120_000);
    await expect(
      outbox.assertWithinQuota(TENANT, invitationInput.to),
    ).rejects.toThrow('2 correos a esta persona');
    await outbox.enqueue({ ...invitationInput, to: 'otra@clinica.co' });
    await expect(
      outbox.assertWithinQuota(TENANT, 'tercera@clinica.co'),
    ).rejects.toThrow('máximo de 3 correos');
  });

  it('el cierre tardío de un intento ya re-reclamado no pisa el estado (fencing)', async () => {
    const { repo, outbox, dispatcher } = setup(new RecordingMailer());
    await dispatcher.onModuleDestroy();
    await outbox.enqueue(invitationInput);
    const [first] = await repo.claimDue(1, 300);
    repo.rows[0].nextAttemptAt = new Date(Date.now() - 1);
    const [second] = await repo.claimDue(1, 300);
    expect(
      await repo.settle(first.id, first.attempts, { status: 'SENT' }),
    ).toBe(false);
    expect(
      await repo.settle(second.id, second.attempts, { status: 'SENT' }),
    ).toBe(true);
  });
});
