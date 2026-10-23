import { ConflictException } from '@nestjs/common';
import { AppointmentStatus, ClinicRole, PrismaClient } from '@prisma/client';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE } from '../src/modules/appointments/domain/plan-item-reservation';
import { resetDatabase } from './support/e2e-fixtures';

/**
 * DX-288: «Traer a esta cita» (DX-273) es atómico. Con varias peticiones de
 * traer el mismo tratamiento desde citas distintas con el paciente en la
 * clínica, una sola lo trae: las demás reciben 409 (nunca 500) tanto si
 * llegan a la vez (cada una en su conexión, esperando el mismo bloqueo) como
 * si llegan después de que la primera confirmó. Antes, la que llegaba tarde
 * (lo normal con la máquina cargada) se lo quitaba a la primera: dos 200.
 * Repositorio real sobre Postgres; `owner` (DIRECT_URL) siembra y comprueba.
 */
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const repo = new PrismaAppointmentRepository(prisma, context);
const MIN = 60000;
const DAY = 86400000;

describe('DX-288 «Traer a esta cita» con peticiones concurrentes (int)', () => {
  let tenantId: string,
    patientId: string,
    locationId: string,
    providerId: string,
    catalogItemId: string,
    planId: string;
  let slot = 0;

  const audit = () => ({
    tenantId,
    locationId,
    actor: { userId: providerId, role: ClinicRole.RECEPTION },
    requestId: null,
    ip: null,
    userAgent: null,
  });
  const claim = (appointmentId: string, itemId: string) =>
    context.run(tenantId, () =>
      repo.claimPlanItem(appointmentId, itemId, audit()),
    );
  const appointment = async (start: Date) =>
    (
      await owner.appointment.create({
        data: {
          tenantId,
          patientId,
          providerId,
          locationId,
          start,
          end: new Date(start.getTime() + 30 * MIN),
          status: AppointmentStatus.SCHEDULED,
        },
      })
    ).id;
  /**
   * `n` citas con el paciente en la clínica, con el vínculo del ítem sin
   * reserva, y una futura que lo reserva (lo que deja «Llegó», DX-271).
   */
  const inClinicWithHolder = async (n: number) => {
    const itemId = (
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
    const inClinic: string[] = [];
    for (let i = 0; i < n; i++) {
      // Pasadas (vínculo sin reserva) y cada una en su hueco (EXCLUDE).
      const id = await appointment(
        new Date(Date.now() - 3 * DAY + slot++ * 40 * MIN),
      );
      await owner.appointmentPlanItem.create({
        data: { tenantId, patientId, appointmentId: id, planItemId: itemId },
      });
      inClinic.push(id);
    }
    const futureId = await appointment(
      new Date(Date.now() + 7 * DAY + slot++ * 40 * MIN),
    );
    await owner.appointmentPlanItem.create({
      data: {
        tenantId,
        patientId,
        appointmentId: futureId,
        planItemId: itemId,
      },
    });
    await owner.appointment.updateMany({
      where: { id: { in: inClinic } },
      data: {
        status: 'ARRIVED',
        arrivedAt: new Date(),
        preArrivalStatus: 'SCHEDULED',
      },
    });
    return { itemId, inClinic, futureId };
  };
  const activeHolders = async (itemId: string) =>
    (
      await owner.appointmentPlanItem.findMany({
        where: { planItemId: itemId, active: true, deletedAt: null },
        select: { appointmentId: true },
      })
    ).map((l) => l.appointmentId);
  const moveEvents = (itemId: string) =>
    owner.auditEvent.findMany({
      where: {
        tenantId,
        metadata: { path: ['params', 'planItemId'], equals: itemId },
      },
      select: { resourceId: true },
    });
  /** Espera a que haya `n` sesiones de esta base esperando un bloqueo. */
  const waitForLockWaiters = async (n: number) => {
    for (let i = 0; i < 200; i++) {
      const [{ waiting }] = await owner.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (waiting >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no llegaron ${n} esperas de bloqueo`);
  };
  /**
   * Abre una transacción (otra conexión) que bloquea FOR UPDATE la cita
   * `appointmentId` y no confirma hasta `release()`: las peticiones que
   * lleguen mientras tanto se quedan esperando en el mismo punto y salen a
   * la vez.
   */
  const holdLock = async (appointmentId: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM appointments WHERE id=${appointmentId}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    return { release, done };
  };
  const settle = (attempts: Promise<unknown>[]) =>
    Promise.all(
      attempts.map((p) =>
        p.then(
          () => 'ok' as const,
          (error: unknown) => error,
        ),
      ),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(owner);
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Traer int', subdomain: 'dx288-int' },
      })
    ).id;
    locationId = (
      await owner.location.create({ data: { tenantId, name: 'Principal' } })
    ).id;
    patientId = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Rosa', lastName: 'Carrera' },
      })
    ).id;
    providerId = (
      await owner.user.create({
        data: {
          email: 'dx288-int@example.com',
          passwordHash: 'x',
          fullName: 'Doctora',
        },
      })
    ).id;
    catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          kind: 'PROCEDURE',
          code: 'DX288',
          labelEs: 'Implante',
          color: '#123456',
        },
      })
    ).id;
    planId = (
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
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  it('la petición que llega cuando la primera ya confirmó no se lleva el tratamiento: 409 en español', async () => {
    const {
      itemId,
      inClinic: [first, second],
      futureId,
    } = await inClinicWithHolder(2);
    await expect(claim(first, itemId)).resolves.toMatchObject({
      fromAppointmentId: futureId,
    });
    const late = await claim(second, itemId).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(ConflictException);
    expect((late as ConflictException).message).toBe(
      PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE,
    );
    expect(await activeHolders(itemId)).toEqual([first]);
    expect((await moveEvents(itemId)).map((e) => e.resourceId).sort()).toEqual(
      [first, futureId].sort(),
    );
  });

  it('dos conexiones esperando el mismo bloqueo salen a la vez: una lo trae y la otra recibe 409', async () => {
    const {
      itemId,
      inClinic: [first, second],
      futureId,
    } = await inClinicWithHolder(2);
    const lock = await holdLock(futureId);
    const attempts = [claim(first, itemId), claim(second, itemId)];
    await waitForLockWaiters(2);
    lock.release();
    await lock.done;
    const outcomes = await settle(attempts);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    const loser = outcomes.find((o) => o !== 'ok');
    expect(loser).toBeInstanceOf(ConflictException);
    const winner = outcomes[0] === 'ok' ? first : second;
    expect(await activeHolders(itemId)).toEqual([winner]);
    expect((await moveEvents(itemId)).map((e) => e.resourceId).sort()).toEqual(
      [winner, futureId].sort(),
    );
  });

  it('diez conexiones a la vez (desde diez citas en la clínica): una lo trae, nueve 409, ninguna otra excepción', async () => {
    const { itemId, inClinic, futureId } = await inClinicWithHolder(10);
    const lock = await holdLock(futureId);
    const attempts = inClinic.map((id) => claim(id, itemId));
    // Las que ya pidieron conexión esperan el bloqueo; las demás, al pool.
    await waitForLockWaiters(2);
    lock.release();
    await lock.done;
    const outcomes = await settle(attempts);
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    for (const o of outcomes.filter((x) => x !== 'ok'))
      expect(o).toBeInstanceOf(ConflictException);
    const winner = inClinic[outcomes.indexOf('ok')];
    expect(await activeHolders(itemId)).toEqual([winner]);
    expect((await moveEvents(itemId)).map((e) => e.resourceId).sort()).toEqual(
      [winner, futureId].sort(),
    );
  });

  it('desde la misma cita (doble clic), a la vez: todas resuelven sin error y hay un solo traslado', async () => {
    const {
      itemId,
      inClinic: [only],
      futureId,
    } = await inClinicWithHolder(1);
    const lock = await holdLock(futureId);
    const attempts = Array.from({ length: 5 }, () => claim(only, itemId));
    await waitForLockWaiters(2);
    lock.release();
    await lock.done;
    expect(await settle(attempts)).toEqual(Array(5).fill('ok'));
    expect(await activeHolders(itemId)).toEqual([only]);
    expect((await moveEvents(itemId)).map((e) => e.resourceId).sort()).toEqual(
      [only, futureId].sort(),
    );
  });
});
