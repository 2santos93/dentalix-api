import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import { ConsoleMailer } from '../src/modules/notifications/email/infrastructure/mailers/console.mailer';
import type { Mailer } from '../src/modules/notifications/email/domain/ports/mailer.port';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';

// DX-088, capa de BD: email_outbox contra Postgres. RLS por clínica, las
// funciones SECURITY DEFINER del despachador (reclamar con SKIP LOCKED,
// cerrar, encolar de plataforma), el CHECK que borra el mensaje al terminar y
// el flujo completo encolar → despachar con ConsoleMailer y con un proveedor
// que falla.

const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaEmailOutboxRepository(prisma);
const cipher = new EmailPayloadCipher(randomBytes(32));

const SUBDOMAINS = ['outbox-int-a', 'outbox-int-b'];
const EMAIL = 'ana.perez@clinica-outbox.co';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';

function config(overrides: Partial<MailConfig> = {}): MailConfig {
  return {
    transport: 'console',
    smtpUrl: null,
    from: 'no-reply@x.co',
    dispatchIntervalMs: 0,
    retryBaseMs: 60_000,
    leaseSeconds: 300,
    batchSize: 20,
    encryptionKey: randomBytes(32),
    ephemeralKey: false,
    production: false,
    quotas: {
      tenantDaily: 1000,
      recipientDaily: 1000,
      recipientCooldownSeconds: 0,
    },
    ...overrides,
  };
}

function services(mailer: Mailer, overrides: Partial<MailConfig> = {}) {
  const cfg = config(overrides);
  const dispatcher = new EmailDispatcher(repo, mailer, cipher, cfg);
  const outbox = new EmailOutbox(repo, cipher, dispatcher, cfg);
  return { dispatcher, outbox };
}

const invitation = (tenantId: string | undefined, referenceId?: string) => ({
  tenantId,
  to: EMAIL,
  template: 'invitation' as const,
  referenceId,
  vars: {
    inviteeName: 'Ana Pérez',
    roleLabel: 'Asistente',
    acceptUrl: `https://outbox-int-a.dentalix.app/invitacion/${TOKEN}`,
    expiresInDays: 7,
  },
});

async function purge(): Promise<void> {
  // Las filas de clínica caen en cascada con su tenant; las de plataforma no
  // tienen tenant, así que se borran aparte (solo las de este spec).
  await owner.emailOutbox.deleteMany({
    where: {
      OR: [
        { tenant: { subdomain: { in: SUBDOMAINS } } },
        { tenantId: null, toMasked: 'an***@clinica-outbox.co' },
      ],
    },
  });
  await owner.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

async function row(id: string) {
  return owner.emailOutbox.findUniqueOrThrow({ where: { id } });
}

describe('DX-088 · email_outbox en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    await prisma.onModuleInit();
    await purge();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({
          data: { name: `Clínica ${subdomain}`, subdomain },
        }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    // Cada caso parte sin pendientes de este spec (un reclamo es global).
    await owner.emailOutbox.updateMany({
      where: { status: { in: ['PENDING', 'SENDING'] } },
      data: { status: 'FAILED', payload: null },
    });
  });

  it('crear → exactamente una fila PENDING, sin el email ni el token en claro, y el despachador la deja SENT con ConsoleMailer', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    const { id } = await outbox.enqueue(invitation(tenantA));
    await dispatcher.whenIdle();

    const rows = await owner.emailOutbox.findMany({
      where: { tenantId: tenantA, id },
    });
    expect(rows).toHaveLength(1);
    const sent = rows[0];
    expect(sent.status).toBe('SENT');
    expect(sent.attempts).toBe(1);
    expect(sent.sentAt).toBeInstanceOf(Date);
    expect(sent.payload).toBeNull();
    expect(sent.template).toBe('INVITATION');
    expect(sent.toMasked).toBe('an***@clinica-outbox.co');
    expect(sent.toHash).toBe(cipher.hashRecipient(EMAIL));

    // Ninguna columna (ni el texto de la fila entera) lleva el email o el token.
    const [{ text }] = await owner.$queryRaw<{ text: string }[]>`
      SELECT to_jsonb(o)::text AS text FROM email_outbox o WHERE o.id = ${id}::uuid`;
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(TOKEN);
  });

  it('mientras está PENDING el mensaje va cifrado (ni email ni token en el bytea)', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy(); // apagado: no despacha
    const { id } = await outbox.enqueue(invitation(tenantA));
    const pending = await row(id);
    expect(pending.status).toBe('PENDING');
    const bytes = Buffer.from(pending.payload ?? new Uint8Array());
    expect(bytes.length).toBeGreaterThan(28);
    expect(bytes.toString('latin1')).not.toContain(EMAIL);
    expect(bytes.toString('latin1')).not.toContain(TOKEN);
    expect(cipher.decrypt(bytes).to).toBe(EMAIL);
  });

  it('RLS: la clínica B no ve ni escribe filas de A, y nadie inserta una fila sin tenant por la tabla', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const { id } = await outbox.enqueue(invitation(tenantA));

    const seenByB = await prisma.runWithTenant(tenantB, (tx) =>
      tx.emailOutbox.findMany({ where: { id } }),
    );
    expect(seenByB).toEqual([]);
    expect(await repo.supersedePending(tenantB, id, 'invitation')).toBe(0);
    const seenByA = await prisma.runWithTenant(tenantA, (tx) =>
      tx.emailOutbox.findMany({ where: { id } }),
    );
    expect(seenByA).toHaveLength(1);

    await expect(
      prisma.runWithTenant(tenantA, (tx) =>
        tx.emailOutbox.create({
          data: {
            tenantId: tenantB,
            template: 'INVITATION',
            toHash: 'a'.repeat(64),
            toMasked: 'x***@y.co',
            payload: new Uint8Array([1]),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      prisma.runWithTenant(tenantA, (tx) =>
        tx.emailOutbox.create({
          data: {
            tenantId: null,
            template: 'INVITATION',
            toHash: 'a'.repeat(64),
            toMasked: 'x***@y.co',
            payload: new Uint8Array([1]),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('CHECK: una fila SENT o FAILED no puede conservar el mensaje', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const { id } = await outbox.enqueue(invitation(tenantA));
    await expect(
      owner.emailOutbox.update({ where: { id }, data: { status: 'SENT' } }),
    ).rejects.toThrow(/email_outbox_payload_cleared_check/);
  });

  it('reclamar usa FOR UPDATE SKIP LOCKED: salta las filas bloqueadas y dos reclamos nunca comparten fila', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        (await outbox.enqueue(invitation(i % 2 ? tenantA : tenantB))).id,
      );
    }

    // Otra "réplica" tiene bloqueada la primera fila en una transacción abierta.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM email_outbox WHERE id = ${ids[0]}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;

    const [first, second] = await Promise.all([
      repo.claimDue(3, 300),
      repo.claimDue(3, 300),
    ]);
    release();
    await holder;

    const claimed = [...first, ...second].map((c) => c.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed).not.toContain(ids[0]);
    expect(claimed.sort()).toEqual(ids.slice(1).sort());
    expect([...first, ...second].every((c) => c.attempts === 1)).toBe(true);

    const states = await owner.emailOutbox.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    for (const state of states) {
      expect(state.status).toBe(state.id === ids[0] ? 'PENDING' : 'SENDING');
    }
    // Con el arriendo vigente, nadie más puede reclamarlas.
    expect((await repo.claimDue(20, 300)).map((c) => c.id)).toEqual([ids[0]]);
  });

  it('un SENDING con el arriendo vencido (réplica caída) se puede reclamar otra vez', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const { id } = await outbox.enqueue(invitation(tenantA));
    const [claimed] = await repo.claimDue(1, 300);
    expect(claimed.id).toBe(id);
    expect(await repo.claimDue(1, 300)).toEqual([]);
    await owner.emailOutbox.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const [again] = await repo.claimDue(1, 300);
    expect(again).toMatchObject({ id, attempts: 2 });
  });

  it('fallo del proveedor: attempts++, reintentos con backoff y FAILED al 3.º, sin el mensaje del proveedor', async () => {
    let calls = 0;
    const failing: Mailer = {
      send: () => {
        calls += 1;
        return Promise.reject(
          Object.assign(new Error(`550 <${EMAIL}> user unknown`), {
            responseCode: 550,
          }),
        );
      },
    };
    const { outbox, dispatcher } = services(failing, { retryBaseMs: 60_000 });
    const { id } = await outbox.enqueue(invitation(tenantA));
    await dispatcher.whenIdle();

    let current = await row(id);
    expect(current).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'Error 550',
    });
    expect(current.payload).not.toBeNull();
    const delay1 = current.nextAttemptAt.getTime() - Date.now();
    expect(delay1).toBeGreaterThan(50_000);
    expect(delay1).toBeLessThanOrEqual(61_000);

    await owner.emailOutbox.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await dispatcher.dispatchBatch();
    current = await row(id);
    expect(current).toMatchObject({ status: 'PENDING', attempts: 2 });
    const delay2 = current.nextAttemptAt.getTime() - Date.now();
    expect(delay2).toBeGreaterThan(110_000);
    expect(delay2).toBeLessThanOrEqual(121_000);

    await owner.emailOutbox.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await dispatcher.dispatchBatch();
    current = await row(id);
    expect(current).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'Error 550',
      payload: null,
      sentAt: null,
    });
    expect(calls).toBe(3);
  });

  it('email de plataforma (sin tenant): entra por su función, ninguna clínica lo ve y el despachador lo envía', async () => {
    const sent: string[] = [];
    const recording: Mailer = {
      send: (message) => {
        sent.push(message.subject);
        return Promise.resolve();
      },
    };
    const { outbox, dispatcher } = services(recording);
    const { id } = await outbox.enqueue(invitation(undefined));
    await dispatcher.whenIdle();

    const platform = await row(id);
    expect(platform.tenantId).toBeNull();
    expect(platform.status).toBe('SENT');
    expect(sent).toEqual(['Te invitaron a unirte a Dentalix']);
    const seenByA = await prisma.runWithTenant(tenantA, (tx) =>
      tx.emailOutbox.findMany({ where: { id } }),
    );
    expect(seenByA).toEqual([]);
  });

  it('cancelar pendientes de una referencia (reenviar/revocar) solo toca los PENDING de esa clínica', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const referenceId = '7b0c1f1e-1d1a-4f53-9a6f-0d7b2b8e9a10';
    const { id } = await outbox.enqueue(invitation(tenantA, referenceId));
    expect(
      await repo.supersedePending(tenantA, referenceId, 'invitation'),
    ).toBe(1);
    expect(await row(id)).toMatchObject({
      status: 'FAILED',
      lastError: 'Superseded',
      payload: null,
    });
  });

  it('el arriendo se acota a 900 s aunque se pida más (revisión D1)', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const { id } = await outbox.enqueue(invitation(tenantA));
    await repo.claimDue(1, 2_147_483_647);
    const lease = (await row(id)).nextAttemptAt.getTime() - Date.now();
    expect(lease).toBeLessThanOrEqual(901_000);
    expect(lease).toBeGreaterThan(890_000);
  });

  it('settle solo cierra SU intento: el cierre tardío de una réplica no pisa al de la que la reclamó después (fencing)', async () => {
    const { outbox, dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const { id } = await outbox.enqueue(invitation(tenantA));
    const [first] = await repo.claimDue(1, 300);
    await owner.emailOutbox.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const [second] = await repo.claimDue(1, 300);
    expect([first.attempts, second.attempts]).toEqual([1, 2]);

    expect(await repo.settle(id, first.attempts, { status: 'SENT' })).toBe(
      false,
    );
    expect((await row(id)).status).toBe('SENDING');
    expect(await repo.settle(id, second.attempts, { status: 'SENT' })).toBe(
      true,
    );
    expect((await row(id)).status).toBe('SENT');
  });

  it('topes en BD: enfriamiento y máximo diario por destinatario, y máximo diario por clínica', async () => {
    const { dispatcher } = services(new ConsoleMailer());
    await dispatcher.onModuleDestroy();
    const strict = services(new ConsoleMailer(), {
      quotas: {
        tenantDaily: 3,
        recipientDaily: 2,
        recipientCooldownSeconds: 60,
      },
    });
    await strict.dispatcher.onModuleDestroy();
    await owner.emailOutbox.deleteMany({ where: { tenantId: tenantB } });

    await strict.outbox.assertWithinQuota(tenantB, EMAIL);
    await strict.outbox.enqueue(invitation(tenantB));
    await expect(
      strict.outbox.assertWithinQuota(tenantB, EMAIL),
    ).rejects.toThrow(/hace un momento/);
    // Pasado el enfriamiento, el 2.º vale; el 3.º supera el diario del destinatario.
    await owner.emailOutbox.updateMany({
      where: { tenantId: tenantB },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
    await strict.outbox.enqueue(invitation(tenantB));
    await owner.emailOutbox.updateMany({
      where: { tenantId: tenantB },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });
    await expect(
      strict.outbox.assertWithinQuota(tenantB, EMAIL),
    ).rejects.toThrow(/últimas 24 horas/);
    // Otro destinatario sí, hasta el tope de la clínica (3).
    await strict.outbox.enqueue({
      ...invitation(tenantB),
      to: 'otra@clinica-outbox.co',
    });
    await expect(
      strict.outbox.assertWithinQuota(tenantB, 'tercera@clinica-outbox.co'),
    ).rejects.toThrow(/máximo de 3 correos/);
    // La clínica A no comparte cuenta con B (A sin envíos propios).
    await owner.emailOutbox.deleteMany({ where: { tenantId: tenantA } });
    await expect(
      strict.outbox.assertWithinQuota(tenantA, 'nadie@clinica-outbox.co'),
    ).resolves.toBeUndefined();
  });

  it('el despachador puede trabajar: funciones ejecutables por la app y owner que salta la RLS (revisión D4)', async () => {
    expect(await repo.dispatcherAccess()).toEqual({
      executable: true,
      ownerBypassesRls: true,
    });
  });

  it('las funciones del despachador no están abiertas a PUBLIC', async () => {
    const grants = await owner.$queryRaw<{ fn: string; public: boolean }[]>`
      SELECT p.proname AS fn,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
        FROM pg_proc p
       WHERE p.proname LIKE 'email_outbox_%'
       ORDER BY 1`;
    expect(grants).toEqual([
      { fn: 'email_outbox_claim', public: false },
      { fn: 'email_outbox_enqueue_platform', public: false },
      { fn: 'email_outbox_settle', public: false },
    ]);
  });
});
