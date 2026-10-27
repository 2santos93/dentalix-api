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
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  g1LocationInsert,
  locationData,
} from './support/location-fixtures';
import { civilDateIn } from '../src/shared/time/civil-day';

/**
 * DX-271 (auditoría BE-038 y BE-039):
 *  - «Llegó» sobre una cita de hoy que ya empezó, cuyo ítem se agendó entre
 *    tanto en una cita futura: 200 y la reserva se queda en la futura.
 *  - Un 409 de reserva dice en qué cita está el ítem (fecha de la sede).
 *  - `planItemIds` en una cita cerrada o pasada: 409 sin tocar los vínculos
 *    ni el intervalo mínimo de la visita siguiente.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const MIN = 60000;
const DAY = 86400000;
const ZONE = 'America/Bogota';
const CLOSED = 'Esta cita ya pasó: sus tratamientos no se cambian.';

/** «30/10/2026 a las 09:00» en la zona de la sede (Colombia sin horario). */
function wall(instant: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('es-CO', {
      timeZone: ZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} a las ${p.hour}:${p.minute}`;
}

/** Minutos que lleva el día en Bogotá (UTC-5 fijo). */
function minutesIntoBogotaDay(now: Date): number {
  const local = new Date(now.getTime() - 5 * 60 * MIN);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

describe('DX-271 llegada tarde y vínculos de citas cerradas', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let reception: string;
  let receptionUserId: string;
  let receptionEmail: string;
  let locationId: string;
  let patientId: string;
  let catalogId: string;
  const call = (
    verb: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body?: object,
    token?: string,
  ) => {
    const r = request(app.getHttpServer())
      [verb]('/api/v1' + path)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', 'Bearer ' + (token ?? a.adminToken));
    return body ? r.send(body) : r;
  };
  const acceptedItems = async (n: number) => {
    const plan = await raw.treatmentPlan.create({
      data: { tenantId: a.tenantId, patientId, currency: 'COP' },
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++)
      ids.push(
        (
          await raw.treatmentPlanItem.create({
            data: {
              tenantId: a.tenantId,
              planId: plan.id,
              toothNumber: '36',
              catalogItemId: catalogId,
              price: 100000,
              status: 'ACCEPTED',
            },
          })
        ).id,
      );
    return { planId: plan.id, ids };
  };
  const accept = (planId: string) =>
    raw.treatmentPlan.update({
      where: { id: planId },
      data: { status: 'ACCEPTED' },
    });
  const rawAppointment = (
    start: Date,
    status: AppointmentStatus = 'SCHEDULED',
  ) =>
    raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId,
        patientId,
        providerId: a.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * MIN),
        status,
      },
    });
  const rawLink = (appointmentId: string, planItemId: string) =>
    raw.appointmentPlanItem.create({
      data: { tenantId: a.tenantId, patientId, appointmentId, planItemId },
    });
  const links = (appointmentId: string) =>
    raw.appointmentPlanItem.findMany({
      where: { appointmentId },
      select: { planItemId: true, active: true, deletedAt: true },
    });
  const planItemEvents = (appointmentId: string) =>
    raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        resourceId: appointmentId,
        metadata: { path: ['reason'], equals: 'APPOINTMENT_PLAN_ITEMS' },
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx271-e2e');
    locationId = (
      await raw.location.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    ).id;
    // Sin horario: la sede usa la zona de su país (CO) y admite cualquier hora.
    await raw.locationSchedule.updateMany({
      where: { tenantId: a.tenantId },
      data: { deletedAt: new Date() },
    });
    const member = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = await loginAs(app, a.host, member.email);
    receptionUserId = member.userId;
    receptionEmail = member.email;
    patientId = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Luis',
          lastName: 'Tarde',
          phone: '+573001112233',
        },
      })
    ).id;
    catalogId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: a.tenantId,
          code: 'DX271',
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

  it('«Llegó» tarde con el ítem ya agendado en otra cita futura: 200 y la reserva se queda en la futura', async () => {
    const {
      planId,
      ids: [itemId],
    } = await acceptedItems(1);
    await accept(planId);
    // Cita A de hoy (en Bogotá) que empezó hace un rato; el paciente no llega.
    const lateBy = Math.max(
      1,
      Math.min(20, minutesIntoBogotaDay(new Date()) - 1),
    );
    const late = await rawAppointment(new Date(Date.now() - lateBy * MIN));
    await rawLink(late.id, itemId);
    // El ítem sale en «sin agendar» (la reserva de A venció).
    const pending = await call(
      'get',
      `/treatment-plans/unscheduled?locationId=${locationId}`,
      undefined,
      reception,
    ).expect(200);
    expect(
      (pending.body as { items: { planItemIds: string[] }[] }).items.flatMap(
        (i) => i.planItemIds,
      ),
    ).toContain(itemId);
    // Recepción lo agenda para la semana que viene (cita B).
    const futureStart = new Date(Date.now() + 7 * DAY);
    const booked = await call(
      'post',
      '/appointments',
      {
        patientId,
        providerId: a.adminUserId,
        start: futureStart.toISOString(),
        end: new Date(futureStart.getTime() + 30 * MIN).toISOString(),
        planItemIds: [itemId],
        reason: 'Reagendado',
      },
      reception,
    ).expect(201);
    const futureId = (booked.body as { id: string }).id;

    // El paciente llega a la cita A.
    const arrived = await call(
      'patch',
      `/appointments/${late.id}`,
      { status: 'ARRIVED' },
      reception,
    ).expect(200);
    expect(arrived.body).toMatchObject({ status: 'ARRIVED' });
    expect(await links(futureId)).toEqual([
      { planItemId: itemId, active: true, deletedAt: null },
    ]);
    expect(await links(late.id)).toEqual([
      { planItemId: itemId, active: false, deletedAt: null },
    ]);
    // La llegada no edita vínculos: no hay evento APPOINTMENT_PLAN_ITEMS.
    expect(await planItemEvents(late.id)).toBe(0);

    // Una edición EXPLÍCITA sí choca, y dice en qué cita está el ítem.
    const explicit = await call(
      'patch',
      `/appointments/${late.id}`,
      { planItemIds: [itemId] },
      reception,
    ).expect(409);
    const message = (explicit.body as { message: string }).message;
    expect(message).toContain('otra cita');
    expect(message).toContain(`la del ${wall(futureStart)}`);
    expect(message).not.toMatch(/agendarlo/);
    expect(await planItemEvents(late.id)).toBe(0);

    // Reactivar una cita cancelada que lo tenía: 409 con la misma cita.
    const cancelled = await rawAppointment(
      new Date(Date.now() + 9 * DAY),
      'CANCELLED',
    );
    await rawLink(cancelled.id, itemId);
    const reactivate = await call(
      'patch',
      `/appointments/${cancelled.id}`,
      { status: 'SCHEDULED' },
      reception,
    ).expect(409);
    expect((reactivate.body as { message: string }).message).toContain(
      `la del ${wall(futureStart)}`,
    );

    // El resto del flujo sigue sin chocar: sillón, listo y completada.
    await call('patch', `/appointments/${late.id}`, {
      status: 'IN_CHAIR',
    }).expect(200);
    expect(await links(futureId)).toEqual([
      { planItemId: itemId, active: true, deletedAt: null },
    ]);
  });

  it('planItemIds sobre una cita COMPLETED: 409 y la visita 2 conserva su intervalo mínimo', async () => {
    const { planId, ids } = await acceptedItems(2);
    await call('patch', `/treatment-plans/${planId}/visits`, {
      items: [
        { itemId: ids[0], visit: 1, visitLabel: 'Cirugía' },
        { itemId: ids[1], visit: 2, visitLabel: 'Corona' },
      ],
      visitIntervals: { '2': 90 },
    }).expect(200);
    await accept(planId);
    const surgery = await rawAppointment(new Date(Date.now() - 2 * DAY));
    await rawLink(surgery.id, ids[0]);
    await raw.appointment.update({
      where: { id: surgery.id },
      data: { status: 'COMPLETED' },
    });
    const minimumDate = async () =>
      (
        (await call('get', `/treatment-plans/${planId}/visits`).expect(200))
          .body as { visits: { number: number; minimumDate: string | null }[] }
      ).visits.find((v) => v.number === 2)!.minimumDate;
    const before = await minimumDate();
    expect(before).not.toBeNull();
    const linksBefore = await links(surgery.id);

    for (const planItemIds of [[], [ids[0], ids[1]]]) {
      const res = await call(
        'patch',
        `/appointments/${surgery.id}`,
        { planItemIds },
        reception,
      ).expect(409);
      expect((res.body as { message: string }).message).toBe(CLOSED);
    }
    // Tampoco junto con otro cambio: la petición entera se rechaza.
    await call('patch', `/appointments/${surgery.id}`, {
      planItemIds: [],
      notes: 'corrección',
    }).expect(409);
    expect(await minimumDate()).toBe(before);
    expect(await links(surgery.id)).toEqual(linksBefore);
    expect(await planItemEvents(surgery.id)).toBe(0);
    expect(
      (await raw.appointment.findUniqueOrThrow({ where: { id: surgery.id } }))
        .notes,
    ).toBeNull();
  });

  it('reabrir una cita COMPLETED a otra fecha y quitarle sus ítems en el mismo PATCH: la BD lo impide (409) y nada cambia', async () => {
    const {
      planId,
      ids: [itemId],
    } = await acceptedItems(1);
    await accept(planId);
    const done = await rawAppointment(new Date(Date.now() - 4 * DAY));
    await rawLink(done.id, itemId);
    await raw.appointment.update({
      where: { id: done.id },
      data: { status: 'COMPLETED' },
    });
    const linksBefore = await links(done.id);
    // La cita «después» queda abierta (agendada y futura): el caso de uso lo
    // admite, pero retirar el vínculo mientras sigue COMPLETED lo frena el
    // trigger `dx271_completed_link_guard` (ERRCODE DX271 → 409).
    const start = new Date(Date.now() + 50 * DAY);
    // DX-273: la salida de COMPLETED lleva motivo (ADMIN/DENTIST).
    const res = await call('patch', `/appointments/${done.id}`, {
      status: 'SCHEDULED',
      statusReason: 'Reabrir para corregir sus tratamientos',
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * MIN).toISOString(),
      planItemIds: [],
    }).expect(409);
    expect((res.body as { message: string }).message).toBe(CLOSED);
    const after = await raw.appointment.findUniqueOrThrow({
      where: { id: done.id },
    });
    expect(after.status).toBe('COMPLETED');
    expect(after.start.getTime()).toBe(done.start.getTime());
    expect(await links(done.id)).toEqual(linksBefore);
    expect(await planItemEvents(done.id)).toBe(0);
  });

  it('planItemIds sobre una cita CANCELLED, NO_SHOW o pasada sin llegar: 409; en una futura, 200', async () => {
    const {
      planId,
      ids: [itemId],
    } = await acceptedItems(1);
    await accept(planId);
    const cancelled = await rawAppointment(
      new Date(Date.now() + 40 * DAY),
      'CANCELLED',
    );
    const noShow = await rawAppointment(
      new Date(Date.now() - 5 * DAY),
      'NO_SHOW',
    );
    const pastScheduled = await rawAppointment(new Date(Date.now() - 6 * DAY));
    // DX-271 M6: la cancelada es futura, no «ya pasó»: se dice su estado.
    for (const [appointment, message] of [
      [cancelled, 'Esta cita está cancelada: sus tratamientos no se cambian.'],
      [noShow, CLOSED],
      [pastScheduled, CLOSED],
    ] as const) {
      const res = await call(
        'patch',
        `/appointments/${appointment.id}`,
        { planItemIds: [itemId] },
        reception,
      ).expect(409);
      expect((res.body as { message: string }).message).toBe(message);
      expect(await links(appointment.id)).toEqual([]);
    }
    const future = await rawAppointment(new Date(Date.now() + 41 * DAY));
    await call(
      'patch',
      `/appointments/${future.id}`,
      { planItemIds: [itemId] },
      reception,
    ).expect(200);
    expect(await links(future.id)).toEqual([
      { planItemId: itemId, active: true, deletedAt: null },
    ]);
    expect(await planItemEvents(future.id)).toBe(1);
  });

  // Al final: restringe a recepción a la sede principal.
  it('el 409 de reserva no enseña la fecha de una cita de una sede no permitida (M3)', async () => {
    const {
      planId,
      ids: [itemId],
    } = await acceptedItems(1);
    await accept(planId);
    const north = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: a.tenantId,
        name: 'Sede Norte DX271',
      }),
    });
    const holderStart = new Date(Date.now() + 60 * DAY);
    const holder = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: north.id,
        patientId,
        providerId: a.adminUserId,
        start: holderStart,
        end: new Date(holderStart.getTime() + 30 * MIN),
        status: 'SCHEDULED',
      },
    });
    await rawLink(holder.id, itemId);
    const target = await rawAppointment(new Date(Date.now() + 62 * DAY));
    // Quien ve las dos sedes sí ve en qué cita está.
    const open = await call('patch', `/appointments/${target.id}`, {
      planItemIds: [itemId],
    }).expect(409);
    expect((open.body as { message: string }).message).toContain(
      `la del ${wall(holderStart)}`,
    );
    await call('put', `/staff/${receptionUserId}/locations`, {
      locationIds: [locationId],
    }).expect(200);
    const restricted = await loginAs(app, a.host, receptionEmail);
    const res = await call(
      'patch',
      `/appointments/${target.id}`,
      { planItemIds: [itemId] },
      restricted,
    ).expect(409);
    const message = (res.body as { message: string }).message;
    expect(message).toBe(
      'Este tratamiento ya está reservado en otra cita de otra sede. Pide en esa sede que lo quiten de esa cita o la cancelen.',
    );
    expect(message).not.toContain(wall(holderStart).slice(0, 10));
    expect(message).not.toContain('Norte');
    expect(await links(target.id)).toEqual([]);
  });
  // G1-B (DX-350, spec §4.4, pre-flight I4): el aviso «reservado en otra
  // cita» lleva el formato y el reloj de la sede de la titular EN CRUDO: null
  // si la sede no está permitida y también si no tiene el dato; la API no
  // formatea con ellos y la lectura no falla.
  interface ReservedItem {
    planItemId: string;
    locationId: string | null;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  }
  interface PanelItem {
    appointmentId: string;
    planItemsReservedElsewhere: ReservedItem[];
  }

  // Cada test con su paciente y su profesional: las citas de hoy de los tests
  // anteriores no se solapan con las suyas (EXCLUDE por paciente y por
  // profesional). `acceptedItems` y `rawLink` usan `patientId`.
  let providerId: string;
  let providers = 0;
  const freshPatientAndProvider = async () => {
    patientId = (
      await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Rita', lastName: 'Reserva' },
      })
    ).id;
    providerId = (
      await seedMember(
        raw,
        { ...a, subdomain: `${a.subdomain}-${++providers}` },
        ClinicRole.DENTIST,
      )
    ).userId;
  };

  /**
   * Cita de hoy en la sede principal que empezó hace un rato, con estos
   * tratamientos SIN reserva (el trigger no reserva en una cita vencida), y
   * después el paciente en la sala de espera: como «Llegó» tarde (DX-271).
   */
  const arrivedLateWith = async (itemIds: string[]) => {
    const lateBy = Math.max(
      1,
      Math.min(20, minutesIntoBogotaDay(new Date()) - 1),
    );
    const start = new Date(Date.now() - lateBy * MIN);
    const late = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId,
        patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * MIN),
        status: 'SCHEDULED',
      },
    });
    for (const itemId of itemIds) await rawLink(late.id, itemId);
    await raw.appointment.update({
      where: { id: late.id },
      data: {
        status: 'ARRIVED',
        preArrivalStatus: 'SCHEDULED',
        arrivedAt: new Date(),
      },
    });
    return late;
  };
  /** Cita titular en `holderLocationId`, con el vínculo activo. */
  const holderAt = async (
    holderLocationId: string,
    itemId: string,
    start: Date,
    status: AppointmentStatus,
  ) => {
    const holder = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: holderLocationId,
        patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * MIN),
        status,
        ...(status === 'IN_CHAIR' ? { arrivedAt: start, seatedAt: start } : {}),
      },
    });
    await rawLink(holder.id, itemId);
    return holder;
  };
  /** Avisos de la cita en el panel «En clínica» de la sede principal. */
  const reservedOf = async (appointmentId: string, token = a.adminToken) => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/appointments/in-clinic')
      .set('X-Tenant-Host', a.host)
      .set('Authorization', 'Bearer ' + token)
      .set('X-Location-Id', locationId)
      .expect(200);
    const body = res.body as Record<string, PanelItem[]>;
    const item = [
      ...body.waiting,
      ...body.inChair,
      ...body.readyForCheckout,
    ].find((i) => i.appointmentId === appointmentId);
    return item?.planItemsReservedElsewhere ?? [];
  };

  it('reservedElsewhere includes locale and hourCycle, null when the location is not allowed', async () => {
    await freshPatientAndProvider();
    const {
      planId,
      ids: [toAllowed, toHidden],
    } = await acceptedItems(2);
    await accept(planId);
    const east = await raw.location.create({
      data: locationData(REGIONAL_NEW_YORK_FIXTURE, {
        tenantId: a.tenantId,
        name: 'Sede Este DX350',
      }),
    });
    const west = await raw.location.create({
      data: locationData(REGIONAL_BERLIN_FIXTURE, {
        tenantId: a.tenantId,
        name: 'Sede Oeste DX350',
      }),
    });
    await holderAt(
      east.id,
      toAllowed,
      new Date(Date.now() + 30 * DAY),
      'SCHEDULED',
    );
    // La titular de la sede oculta es de hoy (en SU zona) con el paciente en
    // la clínica: es la única de una sede no permitida que se enseña
    // (DX-293). Una hora antes o después de la cita de hoy, sin solaparse.
    const now = new Date();
    const westToday = civilDateIn(now, REGIONAL_BERLIN_FIXTURE.timeZone);
    const hourAfter = new Date(now.getTime() + 60 * MIN);
    await holderAt(
      west.id,
      toHidden,
      civilDateIn(hourAfter, REGIONAL_BERLIN_FIXTURE.timeZone) === westToday
        ? hourAfter
        : new Date(now.getTime() - 60 * MIN),
      'IN_CHAIR',
    );
    const today = await arrivedLateWith([toAllowed, toHidden]);

    expect(await reservedOf(today.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          planItemId: toAllowed,
          locationId: east.id,
          timeZone: 'America/New_York',
          locale: 'en-US',
          hourCycle: 'h12',
        }),
        expect.objectContaining({
          planItemId: toHidden,
          locationId: west.id,
          timeZone: 'Europe/Berlin',
          locale: 'de-DE',
          hourCycle: 'h23',
        }),
      ]),
    );

    await call('put', `/staff/${receptionUserId}/locations`, {
      locationIds: [locationId, east.id],
    }).expect(200);
    const restricted = await loginAs(app, a.host, receptionEmail);
    const seen = await reservedOf(today.id, restricted);
    expect(seen.find((r) => r.planItemId === toAllowed)).toMatchObject({
      locale: 'en-US',
      hourCycle: 'h12',
    });
    expect(seen.find((r) => r.planItemId === toHidden)).toMatchObject({
      locationId: null,
      timeZone: null,
      locale: null,
      hourCycle: null,
    });
  });

  it('reservedElsewhere returns raw nulls for an allowed unconfigured location, the appointment read does not fail', async () => {
    await freshPatientAndProvider();
    const {
      planId,
      ids: [itemId],
    } = await acceptedItems(1);
    await accept(planId);
    // Sede de una réplica de G1 sin reloj y, además, sin formato.
    const g1 = await g1LocationInsert(
      raw,
      a.tenantId,
      'Réplica G1 DX350',
      REGIONAL_BERLIN_FIXTURE,
    );
    await raw.$executeRawUnsafe(
      `UPDATE "locations" SET "locale" = NULL WHERE "id" = $1::uuid`,
      g1,
    );
    await holderAt(g1, itemId, new Date(Date.now() + 30 * DAY), 'SCHEDULED');
    const today = await arrivedLateWith([itemId]);

    expect(await reservedOf(today.id)).toEqual([
      expect.objectContaining({
        planItemId: itemId,
        locationId: g1,
        timeZone: 'Europe/Berlin',
        locale: null,
        hourCycle: null,
      }),
    ]);
  });
});
