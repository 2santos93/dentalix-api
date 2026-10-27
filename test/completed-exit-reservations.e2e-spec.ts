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
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';
import { heldInClinicMessage } from '../src/modules/appointments/domain/plan-item-reservation';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

/**
 * DX-273 (revisión DX-271, I1 e I2):
 *  - Sacar una cita de COMPLETED: solo ADMIN/DENTIST, con motivo (400 sin
 *    él), auditado, y el mínimo de la visita siguiente se recalcula de forma
 *    explícita (respuesta y auditoría).
 *  - «Llegó» con un tratamiento reservado en otra cita: 200 con
 *    `planItemsReservedElsewhere` (solo sedes permitidas), también en el
 *    panel «En clínica».
 *  - «Traer a esta cita»: mueve la reserva con auditoría en las dos citas.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const MIN = 60000;
const DAY = 86400000;
const ZONE = 'America/Bogota';

/** Día civil YYYY-MM-DD en Bogotá. */
function civil(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(instant);
}

/** Día civil `days` después de `day` (YYYY-MM-DD). */
function plusDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return new Date(d.getTime() + days * DAY).toISOString().slice(0, 10);
}

/** Minutos que lleva el día en Bogotá (UTC-5 fijo). */
function minutesIntoBogotaDay(now: Date): number {
  const local = new Date(now.getTime() - 5 * 60 * MIN);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

interface ReservedElsewhere {
  planItemId: string;
  name: string;
  toothNumber: string;
  /** DX-293: la titular es de hoy con el paciente en la clínica. */
  heldInClinic: boolean;
  appointmentId: string;
  start: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  locale: string | null;
  hourCycle: string | null;
}

describe('DX-273 salida de «Completada» y reservas en otra cita', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let receptionUserId: string;
  let receptionEmail: string;
  let assistant: string;
  let dentist: string;
  let dentistUserId: string;
  let locationId: string;
  let locationName: string;
  let patientId: string;
  let catalogId: string;
  const call = (
    verb: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body?: object,
    token?: string,
    clinic?: Clinic,
  ) => {
    const r = request(app.getHttpServer())
      [verb]('/api/v1' + path)
      .set('X-Tenant-Host', (clinic ?? a).host)
      .set('Authorization', 'Bearer ' + (token ?? (clinic ?? a).adminToken));
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
  // Todas las citas son del mismo paciente y profesional: cada una en su
  // hueco (las EXCLUDE de solape no admiten dos a la vez).
  let slot = 0;
  /** `days` días desde ahora, en un hueco propio de 30 min. */
  const inDays = (days: number) =>
    new Date(Date.now() + days * DAY + slot++ * 40 * MIN);
  const rawAppointment = (
    start: Date,
    status: AppointmentStatus = 'SCHEDULED',
    location = locationId,
    minutes = 30,
  ) =>
    raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: location,
        patientId,
        providerId: a.adminUserId,
        start,
        end: new Date(start.getTime() + minutes * MIN),
        status,
      },
    });
  const rawLink = (appointmentId: string, planItemId: string) =>
    raw.appointmentPlanItem.create({
      data: { tenantId: a.tenantId, patientId, appointmentId, planItemId },
    });
  const complete = (appointmentId: string) =>
    raw.appointment.update({
      where: { id: appointmentId },
      data: { status: 'COMPLETED' },
    });
  const links = (appointmentId: string) =>
    raw.appointmentPlanItem.findMany({
      where: { appointmentId },
      select: { planItemId: true, active: true, deletedAt: true },
    });
  const events = (appointmentId: string, reason: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceId: appointmentId,
        action: 'UPDATE',
        metadata: { path: ['reason'], equals: reason },
      },
      orderBy: { occurredAt: 'asc' },
    });
  /**
   * Cita de hoy en Bogotá que ya empezó (su reserva venció: el ítem se puede
   * agendar en otra), de 5 min y en su propio hueco, sin cruzar la medianoche.
   */
  let todaySlot = 0;
  const todayAppointment = (location = locationId) => {
    const lateBy = Math.max(
      1,
      Math.min(2 + 6 * todaySlot++, minutesIntoBogotaDay(new Date()) - 6),
    );
    return rawAppointment(
      new Date(Date.now() - lateBy * MIN),
      'SCHEDULED',
      location,
      5,
    );
  };
  const visitTwoMinimum = async (planId: string) =>
    (
      (await call('get', `/treatment-plans/${planId}/visits`).expect(200))
        .body as { visits: { number: number; minimumDay: string }[] }
    ).visits.find((v) => v.number === 2)!.minimumDay;
  /** Plan de dos visitas, visita 2 a 90 días; cirugía completada en `ago` días. */
  const surgeryPlan = async (agoDays: number[]) => {
    const { planId, ids } = await acceptedItems(2);
    await call('patch', `/treatment-plans/${planId}/visits`, {
      items: [
        { itemId: ids[0], visit: 1, visitLabel: 'Cirugía' },
        { itemId: ids[1], visit: 2, visitLabel: 'Implante' },
      ],
      visitIntervals: { '2': 90 },
    }).expect(200);
    await accept(planId);
    const surgeries = [];
    for (const ago of agoDays) {
      const s = await rawAppointment(inDays(-ago));
      await rawLink(s.id, ids[0]);
      await complete(s.id);
      surgeries.push(s);
    }
    return { planId, ids, surgeries };
  };

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx273-e2e');
    b = await registerClinic(app, 'dx273-e2e-b');
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    locationId = location.id;
    locationName = location.name;
    await raw.locationSchedule.updateMany({
      where: { tenantId: a.tenantId },
      data: { deletedAt: new Date() },
    });
    const rec = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = await loginAs(app, a.host, rec.email);
    receptionUserId = rec.userId;
    receptionEmail = rec.email;
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    const den = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = await loginAs(app, a.host, den.email);
    dentistUserId = den.userId;
    patientId = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Marta',
          lastName: 'Implante',
          phone: '+573001112244',
        },
      })
    ).id;
    catalogId = (
      await raw.dentalCatalogItem.create({
        data: {
          tenantId: a.tenantId,
          code: 'DX273',
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

  describe('salida de COMPLETED', () => {
    it('RECEPTION y ASSISTANT: 403 en español, sin cambios ni evento', async () => {
      const {
        planId,
        surgeries: [surgery],
      } = await surgeryPlan([2]);
      const before = await visitTwoMinimum(planId);
      for (const token of [reception, assistant]) {
        for (const status of ['CANCELLED', 'SCHEDULED']) {
          const start = inDays(5);
          const res = await call(
            'patch',
            `/appointments/${surgery.id}`,
            {
              status,
              statusReason: 'Se marcó completada por error',
              ...(status === 'SCHEDULED'
                ? {
                    start: start.toISOString(),
                    end: new Date(start.getTime() + 30 * MIN).toISOString(),
                  }
                : {}),
            },
            token,
          ).expect(403);
          expect((res.body as { message: string }).message).toBe(
            'Solo el odontólogo o la administración pueden sacar una cita de «Completada».',
          );
        }
      }
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: surgery.id } }))
          .status,
      ).toBe('COMPLETED');
      expect(await visitTwoMinimum(planId)).toBe(before);
      expect(await events(surgery.id, 'COMPLETED_EXIT')).toEqual([]);
    });

    it('ADMIN sin motivo, o con uno de menos de 3 o más de 500 caracteres: 400; recepción con motivo corto: 403 (el rol va antes)', async () => {
      const {
        surgeries: [surgery],
      } = await surgeryPlan([2]);
      await call(
        'patch',
        `/appointments/${surgery.id}`,
        { status: 'CANCELLED', statusReason: 'ab' },
        reception,
      ).expect(403);
      const missing = await call('patch', `/appointments/${surgery.id}`, {
        status: 'CANCELLED',
      }).expect(400);
      expect((missing.body as { message: string }).message).toBe(
        'Indica el motivo (de 3 a 500 caracteres) para sacar la cita de «Completada».',
      );
      for (const statusReason of ['  ab ', 'x'.repeat(501)]) {
        const res = await call('patch', `/appointments/${surgery.id}`, {
          status: 'CANCELLED',
          statusReason,
        }).expect(400);
        expect(JSON.stringify(res.body)).toContain('motivo');
      }
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: surgery.id } }))
          .status,
      ).toBe('COMPLETED');
      expect(
        await raw.appointmentStatusReversal.count({
          where: { appointmentId: surgery.id },
        }),
      ).toBe(0);
    });

    it('DENTIST con motivo: 200, motivo guardado, auditado y el mínimo de la visita 2 recalculado de forma explícita (sin cirugía completada, sin mínimo)', async () => {
      const {
        planId,
        surgeries: [surgery],
      } = await surgeryPlan([2]);
      const before = await visitTwoMinimum(planId);
      expect(before).toBe(plusDays(civil(surgery.end), 90));

      const res = await call(
        'patch',
        `/appointments/${surgery.id}`,
        {
          status: 'CANCELLED',
          statusReason: '  La cirugía no se hizo  ',
          ...STAFF_CANCELLATION,
        },
        dentist,
      ).expect(200);
      const body = res.body as {
        status: string;
        completedExit: {
          reversalId: string;
          reason: string;
          visitMinimums: unknown[];
        };
      };
      expect(body.status).toBe('CANCELLED');
      expect(body.completedExit.reason).toBe('La cirugía no se hizo');
      expect(body.completedExit.visitMinimums).toEqual([
        {
          planId,
          visit: 2,
          minimumDayBefore: before,
          minimumDayAfter: null,
          anchorAppointmentIdAfter: null,
        },
      ]);
      // Lo que la agenda ofrece ahora: hoy (documentado en el README).
      expect(await visitTwoMinimum(planId)).toBe(civil(new Date()));

      const reversal = await raw.appointmentStatusReversal.findUniqueOrThrow({
        where: { id: body.completedExit.reversalId },
      });
      expect(reversal).toMatchObject({
        tenantId: a.tenantId,
        appointmentId: surgery.id,
        fromStatus: 'COMPLETED',
        toStatus: 'CANCELLED',
        reason: 'La cirugía no se hizo',
        actorUserId: dentistUserId,
      });
      const [event] = await events(surgery.id, 'COMPLETED_EXIT');
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        actorUserId: dentistUserId,
        patientId,
      });
      expect(event.metadata).toEqual({
        reason: 'COMPLETED_EXIT',
        status: { from: 'COMPLETED', to: 'CANCELLED' },
        params: { reversalId: body.completedExit.reversalId },
        visitMinimums: [
          {
            planId,
            visit: 2,
            before,
            after: null,
          },
        ],
        // DX-279 (B2): la cancelación va en este mismo evento, nunca tardía.
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: 'ILLNESS',
          noticeMinutes: 0,
          lateCancellation: false,
        },
      });
      // El motivo (texto libre) no va en la auditoría: está en su tabla.
      expect(JSON.stringify(event.metadata)).not.toContain('cirugía');
    });

    it('con otra cirugía que sigue completada, el mínimo se ancla en ella', async () => {
      const {
        planId,
        surgeries: [older, newer],
      } = await surgeryPlan([20, 2]);
      const res = await call('patch', `/appointments/${newer.id}`, {
        status: 'CANCELLED',
        statusReason: 'Duplicada por error',
        ...STAFF_CANCELLATION,
      }).expect(200);
      const expected = plusDays(civil(older.end), 90);
      expect(
        (res.body as { completedExit: { visitMinimums: unknown[] } })
          .completedExit.visitMinimums,
      ).toEqual([
        {
          planId,
          visit: 2,
          minimumDayBefore: plusDays(civil(newer.end), 90),
          minimumDayAfter: expected,
          anchorAppointmentIdAfter: older.id,
        },
      ]);
      expect(await visitTwoMinimum(planId)).toBe(expected);
    });

    it('ADMIN reabre (a SCHEDULED en el futuro) con motivo: 200 y auditado', async () => {
      const {
        surgeries: [surgery],
      } = await surgeryPlan([3]);
      const start = inDays(10);
      await call('patch', `/appointments/${surgery.id}`, {
        status: 'SCHEDULED',
        statusReason: 'Se reprograma la cirugía',
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * MIN).toISOString(),
      }).expect(200);
      const [event] = await events(surgery.id, 'COMPLETED_EXIT');
      expect(event.metadata).toMatchObject({
        status: { from: 'COMPLETED', to: 'SCHEDULED' },
      });
    });
  });

  describe('«Llegó» con el tratamiento reservado en otra cita', () => {
    it('200 con planItemsReservedElsewhere, también en «En clínica»; «Traer a esta cita» mueve la reserva con auditoría en las dos', async () => {
      const {
        planId,
        ids: [itemId],
      } = await acceptedItems(1);
      await accept(planId);
      const today = await todayAppointment();
      await rawLink(today.id, itemId);
      const futureStart = inDays(7);
      const booked = await call(
        'post',
        '/appointments',
        {
          patientId,
          providerId: a.adminUserId,
          start: futureStart.toISOString(),
          end: new Date(futureStart.getTime() + 30 * MIN).toISOString(),
          planItemIds: [itemId],
        },
        reception,
      ).expect(201);
      const futureId = (booked.body as { id: string }).id;
      expect(
        (booked.body as { planItemsReservedElsewhere: unknown[] })
          .planItemsReservedElsewhere,
      ).toEqual([]);

      const arrived = await call(
        'patch',
        `/appointments/${today.id}`,
        { status: 'ARRIVED' },
        reception,
      ).expect(200);
      const expected: ReservedElsewhere = {
        planItemId: itemId,
        name: 'Implante',
        toothNumber: '36',
        heldInClinic: false,
        appointmentId: futureId,
        start: futureStart.toISOString(),
        locationId,
        locationName,
        timeZone: ZONE,
        locale: REGIONAL_BOGOTA_FIXTURE.locale,
        hourCycle: REGIONAL_BOGOTA_FIXTURE.hourCycle,
      };
      expect(
        (arrived.body as { planItemsReservedElsewhere: ReservedElsewhere[] })
          .planItemsReservedElsewhere,
      ).toEqual([expected]);

      const panel = await call(
        'get',
        '/appointments/in-clinic',
        undefined,
        reception,
      )
        .set('X-Location-Id', locationId)
        .expect(200);
      const waiting = (
        panel.body as {
          waiting: {
            appointmentId: string;
            planItemsReservedElsewhere: ReservedElsewhere[];
          }[];
        }
      ).waiting.find((w) => w.appointmentId === today.id)!;
      expect(waiting.planItemsReservedElsewhere).toEqual([expected]);

      // «Traer a esta cita».
      const claimed = await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
        undefined,
        reception,
      ).expect(200);
      expect(
        (claimed.body as { id: string; planItemsReservedElsewhere: unknown[] })
          .planItemsReservedElsewhere,
      ).toEqual([]);
      expect(await links(today.id)).toEqual([
        { planItemId: itemId, active: true, deletedAt: null },
      ]);
      const futureLinks = await links(futureId);
      expect(futureLinks).toHaveLength(1);
      expect(futureLinks[0].active).toBe(false);
      expect(futureLinks[0].deletedAt).toBeInstanceOf(Date);
      for (const id of [today.id, futureId]) {
        const [event] = await events(id, 'APPOINTMENT_PLAN_ITEMS');
        expect(event).toMatchObject({
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          actorUserId: receptionUserId,
          patientId,
        });
        expect(event.metadata).toEqual({
          reason: 'APPOINTMENT_PLAN_ITEMS',
          changedFields: ['planItemIds'],
          params: {
            planItemId: itemId,
            fromAppointmentId: futureId,
            toAppointmentId: today.id,
          },
        });
      }
      // La futura ya no lo reserva: sale del panel y de la cita futura.
      const future = await call(
        'get',
        `/appointments/${futureId}`,
        undefined,
        reception,
      ).expect(200);
      expect((future.body as { planItemIds: string[] }).planItemIds).toEqual(
        [],
      );
      // Repetirlo no cambia nada (ya lo reserva).
      await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
        undefined,
        reception,
      ).expect(200);
      expect(await events(today.id, 'APPOINTMENT_PLAN_ITEMS')).toHaveLength(1);
    });

    it('cancelar la cita que lo reservaba devuelve la reserva a la cita en la clínica (la más temprana), auditado', async () => {
      const {
        planId,
        ids: [itemId],
      } = await acceptedItems(1);
      await accept(planId);
      // Dos citas de hoy en la clínica con el ítem sin reserva; la futura lo tiene.
      const later = await todayAppointment();
      const earlier = await todayAppointment();
      expect(earlier.start.getTime()).toBeLessThan(later.start.getTime());
      await rawLink(later.id, itemId);
      await rawLink(earlier.id, itemId);
      const future = await rawAppointment(inDays(8));
      await rawLink(future.id, itemId);
      for (const id of [later.id, earlier.id])
        await call(
          'patch',
          `/appointments/${id}`,
          { status: 'ARRIVED' },
          reception,
        ).expect(200);
      expect((await links(earlier.id))[0].active).toBe(false);

      await call(
        'patch',
        `/appointments/${future.id}`,
        { status: 'CANCELLED', ...STAFF_CANCELLATION },
        reception,
      ).expect(200);
      // En la misma transacción: la más temprana en la clínica lo reserva.
      expect(await links(earlier.id)).toEqual([
        { planItemId: itemId, active: true, deletedAt: null },
      ]);
      expect((await links(later.id))[0].active).toBe(false);
      const [event] = await events(
        earlier.id,
        'PLAN_ITEM_RESERVATION_RECOVERED',
      );
      expect(event).toMatchObject({
        resourceType: 'APPOINTMENT',
        actorUserId: receptionUserId,
        patientId,
        locationId,
      });
      expect(event.metadata).toEqual({
        reason: 'PLAN_ITEM_RESERVATION_RECOVERED',
        params: {
          planItemId: itemId,
          fromAppointmentId: future.id,
          toAppointmentId: earlier.id,
        },
      });
      // La otra cita en la clínica ahora ve la reserva en la más temprana.
      const panel = await call(
        'get',
        '/appointments/in-clinic',
        undefined,
        reception,
      )
        .set('X-Location-Id', locationId)
        .expect(200);
      const waiting = (
        panel.body as {
          waiting: {
            appointmentId: string;
            planItemsReservedElsewhere: { appointmentId: string }[];
          }[];
        }
      ).waiting;
      expect(
        waiting
          .find((w) => w.appointmentId === later.id)!
          .planItemsReservedElsewhere.map((r) => r.appointmentId),
      ).toEqual([earlier.id]);
      expect(
        waiting.find((w) => w.appointmentId === earlier.id)!
          .planItemsReservedElsewhere,
      ).toEqual([]);
      // «Traer a esta cita» en la que ya la tiene: no cambia nada.
      await call(
        'post',
        `/appointments/${earlier.id}/plan-items/${itemId}/claim`,
        undefined,
        reception,
      ).expect(200);
      expect(await events(earlier.id, 'APPOINTMENT_PLAN_ITEMS')).toEqual([]);
    });

    it('quitar el ítem de la cita futura (planItemIds) también devuelve la reserva; completar la futura no', async () => {
      const {
        planId,
        ids: [itemId, otherId],
      } = await acceptedItems(2);
      await accept(planId);
      const today = await todayAppointment();
      await rawLink(today.id, itemId);
      await rawLink(today.id, otherId);
      const future = await rawAppointment(inDays(11));
      await rawLink(future.id, itemId);
      await rawLink(future.id, otherId);
      await call(
        'patch',
        `/appointments/${today.id}`,
        { status: 'ARRIVED' },
        reception,
      ).expect(200);
      await call(
        'patch',
        `/appointments/${future.id}`,
        { planItemIds: [otherId] },
        reception,
      ).expect(200);
      const byItem = async () =>
        Object.fromEntries(
          (await links(today.id)).map((l) => [l.planItemId, l.active]),
        );
      expect(await byItem()).toEqual({ [itemId]: true, [otherId]: false });
      // La futura se completa (se hizo allí): no se devuelve a hoy.
      await call('patch', `/appointments/${future.id}`, {
        status: 'COMPLETED',
      }).expect(200);
      expect(await byItem()).toEqual({ [itemId]: true, [otherId]: false });
    });

    it('«Traer a esta cita» y el aviso solo con tratamiento aceptado de un plan aceptado (409 como el alta)', async () => {
      const {
        planId,
        ids: [itemId],
      } = await acceptedItems(1);
      await accept(planId);
      const today = await todayAppointment();
      await rawLink(today.id, itemId);
      const future = await rawAppointment(inDays(12));
      await rawLink(future.id, itemId);
      await call(
        'patch',
        `/appointments/${today.id}`,
        { status: 'ARRIVED' },
        reception,
      ).expect(200);
      await raw.treatmentPlan.update({
        where: { id: planId },
        data: { status: 'CANCELLED' },
      });
      const panel = await call(
        'get',
        '/appointments/in-clinic',
        undefined,
        reception,
      )
        .set('X-Location-Id', locationId)
        .expect(200);
      expect(
        (
          panel.body as {
            waiting: {
              appointmentId: string;
              planItemsReservedElsewhere: unknown[];
            }[];
          }
        ).waiting.find((w) => w.appointmentId === today.id)!
          .planItemsReservedElsewhere,
      ).toEqual([]);
      const res = await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
        undefined,
        reception,
      ).expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Solo se agenda tratamiento aceptado y pendiente de un plan aceptado.',
      );
      expect((await links(future.id))[0]).toMatchObject({
        active: true,
        deletedAt: null,
      });
      expect(await events(today.id, 'APPOINTMENT_PLAN_ITEMS')).toEqual([]);
    });

    it('dos «Traer a esta cita» a la vez del mismo tratamiento: uno gana y el otro recibe 409', async () => {
      const {
        planId,
        ids: [itemId],
      } = await acceptedItems(1);
      await accept(planId);
      const first = await todayAppointment();
      const second = await todayAppointment();
      await rawLink(first.id, itemId);
      await rawLink(second.id, itemId);
      const future = await rawAppointment(inDays(13));
      await rawLink(future.id, itemId);
      for (const id of [first.id, second.id])
        await call(
          'patch',
          `/appointments/${id}`,
          { status: 'ARRIVED' },
          reception,
        ).expect(200);
      const results = await Promise.all(
        [first.id, second.id].map((id) =>
          call(
            'post',
            `/appointments/${id}/plan-items/${itemId}/claim`,
            undefined,
            reception,
          ),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const active = [
        ...(await links(first.id)),
        ...(await links(second.id)),
        ...(await links(future.id)),
      ].filter((l) => l.active);
      expect(active).toHaveLength(1);
      const winner = results[0].status === 200 ? first.id : second.id;
      expect((await links(winner))[0].active).toBe(true);
    });

    describe('DX-288 «Traer a esta cita» atómico', () => {
      /**
       * Cada escenario con su paciente y su profesional (las EXCLUDE de
       * solape son por los dos), así sus citas de hoy caben justo antes de
       * «ahora» sin chocar con las de `todayAppointment`. La regla es del
       * mismo día civil de la sede (revisión M1): las citas en la clínica son
       * de hoy y ya empezaron (el vínculo nace sin reserva).
       */
      let scenario = 0;
      const freshScenario = async () => {
        const n = scenario++;
        const patient = await raw.patient.create({
          data: {
            tenantId: a.tenantId,
            firstName: 'Rosa',
            lastName: `Carrera ${n}`,
          },
        });
        const provider = await raw.user.create({
          data: {
            email: `dx288-${n}@dx273-e2e.test`,
            passwordHash: 'x',
            fullName: `Doctora ${n}`,
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
          data: {
            tenantId: a.tenantId,
            patientId: patient.id,
            currency: 'COP',
          },
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
        await accept(plan.id);
        let minutesAgo = 0;
        const base = Date.now() - 30_000;
        const book = async (start: Date, minutes = 1) => {
          const appointment = await raw.appointment.create({
            data: {
              tenantId: a.tenantId,
              locationId,
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
        /** Cita de hoy, de 1 min, que ya empezó (sin reserva). */
        const startedToday = () => book(new Date(base - ++minutesAgo * MIN));
        return { itemId, book, startedToday };
      };
      const markArrived = (ids: string[]) =>
        raw.appointment.updateMany({
          where: { id: { in: ids } },
          data: {
            status: 'ARRIVED',
            arrivedAt: new Date(),
            preArrivalStatus: 'SCHEDULED',
          },
        });
      /**
       * `n` citas de hoy con el paciente en la clínica, con el vínculo del
       * ítem sin reserva, y una futura que lo reserva.
       */
      const inClinicWithHolder = async (n: number) => {
        const { itemId, book, startedToday } = await freshScenario();
        const starts = new Map<string, Date>();
        for (let i = 0; i < n; i++) {
          const appointment = await startedToday();
          starts.set(appointment.id, appointment.start);
        }
        const inClinic = [...starts.keys()];
        const future = await book(inDays(15), 30);
        await markArrived(inClinic);
        return { itemId, inClinic, starts, futureId: future.id };
      };
      /** El 409 de la revisión M1: dice la hora y la sede de la titular. */
      const heldBy = (start: Date) =>
        heldInClinicMessage({ start, timeZone: ZONE, locationName });
      const claim = (appointmentId: string, itemId: string) =>
        call(
          'post',
          `/appointments/${appointmentId}/plan-items/${itemId}/claim`,
          undefined,
          reception,
        );
      const activeLinks = (itemId: string) =>
        raw.appointmentPlanItem.findMany({
          where: { planItemId: itemId, active: true, deletedAt: null },
          select: { appointmentId: true },
        });
      const moveEvents = (itemId: string) =>
        raw.auditEvent.findMany({
          where: {
            tenantId: a.tenantId,
            action: 'UPDATE',
            metadata: { path: ['params', 'planItemId'], equals: itemId },
          },
          select: { resourceId: true, metadata: true },
        });

      it('10 «Traer a esta cita» a la vez desde 10 citas en la clínica: una 200, nueve 409 en español, ninguna 500; una sola reserva y un solo traslado auditado', async () => {
        const { itemId, inClinic, starts, futureId } =
          await inClinicWithHolder(10);
        const results = await Promise.all(
          inClinic.map((id) => claim(id, itemId)),
        );
        const statuses = results.map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(statuses.filter((s) => s === 409)).toHaveLength(9);
        const winner = inClinic[statuses.indexOf(200)];
        // Las nueve: el 409 de la titular en la clínica, con su hora y sede.
        for (const r of results.filter((x) => x.status === 409))
          expect((r.body as { message: string }).message).toBe(
            heldBy(starts.get(winner)!),
          );
        expect(await activeLinks(itemId)).toEqual([{ appointmentId: winner }]);
        // La titular anterior pierde la suya (vínculo retirado).
        const [futureLink] = await links(futureId);
        expect(futureLink.active).toBe(false);
        expect(futureLink.deletedAt).toBeInstanceOf(Date);
        // Un solo traslado: un evento en la destino y otro en la de origen.
        const audit = await moveEvents(itemId);
        expect(audit.map((e) => e.resourceId).sort()).toEqual(
          [winner, futureId].sort(),
        );
        for (const e of audit)
          expect(e.metadata).toMatchObject({
            params: { fromAppointmentId: futureId, toAppointmentId: winner },
          });
      });

      it('la reserva ya traída a una cita en la clínica no se la lleva otra cita en la clínica después (409, sin traslado)', async () => {
        const {
          itemId,
          inClinic: [first, second],
          starts,
          futureId,
        } = await inClinicWithHolder(2);
        await claim(first, itemId).expect(200);
        const res = await claim(second, itemId).expect(409);
        expect((res.body as { message: string }).message).toBe(
          heldBy(starts.get(first)!),
        );
        expect(await activeLinks(itemId)).toEqual([{ appointmentId: first }]);
        expect((await links(second))[0]).toMatchObject({
          active: false,
          deletedAt: null,
        });
        expect(
          (await moveEvents(itemId)).map((e) => e.resourceId).sort(),
        ).toEqual([first, futureId].sort());
      });

      it('sin titular (la futura se canceló por la BD): 10 a la vez desde 10 citas en la clínica, una 200 y nueve 409; una sola reserva', async () => {
        const { itemId, inClinic, starts, futureId } =
          await inClinicWithHolder(10);
        await raw.appointment.update({
          where: { id: futureId },
          data: { status: 'CANCELLED' },
        });
        expect(await activeLinks(itemId)).toEqual([]);
        const results = await Promise.all(
          inClinic.map((id) => claim(id, itemId)),
        );
        const statuses = results.map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        const winner = inClinic[statuses.indexOf(200)];
        for (const r of results.filter((x) => x.status !== 200)) {
          expect(r.status).toBe(409);
          expect((r.body as { message: string }).message).toBe(
            heldBy(starts.get(winner)!),
          );
        }
        expect(await activeLinks(itemId)).toEqual([{ appointmentId: winner }]);
      });

      it('una cita «olvidada» en la clínica de un día anterior no bloquea: se trae normalmente (revisión M1)', async () => {
        const { itemId, book, startedToday } = await freshScenario();
        const today = await startedToday();
        const forgotten = await book(new Date(Date.now() - 5 * DAY));
        // La olvidada «llegó» (hace 5 días) y se quedó con la reserva.
        await markArrived([forgotten.id]);
        expect(await activeLinks(itemId)).toEqual([
          { appointmentId: forgotten.id },
        ]);
        await markArrived([today.id]);
        expect(await activeLinks(itemId)).toEqual([
          { appointmentId: forgotten.id },
        ]);
        await claim(today.id, itemId).expect(200);
        expect(await activeLinks(itemId)).toEqual([
          { appointmentId: today.id },
        ]);
        expect((await links(forgotten.id))[0].deletedAt).toBeInstanceOf(Date);
      });

      it('doble clic: 10 «Traer a esta cita» a la vez desde la MISMA cita, todas 200 (idempotente) y un solo traslado', async () => {
        const {
          itemId,
          inClinic: [only],
          futureId,
        } = await inClinicWithHolder(1);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => claim(only, itemId)),
        );
        expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
        expect(await activeLinks(itemId)).toEqual([{ appointmentId: only }]);
        expect(
          (await moveEvents(itemId)).map((e) => e.resourceId).sort(),
        ).toEqual([only, futureId].sort());
      });
    });

    it('«Traer a esta cita»: 409 si la cita no está en la clínica, 404 si el tratamiento no es de la cita o la cita es de otra clínica', async () => {
      const {
        planId,
        ids: [itemId, otherItem],
      } = await acceptedItems(2);
      await accept(planId);
      const scheduled = await rawAppointment(inDays(3));
      await rawLink(scheduled.id, itemId);
      const notInClinic = await call(
        'post',
        `/appointments/${scheduled.id}/plan-items/${itemId}/claim`,
      ).expect(409);
      expect((notInClinic.body as { message: string }).message).toBe(
        'Solo se trae un tratamiento a una cita con el paciente en la clínica (llegó, en sillón o listo para cobrar).',
      );
      const today = await todayAppointment();
      await call('patch', `/appointments/${today.id}`, {
        status: 'ARRIVED',
      }).expect(200);
      const notLinked = await call(
        'post',
        `/appointments/${today.id}/plan-items/${otherItem}/claim`,
      ).expect(404);
      expect((notLinked.body as { message: string }).message).toBe(
        'Este tratamiento no está en esta cita.',
      );
      await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
        undefined,
        b.adminToken,
        b,
      ).expect(404);
      await call(
        'post',
        `/appointments/${today.id}/plan-items/not-a-uuid/claim`,
      ).expect(400);
      expect(await links(scheduled.id)).toEqual([
        { planItemId: itemId, active: true, deletedAt: null },
      ]);
    });

    // Al final: restringe a recepción a la sede principal.
    it('una reserva en una sede no permitida no se enseña ni se puede traer (DX-089)', async () => {
      const {
        planId,
        ids: [itemId],
      } = await acceptedItems(1);
      await accept(planId);
      const north = await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId: a.tenantId,
          name: 'Sede Norte DX273',
        }),
      });
      const today = await todayAppointment();
      await rawLink(today.id, itemId);
      const holder = await rawAppointment(inDays(9), 'SCHEDULED', north.id);
      await rawLink(holder.id, itemId);
      await call('put', `/staff/${receptionUserId}/locations`, {
        locationIds: [locationId],
      }).expect(200);
      const restricted = await loginAs(app, a.host, receptionEmail);
      const arrived = await call(
        'patch',
        `/appointments/${today.id}`,
        { status: 'ARRIVED' },
        restricted,
      ).expect(200);
      expect(
        (arrived.body as { planItemsReservedElsewhere: unknown[] })
          .planItemsReservedElsewhere,
      ).toEqual([]);
      expect(JSON.stringify(arrived.body)).not.toContain('Norte');
      expect(JSON.stringify(arrived.body)).not.toContain(holder.id);
      // Quien ve las dos sedes sí lo ve.
      const admin = await call('get', '/appointments/in-clinic')
        .set('X-Location-Id', locationId)
        .expect(200);
      expect(
        (
          admin.body as {
            waiting: {
              appointmentId: string;
              planItemsReservedElsewhere: ReservedElsewhere[];
            }[];
          }
        ).waiting
          .find((w) => w.appointmentId === today.id)!
          .planItemsReservedElsewhere.map((r) => r.appointmentId),
      ).toEqual([holder.id]);
      const res = await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
        undefined,
        restricted,
      ).expect(403);
      expect((res.body as { message: string }).message).not.toContain('Norte');
      expect(await links(holder.id)).toEqual([
        { planItemId: itemId, active: true, deletedAt: null },
      ]);

      // La cita destino en una sede no permitida: 403 (DX-089/SEC-045).
      const {
        planId: northPlan,
        ids: [northItem],
      } = await acceptedItems(1);
      await accept(northPlan);
      const northToday = await todayAppointment(north.id);
      await rawLink(northToday.id, northItem);
      await raw.appointment.update({
        where: { id: northToday.id },
        data: {
          status: 'ARRIVED',
          arrivedAt: new Date(),
          preArrivalStatus: 'SCHEDULED',
        },
      });
      await call(
        'post',
        `/appointments/${northToday.id}/plan-items/${northItem}/claim`,
        undefined,
        restricted,
      ).expect(403);

      // Quien ve las dos sedes la trae: el evento de la cita de origen va en
      // la sede de esa cita (Norte), el de la destino en la suya.
      await call(
        'post',
        `/appointments/${today.id}/plan-items/${itemId}/claim`,
      ).expect(200);
      const [fromEvent] = await events(holder.id, 'APPOINTMENT_PLAN_ITEMS');
      expect(fromEvent.locationId).toBe(north.id);
      const [toEvent] = await events(today.id, 'APPOINTMENT_PLAN_ITEMS');
      expect(toEvent.locationId).toBe(locationId);
    });
  });
});
