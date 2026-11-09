import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { regionalFormat } from '../src/shared/format/regional-format';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaProviderScheduleRepository } from '../src/modules/provider-schedule/infrastructure/prisma-provider-schedule.repository';
import {
  crossLocationConflictOn,
  weeklyScheduleError,
  type LiveAppointment,
  type ProviderScheduleSnapshot,
} from '../src/modules/provider-schedule/domain/provider-availability';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  holdLock,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-233: el repositorio del horario contra Postgres (rol de la app, RLS):
// reemplazo en blando, excepciones que se reemplazan, y el candado por
// profesional que hace que dos guardados a la vez no se salten la regla de
// «no estar en dos sedes a la vez».
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaProviderScheduleRepository(prisma, tenantContext);
const appointments = new PrismaAppointmentRepository(prisma, tenantContext);

describe('Repositorio del horario de los profesionales (DX-233, int)', () => {
  let tenantId: string;
  let otherTenantId: string;
  let locationA: string;
  let locationB: string;
  const provider = randomUUID();
  const actor = randomUUID();

  beforeAll(async () => {
    await prisma.onModuleInit();
    const t = await raw.tenant.create({
      data: { name: 'Repo horario', subdomain: 'dx233-repo' },
    });
    const o = await raw.tenant.create({
      data: { name: 'Repo horario otra', subdomain: 'dx233-repo-otra' },
    });
    tenantId = t.id;
    otherTenantId = o.id;
    locationA = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, { tenantId, name: 'A' }),
      })
    ).id;
    locationB = (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, { tenantId, name: 'B' }),
      })
    ).id;
  });

  afterAll(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await raw.appointment.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.providerScheduleOverrideRange.deleteMany({ where });
    await raw.providerScheduleOverride.deleteMany({ where });
    await raw.providerScheduleRange.deleteMany({ where });
    await raw.providerSchedule.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const asClinic = <T>(fn: () => Promise<T>, id = tenantId) =>
    tenantContext.run(id, undefined, fn);

  /** Valida como el caso de uso: el semanal nuevo, entero. */
  function validator(
    locations: {
      locationId: string;
      ranges: { weekday: number; startMinute: number; endMinute: number }[];
    }[],
  ) {
    return (current: ProviderScheduleSnapshot) => {
      // Lo guardado en OTRAS sedes cuenta: el guardado concurrente que ya
      // escribió B tiene que verse aquí.
      const others = current.weekly.filter(
        (r) => !locations.some((l) => l.locationId === r.locationId),
      );
      const merged = [
        ...locations,
        ...[...new Set(others.map((r) => r.locationId))].map((locationId) => ({
          locationId,
          ranges: others.filter((r) => r.locationId === locationId),
        })),
      ];
      const error = weeklyScheduleError(
        merged,
        (id) => id,
        () => regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }),
      );
      if (error) throw new BadRequestException(error);
    };
  }

  it('reemplazar el semanal retira en blando lo anterior y deja solo lo nuevo', async () => {
    const first = [
      {
        locationId: locationA,
        timezone: 'America/Caracas',
        ranges: [{ weekday: 1, startMinute: 480, endMinute: 780 }],
      },
    ];
    await asClinic(() =>
      repo.replaceWeekly({
        providerId: provider,
        actorId: actor,
        overridesFrom: '2026-01-01',
        locations: first,
        validate: () => undefined,
      }),
    );
    const change = await asClinic(() =>
      repo.replaceWeekly({
        providerId: provider,
        actorId: actor,
        overridesFrom: '2026-01-01',
        locations: [
          {
            locationId: locationB,
            timezone: 'America/Caracas',
            ranges: [{ weekday: 4, startMinute: 840, endMinute: 1140 }],
          },
        ],
        validate: () => undefined,
      }),
    );
    expect(change.before).toEqual([
      { locationId: locationA, weekday: 1, startMinute: 480, endMinute: 780 },
    ]);
    expect(change.after).toEqual([
      { locationId: locationB, weekday: 4, startMinute: 840, endMinute: 1140 },
    ]);
    const rows = await raw.providerScheduleRange.findMany({
      where: { tenantId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1);
    const schedules = await raw.providerSchedule.findMany({
      where: { tenantId },
    });
    expect(
      schedules.map((s) => [s.locationId, s.deletedAt === null]).sort(),
    ).toEqual(
      [
        [locationA, false],
        [locationB, true],
      ].sort(),
    );
    // Otra clínica no lo ve.
    const seen = await asClinic(
      () =>
        repo.findSnapshots([provider], {
          from: '2026-01-01',
          to: '2026-12-31',
        }),
      otherTenantId,
    );
    expect(seen.get(provider)).toMatchObject({
      configured: false,
      weekly: [],
    });
  });

  it('una excepción por sede y fecha: la segunda reemplaza a la primera', async () => {
    const set = (ranges: { startMinute: number; endMinute: number }[]) =>
      asClinic(() =>
        repo.upsertOverride({
          providerId: provider,
          locationId: locationB,
          date: '2027-01-14',
          ranges,
          note: null,
          actorId: actor,
          validate: (current) => {
            if (
              crossLocationConflictOn(current, locationB, '2027-01-14', ranges)
            ) {
              throw new BadRequestException('solape');
            }
          },
        }),
      );
    const first = await set([]);
    expect(first.before).toBeNull();
    const second = await set([{ startMinute: 540, endMinute: 600 }]);
    expect(second.before?.id).toBe(first.after.id);
    expect(second.after.ranges).toEqual([{ startMinute: 540, endMinute: 600 }]);
    const live = await asClinic(() =>
      repo.listOverrides(provider, { from: '2027-01-01', to: '2027-01-31' }),
    );
    expect(live.map((o) => o.id)).toEqual([second.after.id]);
    expect(
      await asClinic(() => repo.deleteOverride(provider, second.after.id)),
    ).toMatchObject({ id: second.after.id });
    expect(
      await asClinic(() => repo.deleteOverride(provider, second.after.id)),
    ).toBeNull();
  });

  it('dos guardados a la vez que juntos se solaparían entre sedes: uno gana, el otro 400', async () => {
    const other = randomUUID();
    const save = (
      locationId: string,
      startMinute: number,
      endMinute: number,
    ) => {
      const locations = [
        {
          locationId,
          timezone: 'America/Caracas',
          ranges: [{ weekday: 2, startMinute, endMinute }],
        },
      ];
      return asClinic(() =>
        repo.replaceWeekly({
          providerId: other,
          actorId: actor,
          overridesFrom: '2026-01-01',
          // Cada guardado conserva lo que ya hay en la otra sede (como haría
          // un editor que manda solo su columna sobre lo leído).
          locations,
          validate: validator(locations),
        }),
      );
    };
    // Ambos parten de nada; sin el candado, los dos validarían en vacío.
    const results = await Promise.allSettled([
      save(locationA, 480, 780),
      save(locationB, 720, 900),
    ]);
    // Con el candado, el segundo valida DESPUÉS de que el primero escribió,
    // lo ve y recibe 400. Sin él, los dos validarían en vacío y pasarían.
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    const live = await raw.providerScheduleRange.findMany({
      where: { tenantId, providerId: other, deletedAt: null },
    });
    expect(live).toHaveLength(1);
  });
  // DX-267-bis: el recuento de las citas que el horario nuevo deja fuera se
  // hace DENTRO de la transacción del guardado, después de sus candados.
  describe('recuento de citas afectadas bajo candado (DX-267-bis)', () => {
    /** Día futuro fijo (jueves) en la zona de la sede: 15:00–15:30 en Caracas. */
    const DAY = '2031-01-16';
    const START = new Date(`${DAY}T19:00:00.000Z`);
    const END = new Date(`${DAY}T19:30:00.000Z`);
    const FROM = new Date(`${DAY}T04:00:00.000Z`);
    const TO = new Date('2031-01-17T04:00:00.000Z');
    /** Un paciente por cita: el solape del paciente no entra en juego. */
    const newPatient = async () =>
      (
        await raw.patient.create({
          data: { tenantId, firstName: 'Ana', lastName: 'Rondón' },
          select: { id: true },
        })
      ).id;

    /** Inserta y confirma (fuera de la transacción del guardado) una cita. */
    const insertAppointment = async (providerId: string) =>
      raw.appointment.create({
        data: {
          tenantId,
          locationId: locationA,
          patientId: await newPatient(),
          providerId,
          start: START,
          end: END,
        },
        select: { id: true },
      });

    const holdScheduleLock = (providerId: string) =>
      holdLock(raw, (tx) => {
        const key = `dx233:provider-schedule:${tenantId}:${providerId}`;
        return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      });

    const holdAgendaLock = (providerId: string) =>
      holdLock(
        raw,
        (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext(${'dx_agenda_provider:' + tenantId}),
          hashtext(${providerId})
        )`,
      );

    /** Excepción «no trabaja» ese día en la sede A, contando sus citas. */
    const dayOff = (providerId: string, seen: LiveAppointment[][]) =>
      asClinic(() =>
        repo.upsertOverride({
          providerId,
          locationId: locationA,
          date: DAY,
          ranges: [],
          note: null,
          actorId: actor,
          validate: () => undefined,
          checkAppointments: {
            from: FROM,
            to: TO,
            locationId: locationA,
            check: (rows) => {
              seen.push(rows);
            },
          },
        }),
      );

    /** Semanal sin los jueves, contando sus citas desde FROM. */
    const weeklyWithoutThursday = (
      providerId: string,
      seen: { rows: LiveAppointment[]; current: ProviderScheduleSnapshot }[],
    ) =>
      asClinic(() =>
        repo.replaceWeekly({
          providerId,
          actorId: actor,
          overridesFrom: DAY,
          locations: [
            {
              locationId: locationA,
              timezone: 'America/Caracas',
              ranges: [{ weekday: 5, startMinute: 840, endMinute: 1140 }],
            },
          ],
          validate: () => undefined,
          checkAppointments: {
            from: FROM,
            check: (rows, current) => {
              seen.push({ rows, current });
            },
          },
        }),
      );

    it('excepción: una cita confirmada mientras el guardado espera el candado se cuenta', async () => {
      const providerId = randomUUID();
      const held = await holdScheduleLock(providerId);
      const seen: LiveAppointment[][] = [];
      const saving = settle(dayOff(providerId, seen));
      await waitForLockWaiters(raw, [held.pid]);
      const appt = await insertAppointment(providerId);
      held.release();
      await held.done;
      const outcome = await saving;
      expect(outcome.status).toBe('fulfilled');
      expect(seen).toHaveLength(1);
      expect(seen[0].map((a) => a.id)).toEqual([appt.id]);
      expect(seen[0][0]).toMatchObject({
        patientName: 'Ana Rondón',
        visible: true,
      });
    });

    it('semanal: una cita confirmada mientras el guardado espera el candado se cuenta', async () => {
      const providerId = randomUUID();
      const held = await holdScheduleLock(providerId);
      const seen: {
        rows: LiveAppointment[];
        current: ProviderScheduleSnapshot;
      }[] = [];
      const saving = settle(weeklyWithoutThursday(providerId, seen));
      await waitForLockWaiters(raw, [held.pid]);
      const appt = await insertAppointment(providerId);
      held.release();
      await held.done;
      expect((await saving).status).toBe('fulfilled');
      expect(seen.map((s) => s.rows.map((a) => a.id))).toEqual([[appt.id]]);
    });

    it('excepción y semanal a la vez: el segundo cuenta sobre lo que escribió el primero', async () => {
      const providerId = randomUUID();
      const held = await holdScheduleLock(providerId);
      const order: string[] = [];
      const currents: Record<string, ProviderScheduleSnapshot> = {};
      const overrideSeen: LiveAppointment[][] = [];
      const saving = Promise.all([
        settle(
          asClinic(() =>
            repo.upsertOverride({
              providerId,
              locationId: locationA,
              date: DAY,
              ranges: [],
              note: null,
              actorId: actor,
              validate: () => undefined,
              checkAppointments: {
                from: FROM,
                to: TO,
                locationId: locationA,
                check: (rows, current) => {
                  overrideSeen.push(rows);
                  order.push('override');
                  currents.override = current;
                },
              },
            }),
          ),
        ),
        settle(
          weeklyWithoutThursday(providerId, {
            push: ({ current }: { current: ProviderScheduleSnapshot }) => {
              order.push('weekly');
              currents.weekly = current;
              return 0;
            },
          } as unknown as {
            rows: LiveAppointment[];
            current: ProviderScheduleSnapshot;
          }[]),
        ),
      ]);
      await waitForLockWaiters(raw, [held.pid], 2);
      held.release();
      await held.done;
      const outcomes = await saving;
      expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(order).toHaveLength(2);
      if (order[0] === 'override') {
        // El semanal vio la excepción recién guardada.
        expect(currents.weekly.overrides).toEqual([
          expect.objectContaining({ date: DAY, locationId: locationA }),
        ]);
      } else {
        // La excepción vio el semanal recién guardado (viernes).
        expect(currents.override.weekly).toEqual([
          {
            locationId: locationA,
            weekday: 5,
            startMinute: 840,
            endMinute: 1140,
          },
        ]);
      }
    });

    it('opción A: el guardado espera el candado de la agenda; una cita que llega antes se cuenta', async () => {
      const providerId = randomUUID();
      // Se retiene la agenda del profesional. Primero llega la cita (se pone
      // en cola), después el guardado; al soltar, la cita entra y el
      // recuento, que espera detrás, la ve.
      const createPatientId = await newPatient();
      const held = await holdAgendaLock(providerId);
      const creating = settle(
        asClinic(() =>
          appointments.create({
            patientId: createPatientId,
            providerId,
            start: START,
            end: END,
            locationId: locationA,
          }),
        ),
      );
      await waitForLockWaiters(raw, [held.pid], 1);
      const seen: LiveAppointment[][] = [];
      const saving = settle(dayOff(providerId, seen));
      // Sin la opción A el guardado no esperaría aquí: solo hay 1 espera.
      await waitForLockWaiters(raw, [held.pid], 2);
      held.release();
      await held.done;
      const created = await creating;
      expect(created.status).toBe('fulfilled');
      expect((await saving).status).toBe('fulfilled');
      expect(seen).toHaveLength(1);
      if (created.status !== 'fulfilled') throw created.reason;
      expect(seen[0].map((a) => a.id)).toEqual([created.value.id]);
    });
  });
});
