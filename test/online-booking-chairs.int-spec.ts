import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { ONLINE_BOOKING_CLOCK } from '../src/modules/online-booking/application/use-cases/public-booking.use-cases';
import { ONLINE_BOOKING_MESSAGES } from '../src/modules/online-booking/domain/online-booking-errors';

// DX-583 contra Postgres real: en una sede con sillones, la reserva online
// (1) no ofrece un hueco sin sillón libre, (2) la cita nace con el primer
// sillón libre en el orden de la agenda (regla DX-480) en la MISMA alta, y
// dos reservas del mismo hueco con profesionales distintos y UN sillón libre
// → solo una (la EXCLUDE por sillón arbitra); con dos sillones, las dos, cada
// una en el suyo; (3) aceptar una solicitud desde la bandeja también asigna
// sillón, y sin ninguno libre es un 409 claro sin crear nada.
process.env.RATE_LIMIT_ONLINE_BOOKING_WRITE_LIMIT = '10000';
process.env.RATE_LIMIT_ONLINE_BOOKING_LIMIT = '10000';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
function tuesday(): string {
  const d = new Date(Date.now() + 10 * DAY_MS);
  while (d.getUTCDay() !== 2) d.setTime(d.getTime() + DAY_MS);
  return d.toISOString().slice(0, 10);
}
const DAY = tuesday();

interface Slot {
  start: string;
  end: string;
  providerId: string;
}

describe('Reserva online con sillones contra Postgres (int, DX-583)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let locationId: string;
  let typeId: string;
  let policyId: string;
  let dentistId: string;
  let chair1: string;
  let skewMs = 0;
  let people = 0;

  const server = () => request(app.getHttpServer());

  async function formToken(): Promise<string> {
    const res = await server()
      .get('/api/v1/public/booking')
      .set('X-Tenant-Host', clinic.host)
      .expect(200);
    skewMs += 5000;
    return (res.body as { formToken: string }).formToken;
  }

  async function slots(providerId?: string): Promise<Slot[]> {
    const res = await server()
      .get('/api/v1/public/booking/slots')
      .query({
        locationId,
        appointmentTypeId: typeId,
        patientKind: 'NEW',
        from: DAY,
        days: '1',
        ...(providerId ? { providerId } : {}),
      })
      .set('X-Tenant-Host', clinic.host)
      .expect(200);
    return (res.body as { slots: Slot[] }).slots;
  }

  const person = () => {
    const i = people++;
    return {
      firstName: `Sillon${i}`,
      lastName: 'Carrera',
      birthDate: `1981-02-${String(10 + i).padStart(2, '0')}`,
      email: `sillon${i}@example.com`,
      phone: `0414555${String(1000 + i)}`,
      consentPolicyVersionId: policyId,
      consentAccepted: true,
    };
  };

  function book(start: string, providerId: string, token: string) {
    return server()
      .post('/api/v1/public/booking')
      .set('X-Tenant-Host', clinic.host)
      .send({
        locationId,
        appointmentTypeId: typeId,
        providerId,
        start,
        newPatient: person(),
        formToken: token,
      });
  }

  /** Una cita ajena (otro profesional y paciente) que ocupa el sillón. */
  async function occupy(chairId: string, start: string, end: string) {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Ocupa',
        lastName: 'Sillón',
      },
    });
    return raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId: patient.id,
        providerId: randomUUID(),
        chairId,
        start: new Date(start),
        end: new Date(end),
      },
    });
  }

  /**
   * Un inicio que se ofrece a los dos profesionales y sin ninguna cita a esa
   * hora (cada test, independiente de quién ganó la carrera anterior).
   */
  async function freshSlot(): Promise<Slot> {
    const ownerStarts = new Set(
      (await slots(clinic.adminUserId)).map((s) => s.start),
    );
    for (const slot of await slots(dentistId)) {
      if (!ownerStarts.has(slot.start)) continue;
      const taken = await raw.appointment.count({
        where: {
          tenantId: clinic.tenantId,
          start: { lt: new Date(slot.end) },
          end: { gt: new Date(slot.start) },
        },
      });
      if (taken === 0) return slot;
    }
    throw new Error('sin hueco libre para la prueba');
  }

  const at = (start: string) =>
    raw.appointment.findMany({
      where: {
        tenantId: clinic.tenantId,
        start: new Date(start),
        deletedAt: null,
        origin: 'ONLINE',
      },
      select: { chairId: true, providerId: true },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder
          .overrideProvider(ONLINE_BOOKING_CLOCK)
          .useValue(() => new Date(Date.now() + skewMs));
      },
    });
    clinic = await registerClinic(app, 'dx583-sillon');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    typeId = (
      await raw.appointmentType.create({
        data: {
          tenantId: clinic.tenantId,
          name: 'Valoración',
          durationMinutes: 30,
          color: '#0E7490',
        },
      })
    ).id;
    await raw.appointmentTypeOnlineSettings.create({
      data: {
        tenantId: clinic.tenantId,
        appointmentTypeId: typeId,
        visibleOnline: true,
      },
    });
    await raw.onlineBookingSettings.create({
      data: {
        tenantId: clinic.tenantId,
        enabled: true,
        newPatientMode: 'DIRECT',
        existingPatientMode: 'DIRECT',
        minLeadMinutesNew: 0,
        minLeadMinutesExisting: 0,
        slotStepMinutes: 30,
      },
    });
    policyId = (
      await raw.privacyPolicyVersion.create({
        data: {
          tenantId: clinic.tenantId,
          version: 1,
          policyText: 'p',
          generalText: 'g',
          sensitiveHealthText: 's',
          marketingText: 'm',
          contentHash: 'h',
          publishedById: clinic.adminUserId,
        },
      })
    ).id;
    dentistId = (await seedMember(raw, clinic, ClinicRole.DENTIST)).userId;
    chair1 = (
      await raw.chair.create({
        data: {
          tenantId: clinic.tenantId,
          locationId,
          name: 'Sillón 1',
          sortOrder: 0,
        },
      })
    ).id;
    // Un sillón desactivado nunca cuenta como libre.
    await raw.chair.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        name: 'Sillón viejo',
        sortOrder: 5,
        active: false,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('un solo sillón libre y dos reservas del mismo hueco con profesionales distintos: solo una, con el sillón', async () => {
    const [slot] = await slots(dentistId);
    // Los dos profesionales tienen el hueco libre.
    expect((await slots(clinic.adminUserId)).map((s) => s.start)).toContain(
      slot.start,
    );
    const token = await formToken();
    const results = await Promise.all([
      book(slot.start, clinic.adminUserId, token),
      book(slot.start, dentistId, token),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect((loser.body as { code: string }).code).toBe('ONLINE_SLOT_TAKEN');
    // La página pública no habla del sillón.
    expect(JSON.stringify(loser.body)).not.toMatch(/sill[oó]n|chair/i);
    expect(await at(slot.start)).toEqual([
      expect.objectContaining({ chairId: chair1 }),
    ]);
    // Y ya no se ofrece a ninguno de los dos: el profesional libre no basta.
    expect((await slots(dentistId)).map((s) => s.start)).not.toContain(
      slot.start,
    );
    expect((await slots(clinic.adminUserId)).map((s) => s.start)).not.toContain(
      slot.start,
    );
  });

  it('con dos sillones libres, las dos reservas a la vez entran, cada una en su sillón', async () => {
    const chair2 = (
      await raw.chair.create({
        data: {
          tenantId: clinic.tenantId,
          locationId,
          name: 'Sillón 2',
          sortOrder: 1,
        },
      })
    ).id;
    const slot = await freshSlot();
    const token = await formToken();
    const results = await Promise.all([
      book(slot.start, clinic.adminUserId, token),
      book(slot.start, dentistId, token),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const chairs = (await at(slot.start)).map((a) => a.chairId).sort();
    expect(chairs).toEqual([chair1, chair2].sort());
  });

  it('aceptar una solicitud desde la bandeja asigna sillón; sin ninguno libre, 409 claro y nada creado', async () => {
    await raw.onlineBookingSettings.update({
      where: { tenantId: clinic.tenantId },
      data: { newPatientMode: 'REQUEST' },
    });
    const slot = await freshSlot();
    const requested = await book(slot.start, dentistId, await formToken());
    expect(requested.status).toBe(201);
    expect((requested.body as { status: string }).status).toBe('REQUESTED');
    const pending = await raw.onlineBookingRequest.findFirstOrThrow({
      where: {
        tenantId: clinic.tenantId,
        status: 'PENDING',
        start: new Date(slot.start),
      },
    });

    // Entre medias, recepción llena los dos sillones activos a esa hora.
    const activeChairs = await raw.chair.findMany({
      where: { tenantId: clinic.tenantId, locationId, active: true },
      orderBy: { sortOrder: 'asc' },
    });
    const occupants = [];
    for (const c of activeChairs) {
      occupants.push(await occupy(c.id, slot.start, slot.end));
    }
    const accept = () =>
      server()
        .post(`/api/v1/online-booking/requests/${pending.id}/accept`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .send({});
    const full = await accept().expect(409);
    expect((full.body as { message: string }).message).toBe(
      ONLINE_BOOKING_MESSAGES.noFreeChair,
    );
    expect(await at(slot.start)).toEqual([]);
    expect(
      (
        await raw.onlineBookingRequest.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).status,
    ).toBe('PENDING');

    // Se libera el segundo: la cita nace en él.
    await raw.appointment.delete({ where: { id: occupants[1].id } });
    await accept().expect(200);
    expect(await at(slot.start)).toEqual([
      expect.objectContaining({ chairId: activeChairs[1].id }),
    ]);
  });

  it('sede sin sillones activos: se ofrece y se reserva como antes, sin sillón', async () => {
    await raw.onlineBookingSettings.update({
      where: { tenantId: clinic.tenantId },
      data: { newPatientMode: 'DIRECT' },
    });
    await raw.chair.updateMany({
      where: { tenantId: clinic.tenantId },
      data: { active: false },
    });
    const slot = await freshSlot();
    await book(slot.start, dentistId, await formToken()).expect(201);
    expect(await at(slot.start)).toEqual([
      expect.objectContaining({ chairId: null }),
    ]);
  });
});
