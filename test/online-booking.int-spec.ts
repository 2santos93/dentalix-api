import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { ONLINE_BOOKING_CLOCK } from '../src/modules/online-booking/application/use-cases/public-booking.use-cases';
import { OnlineSlotService } from '../src/modules/online-booking/application/online-slot.service';
import * as bookingSecurity from '../src/modules/online-booking/domain/booking-security';

// DX-016 contra Postgres real: (1) dos (o más) reservas del MISMO hueco a la
// vez → solo una lo consigue, la BD lo arbitra (EXCLUDE por profesional) y
// las demás reciben un 409 claro; (2) la lectura vieja del hueco (el otro
// escribió entre medias) también es 409, nunca un 500 ni una doble cita;
// (3) RLS FORCE en las cuatro tablas nuevas; (4) la clínica sale SOLO del
// host, nunca de un parámetro.
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

describe('Reserva online contra Postgres (int, DX-016)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let locationA: string;
  let typeA: string;
  let policyA: string;
  let skewMs = 0;

  const server = () => request(app.getHttpServer());

  async function setUp(
    clinic: Clinic,
  ): Promise<{ location: string; type: string; policy: string }> {
    const location = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    const type = (
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
        appointmentTypeId: type,
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
    const policy = (
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
    return { location, type, policy };
  }

  async function formToken(host: string): Promise<string> {
    const res = await server()
      .get('/api/v1/public/booking')
      .set('X-Tenant-Host', host)
      .expect(200);
    skewMs += 5000;
    return (res.body as { formToken: string }).formToken;
  }

  async function slots(): Promise<Slot[]> {
    const res = await server()
      .get('/api/v1/public/booking/slots')
      .query({
        locationId: locationA,
        appointmentTypeId: typeA,
        patientKind: 'NEW',
        from: DAY,
        days: '1',
      })
      .set('X-Tenant-Host', a.host)
      .expect(200);
    return (res.body as { slots: Slot[] }).slots;
  }

  const person = (i: number) => ({
    firstName: `Paciente${i}`,
    lastName: 'Carrera',
    birthDate: `1980-01-${String(10 + i).padStart(2, '0')}`,
    email: `carrera${i}@example.com`,
    phone: `0412555${String(1000 + i)}`,
    consentPolicyVersionId: policyA,
    consentAccepted: true,
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
    a = await registerClinic(app, 'dx016-carrera');
    b = await registerClinic(app, 'dx016-vecina');
    ({ location: locationA, type: typeA, policy: policyA } = await setUp(a));
    await setUp(b);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('seis reservas del mismo hueco a la vez: una cita, cinco 409 claros, sin fichas duplicadas al reintentar', async () => {
    const [slot] = await slots();
    const token = await formToken(a.host);
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        server()
          .post('/api/v1/public/booking')
          .set('X-Tenant-Host', a.host)
          .send({
            locationId: locationA,
            appointmentTypeId: typeA,
            start: slot.start,
            newPatient: person(i),
            formToken: token,
          }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(['ONLINE_SLOT_TAKEN', 'ONLINE_SLOT_GONE']).toContain(
        (r.body as { code: string }).code,
      );
      expect((r.body as { message: string }).message).toMatch(/hueco|hora/);
    }
    expect(
      await raw.appointment.count({
        where: {
          tenantId: a.tenantId,
          start: new Date(slot.start),
          deletedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await raw.onlineBookingRequest.count({
        where: { tenantId: a.tenantId, status: 'BOOKED' },
      }),
    ).toBe(1);

    // Quien perdió la carrera con su ficha ya creada reintenta otro hueco con
    // la sesión de reintento: no se crea otra ficha.
    const loser = results.find(
      (r) =>
        r.status === 409 && (r.body as { sessionToken?: string }).sessionToken,
    );
    if (loser) {
      const patientsBefore = await raw.patient.count({
        where: { tenantId: a.tenantId },
      });
      const free = (await slots())[0];
      await server()
        .post('/api/v1/public/booking')
        .set('X-Tenant-Host', a.host)
        .set(
          'X-Booking-Session',
          (loser.body as { sessionToken: string }).sessionToken,
        )
        .send({
          locationId: locationA,
          appointmentTypeId: typeA,
          start: free.start,
          formToken: await formToken(a.host),
        })
        .expect(201);
      expect(await raw.patient.count({ where: { tenantId: a.tenantId } })).toBe(
        patientsBefore,
      );
    }
  });

  it('lectura vieja del hueco (otro escribió entre medias): 409 ONLINE_SLOT_TAKEN, nunca una segunda cita', async () => {
    const [slot] = await slots();
    const service = app.get(OnlineSlotService);
    const stale = service.slots.bind(service);
    // El primero reserva de verdad.
    await server()
      .post('/api/v1/public/booking')
      .set('X-Tenant-Host', a.host)
      .send({
        locationId: locationA,
        appointmentTypeId: typeA,
        start: slot.start,
        newPatient: person(20),
        formToken: await formToken(a.host),
      })
      .expect(201);
    // El segundo «vio» el hueco antes: la comprobación de la página pasa,
    // la de agendar (y la EXCLUDE) no.
    const spy = jest
      .spyOn(service, 'slots')
      .mockImplementation(async (...args) => {
        const result = await stale(...args);
        return {
          ...result,
          slots: [
            {
              start: new Date(slot.start),
              end: new Date(slot.end),
              providerId: slot.providerId,
            },
          ],
        };
      });
    try {
      const res = await server()
        .post('/api/v1/public/booking')
        .set('X-Tenant-Host', a.host)
        .send({
          locationId: locationA,
          appointmentTypeId: typeA,
          start: slot.start,
          newPatient: person(21),
          formToken: await formToken(a.host),
        })
        .expect(409);
      expect((res.body as { code: string }).code).toBe('ONLINE_SLOT_TAKEN');
      expect((res.body as { sessionToken?: string }).sessionToken).toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      await raw.appointment.count({
        where: {
          tenantId: a.tenantId,
          start: new Date(slot.start),
          deletedAt: null,
        },
      }),
    ).toBe(1);
  });

  it('verificar el código: con 12 intentos a la vez nunca hay más de 5 comparaciones, y queda bloqueado', async () => {
    const patient = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Rosa',
        lastName: 'Paralela',
        birthDate: new Date('1985-03-02T00:00:00Z'),
        email: 'rosa.paralela@example.com',
      },
    });
    const sent = await server()
      .post('/api/v1/public/booking/verification')
      .set('X-Tenant-Host', a.host)
      .send({
        firstName: 'Rosa',
        lastName: 'Paralela',
        birthDate: '1985-03-02',
        email: 'rosa.paralela@example.com',
        formToken: await formToken(a.host),
      })
      .expect(200);
    const { verificationId } = sent.body as { verificationId: string };
    // El código se liga a la ficha tras responder.
    const deadline = Date.now() + 5000;
    while (
      (
        await raw.onlineBookingVerification.findUniqueOrThrow({
          where: { id: verificationId },
        })
      ).patientId !== patient.id
    ) {
      if (Date.now() > deadline) throw new Error('la verificación no se ligó');
      await new Promise((r) => setTimeout(r, 20));
    }
    const compare = jest.spyOn(bookingSecurity, 'bookingCodeMatches');
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          server()
            .post(
              `/api/v1/public/booking/verification/${verificationId}/verify`,
            )
            .set('X-Tenant-Host', a.host)
            .send({ code: '000000' }),
        ),
      );
      expect(compare.mock.calls.length).toBeGreaterThan(0);
      expect(compare.mock.calls.length).toBeLessThanOrEqual(5);
      // Ninguno abre sesión con un código inventado salvo que acierte por azar.
      expect(
        results.filter((r) => r.status === 200).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      compare.mockRestore();
    }
    const row = await raw.onlineBookingVerification.findUniqueOrThrow({
      where: { id: verificationId },
    });
    expect(row.attempts).toBe(5);
    if (!row.verifiedAt) expect(row.lockedAt).not.toBeNull();
  });

  it('RLS FORCE: desde la clínica B no se ve ni se escribe nada de la reserva online de A', async () => {
    const prisma = app.get(PrismaService);
    const seen = await prisma.runWithTenant(b.tenantId, async (tx) => ({
      settings: await tx.onlineBookingSettings.count({
        where: { tenantId: a.tenantId },
      }),
      types: await tx.appointmentTypeOnlineSettings.count({
        where: { tenantId: a.tenantId },
      }),
      requests: await tx.onlineBookingRequest.count({
        where: { tenantId: a.tenantId },
      }),
      verifications: await tx.onlineBookingVerification.count({
        where: { tenantId: a.tenantId },
      }),
    }));
    expect(seen).toEqual({
      settings: 0,
      types: 0,
      requests: 0,
      verifications: 0,
    });
    expect(
      await raw.onlineBookingRequest.count({ where: { tenantId: a.tenantId } }),
    ).toBeGreaterThan(0);
    await expect(
      prisma.runWithTenant(b.tenantId, (tx) =>
        tx.onlineBookingVerification.create({
          data: { tenantId: a.tenantId, patientKind: 'EXISTING' },
        }),
      ),
    ).rejects.toThrow();
    for (const table of [
      'online_booking_settings',
      'appointment_type_online_settings',
      'online_booking_requests',
      'online_booking_verifications',
    ]) {
      const [row] = await raw.$queryRaw<{ rls: boolean; force: boolean }[]>`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS force
          FROM pg_class WHERE relname = ${table}`;
      expect(row).toEqual({ rls: true, force: true });
    }
  });

  it('la clínica sale SOLO del host: los ids de A desde el host de B no existen, y un tenantId en la petición no cuenta', async () => {
    const [slot] = await slots();
    const fromB = await server()
      .post('/api/v1/public/booking')
      .set('X-Tenant-Host', b.host)
      .send({
        locationId: locationA,
        appointmentTypeId: typeA,
        start: slot.start,
        newPatient: person(30),
        formToken: await formToken(b.host),
        tenantId: a.tenantId,
      });
    expect(fromB.status).toBe(404);
    const slotsFromB = await server()
      .get('/api/v1/public/booking/slots')
      .query({
        locationId: locationA,
        appointmentTypeId: typeA,
        patientKind: 'NEW',
        from: DAY,
        days: '1',
        tenantId: a.tenantId,
      })
      .set('X-Tenant-Host', b.host);
    expect(slotsFromB.status).toBe(404);
    // Sin host de clínica no hay reserva.
    await server()
      .get('/api/v1/public/booking')
      .query({ tenantId: a.tenantId })
      .expect(404);
    // El formToken de B no vale en A.
    const tokenB = await formToken(b.host);
    await server()
      .post('/api/v1/public/booking')
      .set('X-Tenant-Host', a.host)
      .send({
        locationId: locationA,
        appointmentTypeId: typeA,
        start: slot.start,
        newPatient: person(31),
        formToken: tokenB,
      })
      .expect(400);
  });
});
