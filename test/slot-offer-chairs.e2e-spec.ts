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
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  generateSlotOfferToken,
  hashSlotOfferToken,
} from '../src/modules/waitlist/domain/slot-offer-link';

// DX-480 en HTTP real: la cita que nace al aceptar una oferta de hueco por el
// enlace público lleva el primer sillón activo libre de SU sede, en el orden
// de la agenda (orden y luego nombre). Sin sillón libre el hueco no se ofrece
// («Este hueco ya no está disponible») y aceptar no crea nada; en una sede sin
// sillones activos la cita va sin sillón, como antes. El paciente nunca ve el
// sillón. DIRECT_URL (owner, sin RLS) siembra lo que no tiene ruta sencilla.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** Un día laborable a 10+ días vista: 11:00 en Caracas (15:00 UTC). */
function slotDay(): string {
  const day = new Date(Date.now() + 10 * DAY_MS);
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) {
    day.setTime(day.getTime() + DAY_MS);
  }
  return day.toISOString().slice(0, 10);
}
const DAY = slotDay();
const START = new Date(`${DAY}T15:00:00.000Z`);
const END = new Date(`${DAY}T15:30:00.000Z`);

const UNAVAILABLE = {
  state: 'UNAVAILABLE',
  message: 'Este hueco ya no está disponible',
  offer: null,
};
/** Las claves de la oferta en la página pública: ninguna habla del sillón. */
const PUBLIC_OFFER_KEYS = [
  'currentAppointmentStart',
  'end',
  'expiresAt',
  'hourCycle',
  'locale',
  'locationAddress',
  'locationName',
  'patientFirstName',
  'providerName',
  'start',
  'timeZone',
];

describe('Oferta de hueco por enlace con sillones (e2e, DX-480)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let centro: string;
  let sur: string;
  let dentistId: string;
  const patientIds: string[] = [];

  const server = () => request(app.getHttpServer());
  const pub = {
    get: (token: string) =>
      server()
        .get(`/api/v1/public/slot-offers/${token}`)
        .set('X-Tenant-Host', clinic.host),
    accept: (token: string) =>
      server()
        .post(`/api/v1/public/slot-offers/${token}/accept`)
        .set('X-Tenant-Host', clinic.host)
        .send({}),
  };

  async function chair(
    locationId: string,
    name: string,
    over: { sortOrder?: number; active?: boolean } = {},
  ): Promise<string> {
    const row = await raw.chair.create({
      data: { tenantId: clinic.tenantId, locationId, name, ...over },
    });
    return row.id;
  }

  /** Oferta con enlace a un pendiente de la lista; devuelve el token. */
  async function offer(
    locationId: string,
    patientIndex: number,
  ): Promise<{ token: string; offerId: string }> {
    const entry = await raw.appointmentWaitlistEntry.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId: patientIds[patientIndex],
        durationMinutes: 30,
      },
    });
    const token = generateSlotOfferToken();
    const row = await raw.waitlistOffer.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        slotStart: START,
        slotEnd: END,
        providerId: dentistId,
        patientId: patientIds[patientIndex],
        waitlistEntryId: entry.id,
        channel: 'LINK_EMAIL',
        offerDay: new Date(`${DAY}T00:00:00.000Z`),
        createdById: clinic.adminUserId,
        tokenHash: hashSlotOfferToken(token),
        expiresAt: START,
      },
    });
    return { token, offerId: row.id };
  }

  /** Otra cita (otro profesional y paciente) que ocupa el sillón en la franja. */
  let occupied = 0;
  async function occupy(locationId: string, chairId: string): Promise<void> {
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId: patientIds[3 + occupied++],
        providerId: randomUUID(),
        chairId,
        start: START,
        end: END,
      },
    });
  }

  const created = (patientIndex: number) =>
    raw.appointment.findFirst({
      where: { tenantId: clinic.tenantId, patientId: patientIds[patientIndex] },
      select: { chairId: true, providerId: true, locationId: true },
    });

  /** Acepta por HTTP y comprueba que la página no habla del sillón. */
  async function acceptOk(token: string, chairNames: string[]): Promise<void> {
    const seen = await pub.get(token).expect(200);
    expect((seen.body as { state: string }).state).toBe('OPEN');
    const res = await pub.accept(token).expect(200);
    const body = res.body as { state: string; offer: object | null };
    expect(body.state).toBe('ACCEPTED');
    for (const view of [seen.body as typeof body, body]) {
      expect(Object.keys(view.offer ?? {}).sort()).toEqual(PUBLIC_OFFER_KEYS);
      const json = JSON.stringify(view);
      expect(json).not.toMatch(/chair|sill[oó]n/i);
      for (const name of chairNames) expect(json).not.toContain(name);
    }
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinic = await registerClinic(app, 'dx480-enlace');
    centro = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
      })
    ).id;
    sur = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: clinic.tenantId,
          name: 'Sede Sur',
        }),
      })
    ).id;
    // Sin horario de sede: el hueco cabe siempre (lo probado es el sillón).
    await raw.locationScheduleRange.deleteMany({
      where: { tenantId: clinic.tenantId },
    });
    await raw.locationSchedule.deleteMany({
      where: { tenantId: clinic.tenantId },
    });
    dentistId = (await seedMember(raw, clinic, ClinicRole.DENTIST)).userId;
    for (const name of ['Ana', 'Luis', 'Eva', 'Otro', 'Otra']) {
      const p = await raw.patient.create({
        data: { tenantId: clinic.tenantId, firstName: name, lastName: 'DX480' },
      });
      patientIds.push(p.id);
    }
  });

  afterEach(async () => {
    occupied = 0;
    const where = { tenantId: clinic.tenantId };
    await raw.auditEvent.deleteMany({ where });
    await raw.waitlistOffer.deleteMany({ where });
    await raw.appointmentWaitlistEntry.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
    await raw.chair.deleteMany({ where });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('sede sin sillones activos (aunque otra sede sí los tenga): la cita va sin sillón', async () => {
    await chair(sur, 'Sillón Sur');
    await chair(centro, 'Sillón apagado', { active: false });
    const { token } = await offer(centro, 0);
    await acceptOk(token, ['Sillón Sur', 'Sillón apagado']);
    expect(await created(0)).toEqual({
      chairId: null,
      providerId: dentistId,
      locationId: centro,
    });
  });

  it('el primer sillón activo libre de la sede, en el orden de la agenda (orden y luego nombre); el profesional es el de la oferta', async () => {
    const otherDoctor = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, userId: clinic.adminUserId },
    });
    await chair(centro, 'Sillón 0', { sortOrder: 0, active: false });
    await chair(centro, 'Sillón C', { sortOrder: 1 });
    // El profesional por defecto del sillón no cambia el de la oferta.
    const chairA = (
      await raw.chair.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: centro,
          name: 'Sillón A',
          sortOrder: 0,
          defaultProviderId: clinic.adminUserId,
          defaultProviderMembershipId: otherDoctor.id,
        },
      })
    ).id;
    await chair(centro, 'Sillón B', { sortOrder: 0 });
    await chair(sur, 'Sillón Sur', { sortOrder: 0 });
    const { token } = await offer(centro, 0);
    await acceptOk(token, ['Sillón A', 'Sillón B', 'Sillón C']);
    expect(await created(0)).toEqual({
      chairId: chairA,
      providerId: dentistId,
      locationId: centro,
    });
  });

  it('salta el sillón ocupado en la franja y toma el siguiente', async () => {
    const first = await chair(centro, 'Sillón 1', { sortOrder: 0 });
    const second = await chair(centro, 'Sillón 2', { sortOrder: 1 });
    await chair(centro, 'Sillón 3', { sortOrder: 2 });
    await occupy(centro, first);
    const { token } = await offer(centro, 0);
    await acceptOk(token, ['Sillón 1', 'Sillón 2', 'Sillón 3']);
    expect((await created(0))?.chairId).toBe(second);
  });

  it('sin ningún sillón libre el hueco no se ofrece: la página dice «no disponible», aceptar no crea nada y la oferta sigue pendiente', async () => {
    const first = await chair(centro, 'Sillón 1', { sortOrder: 0 });
    const second = await chair(centro, 'Sillón 2', { sortOrder: 1 });
    await chair(centro, 'Sillón apagado', { sortOrder: 2, active: false });
    await occupy(centro, first);
    await occupy(centro, second);
    const { token, offerId } = await offer(centro, 0);
    const seen = await pub.get(token).expect(200);
    expect(seen.body).toMatchObject(UNAVAILABLE);
    const tried = await pub.accept(token).expect(200);
    expect(tried.body).toMatchObject(UNAVAILABLE);
    expect(await created(0)).toBeNull();
    expect(
      (await raw.waitlistOffer.findUniqueOrThrow({ where: { id: offerId } }))
        .outcome,
    ).toBe('PENDING');
  });

  it('un sillón ocupado en OTRA sede no cuenta: la cita lleva el de la suya', async () => {
    const mine = await chair(centro, 'Sillón 1', { sortOrder: 0 });
    const theirs = await chair(sur, 'Sillón 1', { sortOrder: 0 });
    await occupy(sur, theirs);
    const { token } = await offer(centro, 0);
    await acceptOk(token, ['Sillón 1']);
    expect((await created(0))?.chairId).toBe(mine);
  });
});
