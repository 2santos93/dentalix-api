import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAppointmentConfirmationRepository } from '../src/modules/appointment-confirmations/infrastructure/repositories/prisma-appointment-confirmation.repository';
import {
  generateConfirmationToken,
  hashConfirmationToken,
} from '../src/modules/appointment-confirmations/application/confirmation-token';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-361 contra Postgres: la emisión del enlace de confirmación (recepción) y
// la respuesta del paciente escriben su evento de auditoría en la MISMA
// transacción, en el tenant de la cita (RLS FORCE), sin token, hash ni URL;
// una respuesta que no se registra no deja evento, y el CHECK de actor solo
// admite sin usuario los tres eventos del paciente.
//
// `owner` (DIRECT_URL) siembra e inspecciona; la app va por PrismaService
// (rol dentalix_app, sujeto a RLS).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaAppointmentConfirmationRepository(prisma, tenantContext);

const HOUR = 3_600_000;

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
    }),
  });
  const user = await owner.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: `Recepción ${subdomain}`,
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'RECEPTION' },
  });
  const patient = await owner.patient.create({
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: 'Int',
      docNumber: randomUUID().slice(0, 12),
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
  };
}

/** Cada cita en su propia hora (sin solapes del mismo profesional). */
let slot = 0;

async function seedAppointment(s: Seeded): Promise<string> {
  slot += 1;
  const start = new Date(Date.now() + (48 + slot) * HOUR);
  const appointment = await owner.appointment.create({
    data: {
      tenantId: s.tenantId,
      locationId: s.locationId,
      patientId: s.patientId,
      providerId: s.userId,
      start,
      end: new Date(start.getTime() + HOUR / 2),
    },
  });
  return appointment.id;
}

function staff(s: Seeded): AuditRequestContext {
  return {
    tenantId: s.tenantId,
    locationId: null,
    actor: { userId: s.userId, role: 'RECEPTION' },
    requestId: 'req-int',
    ip: '10.0.0.1',
    userAgent: 'jest',
  };
}

const asClinic = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, fn);

/** Emite un enlace como recepción (o como el recordatorio, sin `audit`). */
async function issueLink(
  s: Seeded,
  appointmentId: string,
  /** `null` = el recordatorio automático (sin contexto de auditoría). */
  audit: AuditRequestContext | null = staff(s),
): Promise<string> {
  const token = generateConfirmationToken();
  const appointment = await owner.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
  });
  await asClinic(s.tenantId, () =>
    repo.issue({
      appointmentId,
      tokenHash: hashConfirmationToken(token),
      expiresAt: appointment.start,
      appointmentStart: appointment.start,
      appointmentStatus: appointment.status,
      createdById: s.userId,
      keepCallbackRequest: audit === null,
      revokePrevious: audit !== null,
      now: new Date(),
      audit: audit ?? undefined,
    }),
  );
  return token;
}

async function respondWith(
  s: Seeded,
  token: string,
  response: 'CONFIRM' | 'CANCEL' | 'CALL_ME',
) {
  return asClinic(s.tenantId, async () => {
    const lookup = await repo.findByTokenHash(hashConfirmationToken(token));
    if (!lookup) throw new Error('enlace no encontrado');
    return repo.respond({
      confirmationId: lookup.confirmation.id,
      appointmentId: lookup.confirmation.appointmentId,
      response,
      now: new Date(),
      expectedStart: lookup.confirmation.appointmentStart,
      expectedStatus: lookup.confirmation.appointmentStatus,
      request: { requestId: 'req-pac', ip: '10.0.0.9', userAgent: 'móvil' },
    });
  });
}

const eventsOf = (appointmentId: string) =>
  owner.auditEvent.findMany({
    where: { resourceId: appointmentId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });

describe('auditoría de la confirmación de cita por enlace (DX-361, Postgres)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx361-int-a');
    b = await seedClinic('dx361-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  it('recepción genera y reenvía: dos eventos de la cita con su usuario, origen STAFF, sede y paciente de la cita, sin token ni hash', async () => {
    const appointmentId = await seedAppointment(a);

    const first = await issueLink(a, appointmentId);
    const second = await issueLink(a, appointmentId);

    const events = await eventsOf(appointmentId);
    expect(events).toEqual([
      expect.objectContaining({
        tenantId: a.tenantId,
        locationId: a.locationId,
        actorUserId: a.userId,
        actorRole: 'RECEPTION',
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        resourceId: appointmentId,
        patientId: a.patientId,
        requestId: 'req-int',
        metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_CREATED' },
      }),
      expect.objectContaining({
        actorUserId: a.userId,
        metadata: { origin: 'STAFF', reason: 'CONFIRMATION_LINK_RESENT' },
      }),
    ]);
    const text = JSON.stringify(events);
    for (const token of [first, second]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashConfirmationToken(token));
    }
  });

  it('el recordatorio automático (sin contexto de auditoría) no escribe evento', async () => {
    const appointmentId = await seedAppointment(a);
    await issueLink(a, appointmentId, null);
    expect(await eventsOf(appointmentId)).toEqual([]);
  });

  it('el paciente confirma: evento sin usuario, origen LINK, en el tenant de la cita y con su paciente; la otra clínica no lo ve', async () => {
    const appointmentId = await seedAppointment(a);
    const token = await issueLink(a, appointmentId);

    expect(await respondWith(a, token, 'CONFIRM')).toBe('OK');

    const [, event] = await eventsOf(appointmentId);
    expect(event).toEqual(
      expect.objectContaining({
        tenantId: a.tenantId,
        locationId: a.locationId,
        actorUserId: null,
        actorRole: null,
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        resourceId: appointmentId,
        patientId: a.patientId,
        requestId: 'req-pac',
        ip: '10.0.0.9',
        userAgent: 'móvil',
        metadata: {
          origin: 'LINK',
          reason: 'CONFIRMATION_LINK_CONFIRMED',
          status: { from: 'SCHEDULED', to: 'CONFIRMED' },
        },
      }),
    );
    const text = JSON.stringify(event);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashConfirmationToken(token));
    expect(text).not.toContain('/confirmar/');

    expect(
      await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.auditEvent.count({ where: { resourceId: appointmentId } }),
      ),
    ).toBe(0);
    expect(
      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.auditEvent.count({ where: { resourceId: appointmentId } }),
      ),
    ).toBe(2);
  });

  it('cancelar deja el estado y la cancelación por el enlace; «llamarme», solo el motivo', async () => {
    const cancelled = await seedAppointment(a);
    const callMe = await seedAppointment(a);
    const cancelToken = await issueLink(a, cancelled);
    const callToken = await issueLink(a, callMe);

    expect(await respondWith(a, cancelToken, 'CANCEL')).toBe('OK');
    expect(await respondWith(a, callToken, 'CALL_ME')).toBe('OK');

    const [, cancelEvent] = await eventsOf(cancelled);
    expect(cancelEvent.metadata).toEqual({
      origin: 'LINK',
      reason: 'CONFIRMATION_LINK_CANCELLED',
      status: { from: 'SCHEDULED', to: 'CANCELLED' },
      cancellation: {
        byKind: 'PATIENT_LINK',
        reasonCode: null,
        noticeMinutes: expect.any(Number) as number,
        lateCancellation: false,
      },
    });
    const [, callEvent] = await eventsOf(callMe);
    expect(callEvent).toEqual(
      expect.objectContaining({
        actorUserId: null,
        patientId: a.patientId,
        metadata: {
          origin: 'LINK',
          reason: 'CONFIRMATION_LINK_CALL_REQUESTED',
        },
      }),
    );
  });

  it('enlace ya usado, revocado o con la cita cambiada: no se registra respuesta ni evento', async () => {
    const used = await seedAppointment(a);
    const usedToken = await issueLink(a, used);
    await respondWith(a, usedToken, 'CONFIRM');
    expect(await respondWith(a, usedToken, 'CANCEL')).toBe('ALREADY_USED');
    expect(await eventsOf(used)).toHaveLength(2);

    const revoked = await seedAppointment(a);
    const oldToken = await issueLink(a, revoked);
    await issueLink(a, revoked);
    expect(await respondWith(a, oldToken, 'CONFIRM')).toBe('ALREADY_USED');
    expect(
      (await eventsOf(revoked)).filter((e) => e.actorUserId === null),
    ).toEqual([]);

    const moved = await seedAppointment(a);
    const movedToken = await issueLink(a, moved);
    await owner.appointment.update({
      where: { id: moved },
      data: {
        start: new Date(Date.now() + 500 * HOUR),
        end: new Date(Date.now() + 501 * HOUR),
      },
    });
    expect(await respondWith(a, movedToken, 'CONFIRM')).toBe('STALE');
    expect(
      (await eventsOf(moved)).filter((e) => e.actorUserId === null),
    ).toEqual([]);
  });

  it('el CHECK de actor sigue rechazando un evento de cita sin usuario que no es del enlace', async () => {
    const appointmentId = await seedAppointment(a);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","action","resourceType","resourceId","patientId","metadata")
            VALUES (gen_random_uuid(), ${a.tenantId}::uuid, 'UPDATE', 'APPOINTMENT', ${appointmentId}::uuid,
                    ${a.patientId}::uuid, '{"reason":"APPOINTMENT_CANCELLED","origin":"LINK"}'::jsonb)`,
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","action","resourceType","resourceId","patientId","metadata")
            VALUES (gen_random_uuid(), ${a.tenantId}::uuid, 'UPDATE', 'APPOINTMENT', ${appointmentId}::uuid,
                    ${a.patientId}::uuid, '{"reason":"CONFIRMATION_LINK_CONFIRMED","origin":"STAFF"}'::jsonb)`,
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
  });
});
