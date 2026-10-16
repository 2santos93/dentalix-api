import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { OutboundMessages } from '../src/modules/notifications/outbound/application/outbound-messages.service';

// DX-085, capa de BD: outbound_messages (RLS FORCE por clínica, FK compuesta a
// la cita del MISMO tenant, solo destinatario enmascarado) y que el log del
// servicio nunca lleve el destinatario real.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const messages = new OutboundMessages(prisma);

const SUBDOMAINS = ['dx085-out-a', 'dx085-out-b'];
const EMAIL = 'ana.perez@clinica-outbound.co';

interface Clinic {
  tenantId: string;
  appointmentId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Pérez' },
  });
  const start = new Date(Date.now() + 7 * 86_400_000);
  const appointment = await raw.appointment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      providerId: randomUUID(),
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  });
  return { tenantId: tenant.id, appointmentId: appointment.id };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.outboundMessage.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('DX-085 · outbound_messages (int)', () => {
  let a: Clinic;
  let b: Clinic;
  const logged: string[] = [];
  const capture = (msg: unknown) => {
    logged.push(JSON.stringify(msg));
  };

  beforeAll(async () => {
    Logger.overrideLogger({
      log: capture,
      warn: capture,
      error: capture,
      debug: capture,
      verbose: capture,
    });
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
    await raw.$disconnect();
    Logger.overrideLogger(true);
  });

  it('registra un mensaje bajo el tenant del contexto, enmascarado, y sigue su estado', async () => {
    const { id } = await tenantContext.run(a.tenantId, () =>
      messages.record({
        channel: 'EMAIL',
        template: 'appointment-reminder',
        recipient: EMAIL,
        appointmentId: a.appointmentId,
      }),
    );
    expect(
      await raw.outboundMessage.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      tenantId: a.tenantId,
      channel: 'EMAIL',
      template: 'appointment-reminder',
      recipientMasked: 'an***@clinica-outbound.co',
      status: 'PENDING',
      attempts: 0,
      appointmentId: a.appointmentId,
    });

    await tenantContext.run(a.tenantId, async () => {
      expect(await messages.settle(id, { status: 'QUEUED' })).toBe(true);
      expect(
        await messages.settle(id, {
          status: 'FAILED',
          error: Object.assign(new Error(`550 ${EMAIL} unknown`), {
            code: 'EENVELOPE',
          }),
        }),
      ).toBe(true);
    });
    expect(
      await raw.outboundMessage.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'Error EENVELOPE',
      sentAt: null,
    });

    // Ni la tabla ni el log llevan el destinatario real ni el mensaje del error.
    expect(logged.join('\n')).not.toContain(EMAIL);
    expect(logged.join('\n')).toContain('an***@clinica-outbound.co');
  });

  it('SENT fija sentAt y suma el intento', async () => {
    const { id } = await tenantContext.run(a.tenantId, () =>
      messages.record({
        channel: 'WHATSAPP_LINK',
        template: 'appointment-reminder',
        recipient: '+57 300 123 4567',
      }),
    );
    await tenantContext.run(a.tenantId, () =>
      messages.settle(id, { status: 'SENT' }),
    );
    const row = await raw.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      recipientMasked: '+57***4567',
      status: 'SENT',
      attempts: 1,
    });
    expect(row.sentAt).toBeInstanceOf(Date);
  });

  it('un estado final no cambia (SENT no pasa a FAILED: el CHECK de sentAt no salta)', async () => {
    const { id } = await tenantContext.run(a.tenantId, () =>
      messages.record({
        channel: 'SMS',
        template: 'x',
        recipient: '3001234567',
      }),
    );
    await tenantContext.run(a.tenantId, async () => {
      expect(await messages.settle(id, { status: 'SENT' })).toBe(true);
      expect(
        await messages.settle(id, { status: 'FAILED', error: new Error('x') }),
      ).toBe(false);
      expect(await messages.settle(id, { status: 'QUEUED' })).toBe(false);
    });
    expect(
      await raw.outboundMessage.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: 'SENT', attempts: 1, lastError: null });
  });

  it('RLS: otra clínica ni lo ve ni lo cambia', async () => {
    const { id } = await tenantContext.run(a.tenantId, () =>
      messages.record({
        channel: 'SMS',
        template: 'x',
        recipient: '3001234567',
      }),
    );
    const seenByB = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.outboundMessage.findMany({ where: { id } }),
    );
    expect(seenByB).toEqual([]);
    expect(
      await tenantContext.run(b.tenantId, () =>
        messages.settle(id, { status: 'CANCELLED' }),
      ),
    ).toBe(false);
    expect(
      (await raw.outboundMessage.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('PENDING');
  });

  it('FK compuesta: no se puede ligar a una cita de otra clínica', async () => {
    await expect(
      tenantContext.run(a.tenantId, () =>
        messages.record({
          channel: 'EMAIL',
          template: 'appointment-reminder',
          recipient: EMAIL,
          appointmentId: b.appointmentId,
        }),
      ),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('la BD rechaza un destinatario sin enmascarar y una plantilla rara (CHECK)', async () => {
    for (const data of [
      { recipientMasked: EMAIL, template: 'appointment-reminder' },
      { recipientMasked: 'an***@x.co', template: 'Plantilla Libre' },
    ]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.outboundMessage.create({
            data: { tenantId: a.tenantId, channel: 'EMAIL', ...data },
          }),
        ),
      ).rejects.toThrow(/check constraint|violates/i);
    }
  });

  it('sin tenant en el contexto no registra nada', async () => {
    await expect(
      messages.record({ channel: 'EMAIL', template: 'x', recipient: EMAIL }),
    ).rejects.toThrow(/tenant/i);
  });
});
