import { ConflictException } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { heldInClinicMessage } from '../src/modules/appointments/domain/plan-item-reservation';
import { regionalFormat } from '../src/shared/format/regional-format';
import { resetDatabase } from './support/e2e-fixtures';
import { locationData } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

/**
 * DX-288: «Traer a esta cita» (DX-273) es atómico. Con varias peticiones de
 * traer el mismo tratamiento desde citas distintas con el paciente en la
 * clínica, una sola lo trae: las demás reciben 409 (nunca 500) tanto si
 * llegan a la vez (cada una en su conexión, esperando el mismo bloqueo) como
 * si llegan después de que la primera confirmó. Antes, la que llegaba tarde
 * (lo normal con la máquina cargada) se lo quitaba a la primera: dos 200.
 * Repositorio real sobre Postgres; `owner` (DIRECT_URL) siembra y comprueba.
 */
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const repo = new PrismaAppointmentRepository(prisma, context);
const MIN = 60000;
/**
 * DX-449: Bogotá salvo cerca de su medianoche, cuando las sedes pasan a una
 * zona donde ahora es mediodía: las citas «de hoy que ya empezaron» son de hoy
 * a cualquier hora de la CI.
 */
const SEDE = sedeTodayFixture();
const ZONE = SEDE.timeZone;
const DAY = 86400000;

describe('DX-288 «Traer a esta cita» con peticiones concurrentes (int)', () => {
  let tenantId: string,
    locationId: string,
    providerId: string,
    catalogItemId: string;

  const audit = () => ({
    tenantId,
    locationId,
    actor: { userId: providerId, role: ClinicRole.RECEPTION },
    requestId: null,
    ip: null,
    userAgent: null,
  });
  const claim = (
    appointmentId: string,
    itemId: string,
    allowedLocationIds?: readonly string[],
  ) =>
    context.run(
      tenantId,
      undefined,
      () => repo.claimPlanItem(appointmentId, itemId, audit()),
      allowedLocationIds,
    );
  /**
   * Cada escenario con su paciente, su profesional y su ítem (las EXCLUDE de
   * solape son por paciente y por profesional): sus citas de hoy caben justo
   * antes de «ahora». La regla es del mismo día civil de la sede (revisión
   * M1), así que las citas en la clínica son de hoy y ya empezaron (el
   * vínculo nace sin reserva).
   */
  let scenarios = 0;
  const scenario = async () => {
    const n = scenarios++;
    const patient = (
      await owner.patient.create({
        data: { tenantId, firstName: 'Rosa', lastName: `Carrera ${n}` },
      })
    ).id;
    const provider = (
      await owner.user.create({
        data: {
          email: `dx288-int-${n}@example.com`,
          passwordHash: 'x',
          fullName: `Doctora ${n}`,
        },
      })
    ).id;
    const plan = (
      await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId: patient,
          status: 'ACCEPTED',
          currency: 'COP',
          acceptedAt: new Date(),
          acceptedLocationId: locationId,
        },
      })
    ).id;
    const itemId = (
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId: plan,
          catalogItemId,
          toothNumber: '46',
          price: 100,
          status: 'ACCEPTED',
        },
      })
    ).id;
    let minutesAgo = 0;
    const base = Date.now() - 30_000;
    const book = async (start: Date, minutes = 1, location = locationId) => {
      const id = (
        await owner.appointment.create({
          data: {
            tenantId,
            patientId: patient,
            providerId: provider,
            locationId: location,
            start,
            end: new Date(start.getTime() + minutes * MIN),
          },
        })
      ).id;
      await owner.appointmentPlanItem.create({
        data: {
          tenantId,
          patientId: patient,
          appointmentId: id,
          planItemId: itemId,
        },
      });
      return id;
    };
    /** Cita de hoy, de 1 min, que ya empezó (sin reserva). */
    const startedToday = (location = locationId) =>
      book(new Date(base - ++minutesAgo * MIN), 1, location);
    const future = () => book(new Date(Date.now() + 7 * DAY), 30);
    return { itemId, startedToday, future };
  };
  const markArrived = (ids: string[]) =>
    owner.appointment.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'ARRIVED',
        arrivedAt: new Date(),
        preArrivalStatus: 'SCHEDULED',
      },
    });
  /**
   * `n` citas de hoy con el paciente en la clínica, con el vínculo del ítem
   * sin reserva, y una futura que lo reserva (lo que deja «Llegó», DX-271).
   */
  const inClinicWithHolder = async (n: number) => {
    const { itemId, startedToday, future } = await scenario();
    const inClinic: string[] = [];
    for (let i = 0; i < n; i++) inClinic.push(await startedToday());
    const futureId = await future();
    await markArrived(inClinic);
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
      await owner.location.create({
        data: locationData(SEDE, {
          tenantId,
          name: 'Principal',
        }),
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
    // Revisión M1: dice la hora y la sede de la cita que lo tiene.
    const { start } = await owner.appointment.findUniqueOrThrow({
      where: { id: first },
    });
    expect((late as ConflictException).message).toBe(
      heldInClinicMessage({
        start,
        timeZone: ZONE,
        locationName: 'Principal',
        fmt: regionalFormat(SEDE),
      }),
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

  it('sin titular (la futura se canceló): diez a la vez desde diez citas en la clínica, el bloqueo del ítem las pone en fila: una lo trae y nueve 409', async () => {
    const { itemId, inClinic, futureId } = await inClinicWithHolder(10);
    await owner.appointment.update({
      where: { id: futureId },
      data: { status: 'CANCELLED' },
    });
    expect(await activeHolders(itemId)).toEqual([]);
    const outcomes = await settle(inClinic.map((id) => claim(id, itemId)));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    const winner = inClinic[outcomes.indexOf('ok')];
    const { start } = await owner.appointment.findUniqueOrThrow({
      where: { id: winner },
    });
    for (const o of outcomes.filter((x) => x !== 'ok')) {
      expect(o).toBeInstanceOf(ConflictException);
      expect((o as ConflictException).message).toBe(
        heldInClinicMessage({
          start,
          timeZone: ZONE,
          locationName: 'Principal',
          fmt: regionalFormat(SEDE),
        }),
      );
    }
    expect(await activeHolders(itemId)).toEqual([winner]);
  });

  it('la que gana es de una sede no permitida a quien llega después: 409 general, sin su hora ni su sede (DX-089, revisión B2)', async () => {
    const norte = (
      await owner.location.create({
        data: locationData(SEDE, {
          tenantId,
          name: 'Sede Norte',
        }),
      })
    ).id;
    const { itemId, startedToday, future } = await scenario();
    const mine = await startedToday();
    const theirs = await startedToday(norte);
    // Una futura lo reserva mientras «llegan» y después se cancela por la
    // BD: nadie lo reserva y las dos lo tienen sin reserva.
    const futureId = await future();
    await markArrived([mine, theirs]);
    await owner.appointment.update({
      where: { id: futureId },
      data: { status: 'CANCELLED' },
    });
    expect(await activeHolders(itemId)).toEqual([]);
    // La mía lee «sin titular» y espera su propia cita; la de Norte lo trae.
    const lock = await holdLock(mine);
    const late = claim(mine, itemId, [locationId]).catch((e: unknown) => e);
    await waitForLockWaiters(1);
    await claim(theirs, itemId);
    lock.release();
    await lock.done;
    const outcome = await late;
    expect(outcome).toBeInstanceOf(ConflictException);
    expect((outcome as ConflictException).message).toBe(
      heldInClinicMessage(null),
    );
    expect((outcome as ConflictException).message).not.toContain('Norte');
    expect(await activeHolders(itemId)).toEqual([theirs]);
  });
});
