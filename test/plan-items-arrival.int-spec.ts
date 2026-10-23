import { AppointmentStatus, Prisma, PrismaClient } from '@prisma/client';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { resetDatabase } from './support/e2e-fixtures';

/**
 * DX-271 (BE-038, BE-039): la sincronización de reservas al cambiar el estado
 * de la cita no falla si el ítem ya está reservado en otra cita viva (lo deja
 * allí), pero el alta explícita del vínculo, reactivar y reagendar siguen
 * chocando con `appointment_plan_items_active_key`. Y la BD no deja retirar el
 * vínculo de una cita COMPLETED (ERRCODE propio DX271).
 */
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const MIN = 60000;
const DAY = 86400000;

describe('DX-271 triggers de reserva de ítems', () => {
  let tenantId: string,
    patientId: string,
    locationId: string,
    providerId: string,
    itemId: string;
  const asApp = <T>(f: (tx: Prisma.TransactionClient) => Promise<T>) =>
    context.run(tenantId, () => prisma.runWithTenant(f));
  let slot = 0;
  const appointment = async (
    start: Date,
    status: AppointmentStatus = 'SCHEDULED',
  ) => {
    // Cada cita en un hueco propio (EXCLUDE por profesional y paciente).
    // Hacia el pasado si la cita es pasada: no cruza «ahora».
    const shift = slot++ * 31 * MIN;
    const s = new Date(
      start.getTime() + (start.getTime() < Date.now() ? -shift : shift),
    );
    return (
      await owner.appointment.create({
        data: {
          tenantId,
          patientId,
          providerId,
          locationId,
          start: s,
          end: new Date(s.getTime() + 30 * MIN),
          status,
        },
      })
    ).id;
  };
  const link = (appointmentId: string, planItemId = itemId) =>
    asApp((tx) =>
      tx.appointmentPlanItem.create({
        data: { tenantId, patientId, appointmentId, planItemId },
      }),
    );
  const active = async (appointmentId: string, planItemId = itemId) =>
    (
      await owner.appointmentPlanItem.findUniqueOrThrow({
        where: {
          tenantId_appointmentId_planItemId: {
            tenantId,
            appointmentId,
            planItemId,
          },
        },
      })
    ).active;
  // Con las horas del flujo que exige `appointments_flow_times_check` (DX-200).
  const FLOW_TIMES: Partial<Record<AppointmentStatus, object>> = {
    ARRIVED: { arrivedAt: new Date() },
    IN_CHAIR: { seatedAt: new Date() },
    READY_FOR_CHECKOUT: { readyForCheckoutAt: new Date() },
  };
  const setStatus = (id: string, status: AppointmentStatus) =>
    asApp((tx) =>
      tx.appointment.update({
        where: { id },
        data: {
          status,
          preArrivalStatus: status === 'ARRIVED' ? 'SCHEDULED' : null,
          ...FLOW_TIMES[status],
        },
      }),
    );
  const newItem = async () => {
    const source = await owner.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    return (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId: source.planId,
          catalogItemId: source.catalogItemId,
          toothNumber: '47',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
  };

  beforeAll(async () => {
    await resetDatabase(owner);
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Llegada int', subdomain: 'dx271-int' },
      })
    ).id;
    locationId = (
      await owner.location.create({ data: { tenantId, name: 'Principal' } })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Luis', lastName: 'Tarde' },
      })
    ).id;
    providerId = (
      await owner.user.create({
        data: {
          email: 'dx271-int@example.com',
          passwordHash: 'x',
          fullName: 'Doctor',
        },
      })
    ).id;
    const catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          kind: 'PROCEDURE',
          code: 'DX271',
          labelEs: 'Resina',
          color: '#123456',
        },
      })
    ).id;
    const planId = (
      await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId,
          status: 'ACCEPTED',
          currency: 'COP',
          acceptedAt: new Date(),
          acceptedLocationId: locationId,
        },
      })
    ).id;
    itemId = (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId,
          catalogItemId,
          toothNumber: '46',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('el cambio de estado no reactiva un vínculo que choca: la reserva se queda en la cita futura', async () => {
    // A: hoy, empezó hace 20 min y el paciente no ha llegado (reserva vencida).
    const late = await appointment(new Date(Date.now() - 20 * MIN));
    await link(late);
    expect(await active(late)).toBe(false);
    // B: la semana que viene, reserva el ítem.
    const future = await appointment(new Date(Date.now() + 7 * DAY));
    await link(future);
    expect(await active(future)).toBe(true);
    // Llega tarde: ni «Llegó» ni los pasos siguientes lanzan excepción.
    await expect(setStatus(late, 'ARRIVED')).resolves.toBeDefined();
    expect(await active(late)).toBe(false);
    expect(await active(future)).toBe(true);
    await expect(setStatus(late, 'IN_CHAIR')).resolves.toBeDefined();
    await expect(setStatus(late, 'READY_FOR_CHECKOUT')).resolves.toBeDefined();
    await expect(setStatus(late, 'COMPLETED')).resolves.toBeDefined();
    expect(await active(late)).toBe(false);
    expect(await active(future)).toBe(true);
    // Lo libera sigue funcionando: cancelar B lo deja sin reserva.
    await setStatus(future, 'CANCELLED');
    expect(await active(future)).toBe(false);
  });

  it('sin conflicto, «Llegó» sí activa la reserva de la cita en curso', async () => {
    const other = await newItem();
    const late = await appointment(new Date(Date.now() - 15 * MIN));
    await link(late, other);
    expect(await active(late, other)).toBe(false);
    await setStatus(late, 'ARRIVED');
    expect(await active(late, other)).toBe(true);
    await setStatus(late, 'CANCELLED');
    expect(await active(late, other)).toBe(false);
  });

  it('la inserción explícita, reactivar y reagendar sí chocan con la reserva', async () => {
    const item = await newItem();
    const future = await appointment(new Date(Date.now() + 10 * DAY));
    await link(future, item);
    expect(await active(future, item)).toBe(true);
    // Alta explícita del vínculo en otra cita futura.
    const another = await appointment(new Date(Date.now() + 12 * DAY));
    await expect(link(another, item)).rejects.toMatchObject({ code: 'P2002' });
    // Reactivar una cita cancelada que lo tenía.
    const cancelled = await appointment(
      new Date(Date.now() + 14 * DAY),
      'CANCELLED',
    );
    await link(cancelled, item);
    expect(await active(cancelled, item)).toBe(false);
    await expect(setStatus(cancelled, 'SCHEDULED')).rejects.toMatchObject({
      code: 'P2002',
    });
    // Reagendar al futuro una cita vencida que lo tenía.
    const stale = await appointment(new Date(Date.now() - 2 * DAY));
    await link(stale, item);
    const start = new Date(Date.now() + 20 * DAY);
    await expect(
      asApp((tx) =>
        tx.appointment.update({
          where: { id: stale },
          data: { start, end: new Date(start.getTime() + 30 * MIN) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await active(future, item)).toBe(true);
    await setStatus(future, 'CANCELLED');
  });

  it('la BD no deja retirar el vínculo de una cita COMPLETED (DX271); de una agendada, sí', async () => {
    const other = await newItem();
    const done = await appointment(new Date(Date.now() - 3 * DAY));
    await link(done, other);
    await owner.appointment.update({
      where: { id: done },
      data: { status: 'COMPLETED' },
    });
    const retire = (appointmentId: string) =>
      asApp((tx) =>
        tx.appointmentPlanItem.update({
          where: {
            tenantId_appointmentId_planItemId: {
              tenantId,
              appointmentId,
              planItemId: other,
            },
          },
          data: { deletedAt: new Date() },
        }),
      );
    await expect(retire(done)).rejects.toThrow(/DX271/);
    // También como owner de las migraciones (sin RLS que lo esconda).
    await expect(
      owner.appointmentPlanItem.updateMany({
        where: { appointmentId: done },
        data: { deletedAt: new Date() },
      }),
    ).rejects.toThrow(/DX271/);
    expect(
      await owner.appointmentPlanItem.count({
        where: { appointmentId: done, deletedAt: null },
      }),
    ).toBe(1);
    const open = await appointment(new Date(Date.now() + 30 * DAY));
    await link(open, other);
    await expect(retire(open)).resolves.toBeDefined();
  });
});
