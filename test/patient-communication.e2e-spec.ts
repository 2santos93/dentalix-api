import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCommunicationRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient-communication.repository';
import { PATIENT_COMMUNICATION_REPOSITORY } from '../src/modules/patients/domain/ports/patient-communication-repository.port';
import { COMMUNICATION_CLOCK } from '../src/modules/patients/application/use-cases/patient-communication.use-cases';
import { ReminderClock } from '../src/modules/reminders/application/reminder-clock';
import { hashConfirmationToken } from '../src/modules/appointment-confirmations/application/confirmation-token';
import { deferred } from './support/wait-for';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-128 en HTTP real: bloque «Comunicaciones» de la ficha. Lo ven los 4
// roles; lo cambian recepción y ADMIN (403 en español para el resto); un
// móvil inválido no puede ser canal WhatsApp (400 en español); el cambio de
// canal y de opt-in queda en la auditoría con autor y origen.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const FORBIDDEN =
  'Solo recepción o un administrador pueden cambiar el canal de comunicación del paciente.';
const NEEDS_MOBILE =
  'Para elegir WhatsApp el paciente necesita un móvil válido. Revisa el número (si es de otro país, escríbelo con + y su indicativo).';

interface CommunicationBody {
  patientId: string;
  contactChannel: string;
  clinicDefaultChannel: string;
  phone: string | null;
  phoneE164: string | null;
  phoneStatus: string;
  phoneCountry: string | null;
  email: string | null;
  whatsappOptIn: {
    at: string;
    source: string;
    recordedBy: { id: string; fullName: string | null } | null;
  } | null;
  reminderOptOut: { at: string; source: string } | null;
  recipient: {
    kind: string;
    name: string | null;
    email?: string | null;
    minor: boolean;
    responsiblePartyId?: string | null;
  };
}

describe('Comunicaciones del paciente (e2e, DX-128)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  const users = {} as Record<ClinicRole, string>;
  let patientId: string;
  let communicationNow: Date | null = null;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const comms = (id = patientId) => `/api/v1/patients/${id}/communication`;

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(COMMUNICATION_CLOCK)
          .useValue(() => communicationNow ?? new Date()),
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx128-comms');
    other = await registerClinic(app, 'dx128-comms-otra');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    users[ClinicRole.ADMIN] = clinic.adminUserId;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      users[role] = member.userId;
    }
    const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName: 'Carolina',
        lastName: 'Duque',
        docType: 'CC',
        docNumber: '128001',
        sex: 'F',
        email: 'carolina@example.com',
        phone: '601 234 5678',
      })
      .expect(201);
    patientId = (res.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('un paciente nuevo nace con el canal de la clínica, sin opt-in ni baja (y lo trae la ficha)', async () => {
    const patient = await as(
      api().get(`/api/v1/patients/${patientId}`),
      tokens[ClinicRole.RECEPTION],
    ).expect(200);
    expect(patient.body).toMatchObject({
      contactChannel: 'EMAIL',
      whatsappOptInAt: null,
      reminderOptOutAt: null,
    });
    const res = await as(api().get(comms()), tokens[ClinicRole.DENTIST]).expect(
      200,
    );
    expect(res.body).toEqual({
      patientId,
      contactChannel: 'EMAIL',
      clinicDefaultChannel: 'EMAIL',
      phone: '601 234 5678',
      phoneE164: null,
      phoneStatus: 'INVALID',
      phoneCountry: 'CO',
      email: 'carolina@example.com',
      whatsappOptIn: null,
      reminderOptOut: null,
      recipient: {
        kind: 'PATIENT',
        name: 'Carolina',
        email: 'carolina@example.com',
        minor: false,
        responsiblePartyId: null,
      },
    } satisfies CommunicationBody);
  });

  it('un menor: los avisos van a su responsable (DX-203)', async () => {
    const minor = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName: 'Mateo',
        lastName: 'Duque',
        docType: 'TI',
        docNumber: '128002',
        sex: 'M',
        birthDate: '2016-04-10',
      })
      .expect(201);
    const minorId = (minor.body as { id: string }).id;
    const party = await as(
      api().post(`/api/v1/patients/${minorId}/responsible-parties`),
      tokens[ClinicRole.RECEPTION],
    )
      .send({
        fullName: 'Carolina Duque',
        email: 'carolina.duque@example.com',
        relationship: 'MOTHER',
      })
      .expect(201);
    const res = await as(
      api().get(comms(minorId)),
      tokens[ClinicRole.RECEPTION],
    ).expect(200);
    expect((res.body as CommunicationBody).recipient).toEqual({
      kind: 'RESPONSIBLE',
      name: 'Carolina',
      email: 'carolina.duque@example.com',
      minor: true,
      responsiblePartyId: (party.body as { id: string }).id,
    });
  });

  it('un móvil inválido no se puede marcar como canal WhatsApp: 400 en español y nada cambia', async () => {
    const res = await as(api().patch(comms()), tokens[ClinicRole.RECEPTION])
      .send({ contactChannel: 'WHATSAPP' })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'WHATSAPP_REQUIRES_VALID_MOBILE',
      message: NEEDS_MOBILE,
    });
    const row = await raw.patient.findUniqueOrThrow({
      where: { id: patientId },
    });
    expect(row.contactChannel).toBe('EMAIL');
  });

  it.each([
    [{ contactChannel: 'SMS' }, 'El canal debe ser email, WhatsApp o ninguno.'],
    [
      { whatsappOptIn: 'si' },
      'Indica si el paciente acepta WhatsApp (sí o no).',
    ],
    [
      { whatsappOptIn: true, whatsappOptInSource: 'TELEPATIA' },
      'El origen del opt-in debe ser en persona, enlace o mensaje.',
    ],
    [{ phone: 'x'.repeat(41) }, 'El móvil admite como máximo 40 caracteres.'],
  ])('valida %j en español (400)', async (body, message) => {
    const res = await as(api().patch(comms()), clinic.adminToken)
      .send(body)
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('recepción pone el móvil, WhatsApp y el opt-in en persona: E.164 y auditado con autor y origen', async () => {
    const res = await as(api().patch(comms()), tokens[ClinicRole.RECEPTION])
      .send({
        phone: '310 123 4567',
        contactChannel: 'WHATSAPP',
        whatsappOptIn: true,
        whatsappOptInSource: 'IN_PERSON',
      })
      .expect(200);
    const body = res.body as CommunicationBody;
    expect(body).toMatchObject({
      contactChannel: 'WHATSAPP',
      phone: '+573101234567',
      phoneE164: '+573101234567',
      phoneStatus: 'VALID',
      whatsappOptIn: {
        source: 'IN_PERSON',
        recordedBy: {
          id: users[ClinicRole.RECEPTION],
          fullName: 'Miembro RECEPTION',
        },
      },
    });

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        patientId,
        action: 'UPDATE',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: users[ClinicRole.RECEPTION],
      actorRole: 'RECEPTION',
      resourceType: 'PATIENT',
      resourceId: patientId,
      metadata: {
        reason: 'COMMUNICATION_PREFERENCES_CHANGED',
        origin: 'IN_PERSON',
        changedFields: ['contactChannel', 'phone', 'whatsappOptIn'],
      },
    });

    // ADMIN lo ve en el registro de auditoría con el origen.
    const log = await as(
      api().get(`/api/v1/audit-events?patientId=${patientId}`),
      clinic.adminToken,
    ).expect(200);
    const items = (log.body as { items: { metadata: { origin?: string } }[] })
      .items;
    expect(items.some((e) => e.metadata.origin === 'IN_PERSON')).toBe(true);
  });

  it('con canal WhatsApp, la edición general tampoco deja un móvil inválido', async () => {
    const res = await as(
      api().patch(`/api/v1/patients/${patientId}`),
      tokens[ClinicRole.DENTIST],
    )
      .send({ phone: '123' })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(NEEDS_MOBILE);
    await as(
      api().patch(`/api/v1/patients/${patientId}`),
      tokens[ClinicRole.DENTIST],
    )
      .send({ phone: '320 765 4321' })
      .expect(200);
  });

  it('ADMIN anota la baja de recordatorios (origen STAFF) y la quita', async () => {
    const on = await as(api().patch(comms()), clinic.adminToken)
      .send({ reminderOptOut: true })
      .expect(200);
    expect((on.body as CommunicationBody).reminderOptOut).toMatchObject({
      source: 'STAFF',
    });
    const off = await as(api().patch(comms()), clinic.adminToken)
      .send({ reminderOptOut: false })
      .expect(200);
    expect((off.body as CommunicationBody).reminderOptOut).toBeNull();
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        patientId,
        actorUserId: clinic.adminUserId,
        action: 'UPDATE',
      },
    });
    expect(events.map((e) => e.metadata)).toEqual([
      expect.objectContaining({
        changedFields: ['reminderOptOutAt'],
        origin: 'STAFF',
      }),
      expect.objectContaining({
        changedFields: ['reminderOptOutAt'],
        origin: 'STAFF',
      }),
    ]);
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
    '%s lo ve en solo lectura: 403 en español al cambiarlo',
    async (role) => {
      await as(api().get(comms()), tokens[role]).expect(200);
      const res = await as(api().patch(comms()), tokens[role])
        .send({ contactChannel: 'NONE' })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(FORBIDDEN);
      const row = await raw.patient.findUniqueOrThrow({
        where: { id: patientId },
      });
      expect(row.contactChannel).toBe('WHATSAPP');
    },
  );

  it('un paciente de otra clínica da 404 y un id mal formado 400, en español', async () => {
    const res = await as(
      api().get(comms()),
      other.adminToken,
      other.host,
    ).expect(404);
    expect((res.body as { message: string }).message).toBe(
      'Paciente no encontrado',
    );
    await as(api().patch(comms()), other.adminToken, other.host)
      .send({ contactChannel: 'NONE' })
      .expect(404);
    const bad = await as(
      api().get('/api/v1/patients/no-es-uuid/communication'),
      clinic.adminToken,
    ).expect(400);
    expect((bad.body as { message: string }).message).toBe(
      'El identificador del paciente no es válido.',
    );
  });
  it('reactivación auditada bajo lock tras bajaLINK concurrente; preserva otros campos y no inventa eventos sin cambio', async () => {
    const created = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName: 'Fixture',
        lastName: 'Race',
        docType: 'CC',
        docNumber: '214990',
        sex: 'F',
        phone: '+573101234567',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    const linkAt = new Date('2026-10-24T10:00:00.000Z');
    const staffAt = new Date('2026-10-24T10:00:02.000Z');
    const token = 'H'.repeat(43);
    const unusedToken = 'J'.repeat(43);
    for (const value of [token, unusedToken])
      await raw.reminderOptOutLink.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: id,
          tokenHash: hashConfirmationToken(value),
          expiresAt: new Date(linkAt.getTime() + 86400000),
        },
      });
    const reachedTx = deferred();
    const resumeTx = deferred();
    const prisma = app.get(PrismaService);
    const repo = app.get<PrismaPatientCommunicationRepository>(
      PATIENT_COMMUNICATION_REPOSITORY,
    );
    const gatedPrisma = new Proxy(prisma, {
      get(target, key) {
        if (key === 'runWithTenant')
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.runWithTenant(
              async (tx) => {
                reachedTx.resolve();
                await resumeTx.promise;
                return fn(tx);
              },
              { timeout: 15000 },
            );
        const value: unknown = Reflect.get(target, key);
        return value;
      },
    });
    const gatedRepo = new PrismaPatientCommunicationRepository(
      gatedPrisma,
      app.get(TenantContextService),
    );
    const write = jest
      .spyOn(repo, 'update')
      .mockImplementationOnce((...args) => gatedRepo.update(...args));
    const originalFind = repo.find.bind(repo);
    let readActive = false;
    const read = jest
      .spyOn(repo, 'find')
      .mockImplementationOnce(async (patient) => {
        const state = await originalFind(patient);
        readActive = state?.reminderOptOutAt === null;
        return state;
      });
    const reminderClock = jest
      .spyOn(app.get(ReminderClock), 'now')
      .mockReturnValue(linkAt);
    communicationNow = staffAt;
    const requestId = randomUUID();
    const pending = as(api().patch(comms(id)), tokens[ClinicRole.RECEPTION])
      .set('X-Request-ID', requestId)
      .send({ reminderOptOut: false })
      .then((response) => response);
    try {
      await reachedTx.promise;
      expect(readActive).toBe(true);
      // PATCH ya leyóACTIVE y abrióTX, todavía sin bloquear paciente. POST completa y audita.
      await api()
        .post(`/api/v1/public/reminder-opt-outs/${token}`)
        .set('X-Tenant-Host', clinic.host)
        .expect(200);
      expect(
        (await raw.patient.findUniqueOrThrow({ where: { id } }))
          .reminderOptOutAt,
      ).toEqual(linkAt);
      const edited = await as(
        api().patch(comms(id)),
        tokens[ClinicRole.RECEPTION],
      )
        .send({
          phone: '+573209876543',
          contactChannel: 'WHATSAPP',
          whatsappOptIn: true,
          whatsappOptInSource: 'MESSAGE',
        })
        .expect(200);
      expect((edited.body as CommunicationBody).whatsappOptIn?.at).toBe(
        staffAt.toISOString(),
      );
      resumeTx.resolve();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        reminderOptOut: null,
        phone: '+573209876543',
        contactChannel: 'WHATSAPP',
        whatsappOptIn: { at: staffAt.toISOString(), source: 'MESSAGE' },
      });
      const staffEvent = await raw.auditEvent.findFirst({
        where: {
          tenantId: clinic.tenantId,
          patientId: id,
          requestId,
          action: 'UPDATE',
        },
      });
      expect(staffEvent).toMatchObject({
        actorUserId: users[ClinicRole.RECEPTION],
        actorRole: 'RECEPTION',
        metadata: {
          reason: 'COMMUNICATION_PREFERENCES_CHANGED',
          origin: 'STAFF',
          changedFields: ['reminderOptOutAt'],
        },
      });
      const linkEvent = await raw.auditEvent.findFirst({
        where: {
          patientId: id,
          metadata: { path: ['origin'], equals: 'LINK' },
        },
      });
      expect(linkEvent).toMatchObject({
        actorUserId: null,
        actorRole: null,
        metadata: { reason: 'REMINDER_OPT_OUT', origin: 'LINK' },
      });
      expect(
        (
          await raw.reminderOptOutLink.findUniqueOrThrow({
            where: { tokenHash: hashConfirmationToken(unusedToken) },
          })
        ).usedAt,
      ).toEqual(staffAt);
      expect(
        (
          await raw.reminderOptOutLink.findUniqueOrThrow({
            where: { tokenHash: hashConfirmationToken(token) },
          })
        ).usedAt,
      ).toEqual(linkAt);
      const beforeNoop = await raw.patient.findUniqueOrThrow({ where: { id } });
      const eventCount = await raw.auditEvent.count({
        where: { patientId: id, action: 'UPDATE' },
      });
      await raw.reminderOptOutLink.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: id,
          tokenHash: hashConfirmationToken('K'.repeat(43)),
          expiresAt: new Date(linkAt.getTime() + 86400000),
        },
      });
      await as(api().patch(comms(id)), tokens[ClinicRole.RECEPTION])
        .send({ reminderOptOut: false })
        .expect(200);
      expect(
        await raw.auditEvent.count({
          where: { patientId: id, action: 'UPDATE' },
        }),
      ).toBe(eventCount);
      expect(await raw.patient.findUniqueOrThrow({ where: { id } })).toEqual(
        beforeNoop,
      );
      expect(
        (
          await raw.reminderOptOutLink.findUniqueOrThrow({
            where: { tokenHash: hashConfirmationToken('K'.repeat(43)) },
          })
        ).usedAt,
      ).toEqual(staffAt);
    } finally {
      resumeTx.resolve();
      await pending;
      write.mockRestore();
      read.mockRestore();
      reminderClock.mockRestore();
      communicationNow = null;
    }
  });
});
