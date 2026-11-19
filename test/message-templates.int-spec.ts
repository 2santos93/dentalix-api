import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { EmailPayloadCipher } from '../src/modules/notifications/email/infrastructure/email-payload-cipher';
import type { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { EmailOutbox } from '../src/modules/notifications/email/application/email-outbox.service';
import type { MailConfig } from '../src/modules/notifications/email/infrastructure/mail-config';
import type { AppointmentReminderEmailVars } from '../src/modules/notifications/email/domain/email-message';
import { PrismaMessageTemplateRepository } from '../src/modules/message-templates/infrastructure/prisma-message-template.repository';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import type { MessageTemplateId } from '../src/modules/message-templates/domain/ports/message-template-repository.port';

// DX-565, capa de BD: message_templates contra Postgres. RLS FORCE por
// clínica (ni se ve ni se escribe la fila de otra), el texto se lee AL
// ENCOLAR (cambiarlo cambia el siguiente email, nunca el ya encolado: el
// payload cifrado guarda el email ya renderizado), cada idioma por separado,
// restablecer vuelve al de siempre, la auditoría va en la misma transacción
// y la prueba de Ajustes, una por persona en la ventana, bajo candado.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const outboxRepo = new PrismaEmailOutboxRepository(prisma);
const templates = new PrismaMessageTemplateRepository(prisma, tenantContext);
const cipher = new EmailPayloadCipher(randomBytes(32));

const SUBDOMAINS = ['dx565-int-a', 'dx565-int-b'];
const USER_EMAIL = 'admin@dx565-int.test';

const config: MailConfig = {
  transport: 'console',
  smtpUrl: null,
  fileDir: null,
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
  platformQuotas: { recipientDaily: 1000, recipientCooldownSeconds: 0 },
};
// Sin despachar: el payload cifrado sigue ahí para leer lo encolado.
const idleDispatcher = { kick: () => undefined } as unknown as EmailDispatcher;
const outbox = new EmailOutbox(outboxRepo, cipher, idleDispatcher, config);

const REMINDER: MessageTemplateId = {
  key: 'appointment-reminder',
  channel: 'EMAIL',
  language: 'es',
};

const vars: AppointmentReminderEmailVars = {
  patientName: 'Ana',
  guardianName: null,
  startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
  locationName: 'Sede Altamira',
  locationAddress: null,
  providerName: 'Dra. Laura Gómez',
  confirmUrl: null,
  unsubscribeUrl: null,
};

describe('DX-565 · message_templates en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let userId: string;
  const ctx = (tenantId: string): AuditRequestContext => ({
    tenantId,
    locationId: null,
    actor: { userId, role: 'ADMIN' },
    requestId: null,
    ip: null,
    userAgent: null,
  });
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantContext.run(tenantId, fn);

  async function purge(): Promise<void> {
    const tenants = await owner.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    await owner.messageTemplate.deleteMany({
      where: { tenantId: { in: ids } },
    });
    await owner.emailOutbox.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
    await owner.user.deleteMany({ where: { email: USER_EMAIL } });
  }

  const payloadOf = async (id: string) => {
    const row = await owner.emailOutbox.findUniqueOrThrow({ where: { id } });
    return cipher.decrypt(Buffer.from(row.payload!));
  };

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
    userId = (
      await owner.user.create({
        data: {
          email: USER_EMAIL,
          passwordHash: 'x',
          fullName: 'Laura Gómez',
          emailVerifiedAt: new Date(),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
    Logger.overrideLogger(true);
  });

  beforeEach(async () => {
    await owner.messageTemplate.deleteMany({
      where: { tenantId: { in: [tenantA, tenantB] } },
    });
  });

  it('RLS FORCE: B no ve el texto de A ni puede escribir una fila con la clínica de A', async () => {
    await inTenant(tenantA, () =>
      templates.save(
        REMINDER,
        { subject: 'De A', body: 'Texto de A' },
        ctx(tenantA),
      ),
    );
    expect(await inTenant(tenantB, () => templates.list())).toEqual([]);
    expect(await inTenant(tenantB, () => templates.find(REMINDER))).toBeNull();
    expect(
      await outboxRepo.findMessageTemplate(tenantB, REMINDER.key, 'es'),
    ).toBeNull();
    await expect(
      prisma.runWithTenant(tenantB, (tx) =>
        tx.messageTemplate.create({
          data: {
            tenantId: tenantA,
            key: 'quote-follow-up',
            channel: 'EMAIL',
            language: 'es',
            subject: 'x',
            body: 'y',
            updatedById: userId,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // Y la fila de A sigue intacta.
    expect(await inTenant(tenantA, () => templates.find(REMINDER))).toEqual({
      subject: 'De A',
      body: 'Texto de A',
    });
  });

  it('los CHECK: email con asunto, WhatsApp sin él, canal e idioma cerrados', async () => {
    const insert = (
      data: Partial<Prisma.MessageTemplateUncheckedCreateInput>,
    ) =>
      owner.messageTemplate.create({
        data: {
          tenantId: tenantA,
          key: 'appointment-reminder',
          channel: 'EMAIL',
          language: 'es',
          subject: 'x',
          body: 'y',
          updatedById: userId,
          ...data,
        },
      });
    await expect(insert({ subject: null })).rejects.toThrow(/subject_check/);
    await expect(
      insert({ key: 'appointment-confirmation', channel: 'WHATSAPP' }),
    ).rejects.toThrow(/subject_check/);
    await expect(insert({ channel: 'SMS' })).rejects.toThrow(/channel_check/);
    await expect(insert({ language: 'fr' })).rejects.toThrow(/language_check/);
    await expect(insert({ body: 'x'.repeat(2001) })).rejects.toThrow(
      /body_check/,
    );
  });

  it('cambiar el recordatorio cambia el siguiente email y nunca el ya encolado', async () => {
    const first = await outbox.enqueue({
      tenantId: tenantA,
      to: 'ana@ejemplo.com',
      template: 'appointment-reminder',
      vars,
    });
    await inTenant(tenantA, () =>
      templates.save(
        REMINDER,
        {
          subject: 'Te esperamos en {clinica}',
          body: 'Hola {paciente}, nuevo texto.',
        },
        ctx(tenantA),
      ),
    );
    const second = await outbox.enqueue({
      tenantId: tenantA,
      to: 'ana@ejemplo.com',
      template: 'appointment-reminder',
      vars,
    });
    const before = await payloadOf(first.id);
    const after = await payloadOf(second.id);
    expect(before.subject).toBe(
      'Recordatorio de tu cita en Clínica dx565-int-a',
    );
    expect(before.text).toContain('Te recordamos tu cita');
    expect(before.text).not.toContain('nuevo texto');
    expect(after.subject).toBe('Te esperamos en Clínica dx565-int-a');
    expect(after.text).toContain('Hola Ana, nuevo texto.');
    expect(after.text).not.toContain('Te recordamos tu cita');
    // La otra clínica sigue con el de siempre.
    const other = await outbox.enqueue({
      tenantId: tenantB,
      to: 'ana@ejemplo.com',
      template: 'appointment-reminder',
      vars,
    });
    expect((await payloadOf(other.id)).subject).toBe(
      'Recordatorio de tu cita en Clínica dx565-int-b',
    );
  });

  it('cada idioma por separado: el texto en español no cambia el email en inglés', async () => {
    await inTenant(tenantA, () =>
      templates.save(
        REMINDER,
        { subject: 'Solo es', body: 'Solo es.' },
        ctx(tenantA),
      ),
    );
    const en = await outbox.enqueue({
      tenantId: tenantA,
      to: 'ana@ejemplo.com',
      template: 'appointment-reminder',
      locale: 'en',
      vars,
    });
    const email = await payloadOf(en.id);
    expect(email.subject).toBe(
      'Reminder: your appointment at Clínica dx565-int-a',
    );
    expect(email.text).not.toContain('Solo es.');
  });

  it('restablecer: borra la fila con su evento (DELETE) y el siguiente email vuelve al de siempre', async () => {
    await inTenant(tenantA, () =>
      templates.save(
        REMINDER,
        { subject: 'Propio', body: 'Propio.' },
        ctx(tenantA),
      ),
    );
    const events = () =>
      owner.auditEvent.count({
        where: {
          tenantId: tenantA,
          resourceType: 'CLINIC_SETTINGS',
          metadata: { path: ['reason'], equals: 'MESSAGE_TEMPLATE_RESET' },
        },
      });
    const resetBefore = await events();
    expect(
      await inTenant(tenantA, () => templates.reset(REMINDER, ctx(tenantA))),
    ).toBe(true);
    expect(await events()).toBe(resetBefore + 1);
    // Sin fila: no hace nada ni deja evento.
    expect(
      await inTenant(tenantA, () => templates.reset(REMINDER, ctx(tenantA))),
    ).toBe(false);
    expect(await events()).toBe(resetBefore + 1);
    const next = await outbox.enqueue({
      tenantId: tenantA,
      to: 'ana@ejemplo.com',
      template: 'appointment-reminder',
      vars,
    });
    expect((await payloadOf(next.id)).subject).toBe(
      'Recordatorio de tu cita en Clínica dx565-int-a',
    );
  });

  it('la prueba: dos a la vez de la misma persona encolan UNA (candado y ventana de 5 min)', async () => {
    const prepare = () =>
      outbox.prepareInTx({
        tenantId: tenantA,
        to: USER_EMAIL,
        template: 'appointment-reminder',
        vars,
        subjectPrefix: '[Prueba] ',
      });
    const [p1, p2] = await Promise.all([prepare(), prepare()]);
    const now = new Date();
    const results = await inTenant(tenantA, () =>
      Promise.all(
        [p1, p2].map((p) =>
          templates.recordTestSend(p, REMINDER, ctx(tenantA), 300, now),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      ok: false,
      retryAfterSeconds: expect.any(Number) as number,
    });
    const sent = await owner.emailOutbox.findMany({
      where: { tenantId: tenantA, toMasked: 'ad***@dx565-int.test' },
    });
    expect(sent).toHaveLength(1);
    expect((await payloadOf(sent[0].id)).subject).toMatch(/^\[Prueba\] /);
    expect(
      await inTenant(tenantA, () =>
        templates.testCooldownRemaining(userId, 300, new Date()),
      ),
    ).toBeGreaterThan(0);
  });
});
