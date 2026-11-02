import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
  ClinicRole,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
  seedMember,
  loginAs,
} from './support/e2e-fixtures';
import { heldInClinicMessage } from '../src/modules/appointments/domain/plan-item-reservation';
import { regionalFormat } from '../src/shared/format/regional-format';
import { locationData } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

/**
 * DX-293 (seguimiento de DX-288, revisión M2): el aviso de reserva en otra
 * cita (`planItemsReservedElsewhere`, al marcar «Llegó» y en el panel «En
 * clínica») dice con `heldInClinic` si la cita que tiene la reserva es de
 * hoy con el paciente en la clínica: la misma regla que el 409 de «Traer a
 * esta cita». Con la sede de esa cita no permitida, sin cita, hora ni sede
 * (DX-089).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const MIN = 60000;
const DAY = 86400000;
/**
 * DX-449: la zona de la sede salvo cerca de su medianoche, cuando la sede pasa a una zona
 * donde ahora es mediodía: las citas «de hoy que ya empezaron» son de hoy a
 * cualquier hora de la CI.
 */
const SEDE = sedeTodayFixture();
const ZONE = SEDE.timeZone;

interface ReservedElsewhere {
  planItemId: string;
  name: string;
  toothNumber: string;
  heldInClinic: boolean;
  appointmentId: string | null;
  start: string | null;
  locationId: string | null;
  locationName: string | null;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
}

interface InClinicPanel {
  waiting: {
    appointmentId: string;
    planItemsReservedElsewhere: ReservedElsewhere[];
  }[];
}

describe('DX-293 aviso de reserva en otra cita con heldInClinic', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let reception: string;
  let receptionUserId: string;
  let receptionEmail: string;
  let locationId: string;
  let locationName: string;
  let catalogId: string;

  const call = (
    verb: 'get' | 'post' | 'patch' | 'put',
    path: string,
    token: string = a.adminToken,
    body?: object,
  ) => {
    const r = request(app.getHttpServer())
      [verb]('/api/v1' + path)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', 'Bearer ' + token);
    return body ? r.send(body) : r;
  };

  /**
   * Cada escenario con su paciente y su profesional (las EXCLUDE de solape
   * son por los dos): sus citas de hoy caben justo antes de «ahora». Las
   * citas de hoy son de 1 min y ya empezaron, así el vínculo nace sin
   * reserva (como en los e2e de DX-288).
   */
  let scenario = 0;
  const freshScenario = async () => {
    const n = scenario++;
    const patient = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'Lucía',
        lastName: `Sillón ${n}`,
      },
    });
    const provider = await raw.user.create({
      data: {
        email: `dx293-${n}@dx293-e2e.test`,
        passwordHash: 'x',
        fullName: `Doctor ${n}`,
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: provider.id,
        role: ClinicRole.DENTIST,
      },
    });
    const plan = await raw.treatmentPlan.create({
      data: { tenantId: a.tenantId, patientId: patient.id, currency: 'COP' },
    });
    const { id: itemId } = await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        toothNumber: '36',
        catalogItemId: catalogId,
        price: 100000,
        status: 'ACCEPTED',
      },
    });
    await raw.treatmentPlan.update({
      where: { id: plan.id },
      data: { status: 'ACCEPTED' },
    });
    let minutesAgo = 0;
    const base = Date.now() - 30_000;
    const book = async (start: Date, location = locationId, minutes = 1) => {
      const appointment = await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: location,
          patientId: patient.id,
          providerId: provider.id,
          start,
          end: new Date(start.getTime() + minutes * MIN),
        },
      });
      await raw.appointmentPlanItem.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient.id,
          appointmentId: appointment.id,
          planItemId: itemId,
        },
      });
      return appointment;
    };
    /** Cita de hoy, de 1 min y con 1 min de hueco, que ya empezó (sin reserva). */
    const startedToday = (location = locationId) =>
      book(new Date(base - (minutesAgo += 2) * MIN), location);
    return { itemId, book, startedToday };
  };
  /** La titular «llegó» (por la BD) y queda con la reserva. */
  const putInClinic = (id: string, status: AppointmentStatus) => {
    const now = new Date();
    const seated = status !== AppointmentStatus.ARRIVED;
    return raw.appointment.update({
      where: { id },
      data: {
        status,
        arrivedAt: now,
        // Las horas del flujo que exige `appointments_flow_times_check`.
        preArrivalStatus: seated ? null : 'SCHEDULED',
        seatedAt: seated ? now : null,
        readyForCheckoutAt:
          status === AppointmentStatus.READY_FOR_CHECKOUT ? now : null,
      },
    });
  };
  const activeLinks = (itemId: string) =>
    raw.appointmentPlanItem.findMany({
      where: { planItemId: itemId, active: true, deletedAt: null },
      select: { appointmentId: true },
    });
  const arrive = async (id: string, token = reception) =>
    (
      (
        await call('patch', `/appointments/${id}`, token, {
          status: 'ARRIVED',
        }).expect(200)
      ).body as { planItemsReservedElsewhere: ReservedElsewhere[] }
    ).planItemsReservedElsewhere;
  const panelNotice = async (id: string, token = reception) =>
    (
      (
        await call('get', '/appointments/in-clinic', token)
          .set('X-Location-Id', locationId)
          .expect(200)
      ).body as InClinicPanel
    ).waiting.find((w) => w.appointmentId === id)!.planItemsReservedElsewhere;
  const claim = (appointmentId: string, itemId: string, token = reception) =>
    call(
      'post',
      `/appointments/${appointmentId}/plan-items/${itemId}/claim`,
      token,
    );

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx293-e2e');
    const location = await raw.location.update({
      where: {
        id: (
          await raw.location.findFirstOrThrow({
            where: { tenantId: a.tenantId },
          })
        ).id,
      },
      data: { timeZone: ZONE },
    });
    locationId = location.id;
    locationName = location.name;
    // Sin horario: «hoy» es el de la zona de la sede.
    await raw.locationSchedule.updateMany({
      where: { tenantId: a.tenantId },
      data: { deletedAt: new Date() },
    });
    const rec = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = await loginAs(app, a.host, rec.email);
    receptionUserId = rec.userId;
    receptionEmail = rec.email;
    catalogId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: a.tenantId,
          code: 'DX293',
          kind: 'PROCEDURE',
          labelEs: 'Implante',
          color: '#123456',
          defaultPrice: 100000,
        },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await raw.$disconnect();
  });

  it.each([
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_CHAIR,
    AppointmentStatus.READY_FOR_CHECKOUT,
  ])(
    'titular de hoy en la clínica (%s): heldInClinic true con su hora y sede, en «Llegó» y en el panel; «Traer» daría el 409 de DX-288',
    async (status) => {
      const { itemId, startedToday } = await freshScenario();
      const holder = await startedToday();
      await putInClinic(holder.id, status);
      expect(await activeLinks(itemId)).toEqual([{ appointmentId: holder.id }]);
      const today = await startedToday();

      const expected: ReservedElsewhere = {
        planItemId: itemId,
        name: 'Implante',
        toothNumber: '36',
        heldInClinic: true,
        appointmentId: holder.id,
        start: holder.start.toISOString(),
        locationId,
        locationName,
        timeZone: ZONE,
        locale: SEDE.locale,
        hourCycle: SEDE.hourCycle,
      };
      expect(await arrive(today.id)).toEqual([expected]);
      expect(await panelNotice(today.id)).toEqual([expected]);
      // La web no ofrece «Traer»: si alguien lo pide, el mismo 409 de DX-288.
      const res = await claim(today.id, itemId).expect(409);
      expect((res.body as { message: string }).message).toBe(
        heldInClinicMessage({
          start: holder.start,
          timeZone: ZONE,
          locationName,
          fmt: regionalFormat(SEDE),
        }),
      );
      expect(await activeLinks(itemId)).toEqual([{ appointmentId: holder.id }]);
    },
  );

  it('titular olvidada en la clínica de un día anterior: heldInClinic false y «Traer a esta cita» da 200', async () => {
    const { itemId, book, startedToday } = await freshScenario();
    const forgotten = await book(new Date(Date.now() - 3 * DAY));
    await putInClinic(forgotten.id, AppointmentStatus.IN_CHAIR);
    expect(await activeLinks(itemId)).toEqual([
      { appointmentId: forgotten.id },
    ]);
    const today = await startedToday();

    const [notice] = await arrive(today.id);
    expect(notice).toMatchObject({
      heldInClinic: false,
      appointmentId: forgotten.id,
      start: forgotten.start.toISOString(),
      locationName,
    });
    expect((await panelNotice(today.id))[0].heldInClinic).toBe(false);
    await claim(today.id, itemId).expect(200);
    expect(await activeLinks(itemId)).toEqual([{ appointmentId: today.id }]);
  });

  it('reserva en una cita futura: el aviso no cambia (heldInClinic false) y «Traer a esta cita» da 200', async () => {
    const { itemId, book, startedToday } = await freshScenario();
    const today = await startedToday();
    const future = await book(new Date(Date.now() + 7 * DAY), locationId, 30);
    expect(await activeLinks(itemId)).toEqual([{ appointmentId: future.id }]);

    const expected: ReservedElsewhere = {
      planItemId: itemId,
      name: 'Implante',
      toothNumber: '36',
      heldInClinic: false,
      appointmentId: future.id,
      start: future.start.toISOString(),
      locationId,
      locationName,
      timeZone: ZONE,
      locale: SEDE.locale,
      hourCycle: SEDE.hourCycle,
    };
    expect(await arrive(today.id)).toEqual([expected]);
    expect(await panelNotice(today.id)).toEqual([expected]);
    await claim(today.id, itemId).expect(200);
    expect(await activeLinks(itemId)).toEqual([{ appointmentId: today.id }]);
  });

  // Al final: restringe a recepción a la sede principal.
  it('titular de hoy en la clínica de una sede no permitida: heldInClinic sin cita, hora ni sede (DX-089); quien ve las dos sedes, sí', async () => {
    const north = await raw.location.create({
      data: locationData(SEDE, {
        tenantId: a.tenantId,
        name: 'Sede Norte DX293',
      }),
    });
    const { itemId, startedToday } = await freshScenario();
    const holder = await startedToday(north.id);
    await putInClinic(holder.id, AppointmentStatus.IN_CHAIR);
    const today = await startedToday();
    // Otro paciente con la reserva en una cita futura de Norte: sigue sin
    // enseñarse (DX-273).
    const futureItem = await freshScenario();
    const futureToday = await futureItem.startedToday();
    const futureNorth = await futureItem.book(
      new Date(Date.now() + 9 * DAY),
      north.id,
      30,
    );

    await call('put', `/staff/${receptionUserId}/locations`, a.adminToken, {
      locationIds: [locationId],
    }).expect(200);
    const restricted = await loginAs(app, a.host, receptionEmail);

    const generic: ReservedElsewhere = {
      planItemId: itemId,
      name: 'Implante',
      toothNumber: '36',
      heldInClinic: true,
      appointmentId: null,
      start: null,
      locationId: null,
      locationName: null,
      timeZone: null,
      locale: null,
      hourCycle: null,
    };
    const arrived = await call(
      'patch',
      `/appointments/${today.id}`,
      restricted,
      {
        status: 'ARRIVED',
      },
    ).expect(200);
    expect(
      (arrived.body as { planItemsReservedElsewhere: ReservedElsewhere[] })
        .planItemsReservedElsewhere,
    ).toEqual([generic]);
    const panel = await call('get', '/appointments/in-clinic', restricted)
      .set('X-Location-Id', locationId)
      .expect(200);
    expect(
      (panel.body as InClinicPanel).waiting.find(
        (w) => w.appointmentId === today.id,
      )!.planItemsReservedElsewhere,
    ).toEqual([generic]);
    for (const body of [arrived.body, panel.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain('Norte');
      expect(text).not.toContain(north.id);
      expect(text).not.toContain(holder.id);
      expect(text).not.toContain(holder.start.toISOString());
    }
    // «Traer» desde una sede no permitida sigue siendo 403 sin datos.
    const res = await claim(today.id, itemId, restricted).expect(403);
    expect(JSON.stringify(res.body)).not.toContain('Norte');

    // La futura en Norte: como en DX-273, ni rastro.
    expect(await arrive(futureToday.id, restricted)).toEqual([]);
    expect(await activeLinks(futureItem.itemId)).toEqual([
      { appointmentId: futureNorth.id },
    ]);

    // Quien ve las dos sedes: con hora y sede.
    const [full] = await panelNotice(today.id, a.adminToken);
    expect(full).toEqual({
      ...generic,
      appointmentId: holder.id,
      start: holder.start.toISOString(),
      locationId: north.id,
      locationName: 'Sede Norte DX293',
      timeZone: ZONE,
      locale: SEDE.locale,
      hourCycle: SEDE.hourCycle,
    });
  });
});
