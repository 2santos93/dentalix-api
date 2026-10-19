import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { AppointmentStatus, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaScheduleBlockRepository } from '../src/modules/schedule-blocks/infrastructure/repositories/prisma-schedule-block.repository';
import { PrismaLocationRepository } from '../src/modules/locations/infrastructure/repositories/prisma-location.repository';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { PrismaAppointmentTypeRepository } from '../src/modules/appointment-types/infrastructure/repositories/prisma-appointment-type.repository';
import { PrismaWaitlistRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-waitlist.repository';
import { CreateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/create-appointment.use-case';
import { UpdateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import { ScheduleFromWaitlistUseCase } from '../src/modules/waitlist/application/use-cases/waitlist.use-cases';
import type { LocationScheduleRepository } from '../src/modules/location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../src/modules/staff/domain/ports/staff-repository.port';
import type { PatientRepository } from '../src/modules/patients/domain/ports/patient-repository.port';
import type { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';

// DX-122, capa DB: `schedule_blocks` y `appointment_waitlist` (RLS FORCE, FK
// compuestas, CHECK, único parcial) y las garantías que solo Postgres da: el
// rechazo por bloqueo con los repositorios reales, que cancelar y crear la
// entrada van en UNA transacción, la idempotencia con dos cancelaciones a la
// vez y la carrera de dos «Agendar aquí» sobre la misma entrada.
// `raw` (DIRECT_URL, owner) siembra, inspecciona y limpia; lo que se prueba va
// por la MISMA ruta que la app (runWithTenant, rol dentalix_app, RLS).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx122-a', 'dx122-b'];
const DOCTOR = randomUUID();

interface Clinic {
  tenantId: string;
  locationId: string;
  patientIds: string[];
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede' },
  });
  const patientIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: `P${i}`, lastName: subdomain },
    });
    patientIds.push(patient.id);
  }
  return { tenantId: tenant.id, locationId: location.id, patientIds };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.appointmentWaitlistEntry.deleteMany({ where });
  await raw.scheduleBlock.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

/** Día futuro fijo (UTC): las citas de este spec nunca caen en el pasado. */
const DAY = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
function at(time: string): Date {
  return new Date(`${DAY}T${time}:00.000Z`);
}

const noSchedule = {
  findByLocation: () => Promise.resolve(null),
  findForCurrentLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;
const anyStaff = {
  findById: (userId: string) => Promise.resolve({ userId }),
} as unknown as StaffRepository;
const anyPatient = {
  findById: (id: string) => Promise.resolve({ id }),
} as unknown as PatientRepository;
const noAudit = {
  record: () => Promise.resolve(),
} as unknown as RecordAuditEventUseCase;

describe('bloqueos de agenda y pendientes por agendar (int, DX-122)', () => {
  let a: Clinic;
  let b: Clinic;
  const appointments = new PrismaAppointmentRepository(prisma, tenantContext);
  const blocks = new PrismaScheduleBlockRepository(prisma, tenantContext);
  const waitlist = new PrismaWaitlistRepository(prisma, tenantContext);
  const types = new PrismaAppointmentTypeRepository(prisma, tenantContext);
  const create = new CreateAppointmentUseCase(
    appointments,
    anyPatient,
    anyStaff,
    noSchedule,
    types,
    blocks,
  );
  const update = new UpdateAppointmentUseCase(
    appointments,
    noSchedule,
    anyStaff,
    noAudit,
    blocks,
    new PrismaLocationRepository(prisma, tenantContext),
  );

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  const inA = <T>(fn: () => Promise<T>) =>
    tenantContext.run(a.tenantId, a.locationId, fn);
  const asA = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.runWithTenant(a.tenantId, fn);

  async function newAppointment(start: string, end: string, patient = 0) {
    return inA(() =>
      create.execute({
        patientId: a.patientIds[patient],
        providerId: DOCTOR,
        start: at(start),
        end: at(end),
      }),
    );
  }

  describe('RLS FORCE y catálogo', () => {
    it.each(['schedule_blocks', 'appointment_waitlist'])(
      '%s tiene RLS ENABLE + FORCE y la política tenant_isolation',
      async (table) => {
        const [flags] = await raw.$queryRawUnsafe<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
        );
        expect(flags).toEqual({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
        const policies = await raw.$queryRawUnsafe<{ policyname: string }[]>(
          `SELECT policyname FROM pg_policies WHERE tablename = $1`,
          table,
        );
        expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
      },
    );

    it('cada clínica ve solo sus bloqueos y sus pendientes, y no escribe en la otra', async () => {
      await raw.scheduleBlock.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          start: at('08:00'),
          end: at('09:00'),
          kind: 'MEETING',
        },
      });
      await raw.appointmentWaitlistEntry.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          patientId: b.patientIds[0],
        },
      });
      await expect(asA((tx) => tx.scheduleBlock.count())).resolves.toBe(0);
      await expect(
        asA((tx) => tx.appointmentWaitlistEntry.count()),
      ).resolves.toBe(0);

      await expect(
        asA((tx) =>
          tx.scheduleBlock.create({
            data: {
              tenantId: b.tenantId,
              locationId: b.locationId,
              start: at('08:00'),
              end: at('09:00'),
              kind: 'OTHER',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asA((tx) =>
          tx.appointmentWaitlistEntry.create({
            data: {
              tenantId: b.tenantId,
              locationId: b.locationId,
              patientId: b.patientIds[0],
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('FK compuestas y CHECK', () => {
    const p2003 = { code: 'P2003' };

    it('un bloqueo no puede apuntar a la sede de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.scheduleBlock.create({
            data: {
              tenantId: a.tenantId,
              locationId: b.locationId,
              start: at('08:00'),
              end: at('09:00'),
              kind: 'OTHER',
            },
          }),
        ),
      ).rejects.toMatchObject(p2003);
    });

    it('una entrada no puede apuntar a paciente, sede o cita de otra clínica', async () => {
      const bAppointment = await raw.appointment.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          patientId: b.patientIds[0],
          providerId: DOCTOR,
          start: at('20:00'),
          end: at('20:30'),
        },
      });
      const base = {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.patientIds[0],
      };
      for (const data of [
        { ...base, patientId: b.patientIds[0] },
        { ...base, locationId: b.locationId },
        { ...base, sourceAppointmentId: bAppointment.id },
      ]) {
        await expect(
          asA((tx) => tx.appointmentWaitlistEntry.create({ data })),
        ).rejects.toMatchObject(p2003);
      }
    });

    it('rechaza fin no posterior al inicio, bloqueo sin alcance y estados incoherentes', async () => {
      const check = /violates check constraint/;
      await expect(
        asA((tx) =>
          tx.scheduleBlock.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              start: at('09:00'),
              end: at('09:00'),
              kind: 'OTHER',
            },
          }),
        ),
      ).rejects.toThrow(check);
      await expect(
        asA((tx) =>
          tx.scheduleBlock.create({
            data: {
              tenantId: a.tenantId,
              start: at('08:00'),
              end: at('09:00'),
              kind: 'OTHER',
            },
          }),
        ),
      ).rejects.toThrow(check);
      await expect(
        asA((tx) =>
          tx.appointmentWaitlistEntry.create({
            data: {
              tenantId: a.tenantId,
              locationId: a.locationId,
              patientId: a.patientIds[0],
              status: 'DISMISSED',
            },
          }),
        ),
      ).rejects.toThrow(check);
    });
  });

  describe('rechazo por bloqueo con los repositorios reales', () => {
    afterEach(async () => {
      await raw.scheduleBlock.deleteMany({ where: { tenantId: a.tenantId } });
      await raw.appointmentWaitlistEntry.deleteMany({
        where: { tenantId: a.tenantId },
      });
      await raw.appointment.deleteMany({ where: { tenantId: a.tenantId } });
    });

    it('vacaciones de la doctora en todas las sedes: crear y mover a ese rango dan 409', async () => {
      await inA(() =>
        blocks.create({
          providerId: DOCTOR,
          locationId: null,
          start: at('12:00'),
          end: at('18:00'),
          kind: 'VACATION',
          allowsBooking: false,
          note: null,
          createdById: DOCTOR,
        }),
      );
      await expect(newAppointment('13:00', '13:30')).rejects.toThrow(
        ConflictException,
      );
      const early = await newAppointment('10:00', '10:30');
      await expect(
        inA(() =>
          update.execute(early.id, { start: at('15:00'), end: at('15:30') }),
        ),
      ).rejects.toThrow(/Vacaciones/);
      // Un bloqueo retirado ya no estorba.
      const [block] = await inA(() =>
        blocks.list({ from: at('00:00'), to: at('23:59') }),
      );
      await inA(() => blocks.softDelete(block.id, DOCTOR));
      await expect(newAppointment('13:00', '13:30', 1)).resolves.toMatchObject({
        warnings: [],
      });
    });

    it('almuerzo de la sede que deja agendar: crea con aviso', async () => {
      await inA(() =>
        blocks.create({
          providerId: null,
          locationId: a.locationId,
          start: at('17:00'),
          end: at('18:00'),
          kind: 'LUNCH',
          allowsBooking: true,
          note: null,
          createdById: DOCTOR,
        }),
      );
      const created = await newAppointment('17:00', '17:30');
      expect(created.warnings[0]).toMatch(/Almuerzo/);
    });
  });

  describe('cancelar → pendientes en la misma transacción', () => {
    afterEach(async () => {
      await raw.$executeRawUnsafe(
        'ALTER TABLE "appointment_waitlist" DROP CONSTRAINT IF EXISTS "dx122_test_reject_all"',
      );
      await raw.appointmentWaitlistEntry.deleteMany({
        where: { tenantId: a.tenantId },
      });
      await raw.appointment.deleteMany({ where: { tenantId: a.tenantId } });
    });

    it('cancelar y luego no-show: una sola entrada OPEN con los datos de la cita', async () => {
      const appt = await newAppointment('10:00', '10:45');
      await inA(() =>
        update.execute(appt.id, { status: AppointmentStatus.CANCELLED }),
      );
      await inA(() =>
        update.execute(appt.id, { status: AppointmentStatus.NO_SHOW }),
      );

      const entries = await raw.appointmentWaitlistEntry.findMany({
        where: { tenantId: a.tenantId },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        status: 'OPEN',
        sourceAppointmentId: appt.id,
        patientId: a.patientIds[0],
        locationId: a.locationId,
        providerId: DOCTOR,
        durationMinutes: 45,
      });
    });

    it('reactivar la cita (CANCELLED → SCHEDULED) cierra su entrada en la misma transacción', async () => {
      const appt = await newAppointment('09:00', '09:30');
      await inA(() =>
        update.execute(appt.id, { status: AppointmentStatus.CANCELLED }),
      );
      await inA(() =>
        update.execute(appt.id, { status: AppointmentStatus.SCHEDULED }),
      );

      const entries = await raw.appointmentWaitlistEntry.findMany({
        where: { sourceAppointmentId: appt.id },
      });
      expect(entries).toEqual([
        expect.objectContaining({
          status: 'SCHEDULED',
          resolvedAppointmentId: appt.id,
        }),
      ]);
      expect(entries[0].resolvedAt).not.toBeNull();
    });

    it('cancelarla otra vez tras reactivarla reabre la misma entrada (sigue habiendo una sola)', async () => {
      const appt = await newAppointment('10:00', '10:30');
      for (const status of [
        AppointmentStatus.CANCELLED,
        AppointmentStatus.SCHEDULED,
        AppointmentStatus.NO_SHOW,
      ]) {
        await inA(() => update.execute(appt.id, { status }));
      }

      const entries = await raw.appointmentWaitlistEntry.findMany({
        where: { sourceAppointmentId: appt.id },
      });
      expect(entries).toEqual([
        expect.objectContaining({
          status: 'OPEN',
          resolvedAt: null,
          resolvedAppointmentId: null,
          resolvedById: null,
        }),
      ]);
    });

    it('dos cancelaciones simultáneas de la misma cita: una sola entrada', async () => {
      const appt = await newAppointment('11:00', '11:30');
      const results = await Promise.allSettled([
        inA(() =>
          update.execute(appt.id, { status: AppointmentStatus.CANCELLED }),
        ),
        inA(() =>
          update.execute(appt.id, { status: AppointmentStatus.NO_SHOW }),
        ),
      ]);
      // DX-200: todo cambio de estado va condicionado al estado leído. Si las
      // dos leen SCHEDULED a la vez, la segunda recibe 409 en vez de pisar a
      // la primera; si se serializan, las dos pasan. Nunca falla de otra forma.
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(ConflictException);
        }
      }
      await expect(
        raw.appointmentWaitlistEntry.count({
          where: { sourceAppointmentId: appt.id },
        }),
      ).resolves.toBe(1);
    });

    it('si la entrada no se puede crear, la cita NO queda cancelada (atomicidad)', async () => {
      const appt = await newAppointment('12:00', '12:30');
      // Una restricción que rechaza toda fila nueva: el INSERT de la entrada
      // falla dentro de la transacción de la cita.
      await raw.$executeRawUnsafe(
        'ALTER TABLE "appointment_waitlist" ADD CONSTRAINT "dx122_test_reject_all" CHECK (false) NOT VALID',
      );
      await expect(
        inA(() =>
          update.execute(appt.id, { status: AppointmentStatus.CANCELLED }),
        ),
      ).rejects.toThrow();
      const after = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
      });
      expect(after.status).toBe(AppointmentStatus.SCHEDULED);
    });
  });

  describe('agendar desde la entrada', () => {
    afterEach(async () => {
      await raw.appointmentWaitlistEntry.deleteMany({
        where: { tenantId: a.tenantId },
      });
      await raw.appointment.deleteMany({ where: { tenantId: a.tenantId } });
    });

    const ctx = (): AuditRequestContext => ({
      tenantId: a.tenantId,
      locationId: a.locationId,
      actor: { userId: DOCTOR, role: 'RECEPTION' },
      requestId: null,
      ip: null,
      userAgent: null,
    });

    it('dos «Agendar aquí» a la vez sobre la misma entrada: una cita y una 409', async () => {
      const entry = await inA(() =>
        waitlist.create({
          patientId: a.patientIds[2],
          providerId: null,
          appointmentTypeId: null,
          durationMinutes: 30,
          priority: 'NORMAL',
          preferredWindow: null,
          note: null,
          createdById: DOCTOR,
        }),
      );
      const schedule = new ScheduleFromWaitlistUseCase(
        waitlist,
        types,
        create,
        noAudit,
      );
      const results = await Promise.allSettled([
        inA(() =>
          schedule.execute(
            entry.id,
            { providerId: DOCTOR, start: at('14:00') },
            ctx(),
          ),
        ),
        inA(() =>
          schedule.execute(
            entry.id,
            { providerId: DOCTOR, start: at('16:00') },
            ctx(),
          ),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected && rejected.reason).toBeInstanceOf(ConflictException);
      await expect(
        raw.appointment.count({
          where: { tenantId: a.tenantId, patientId: a.patientIds[2] },
        }),
      ).resolves.toBe(1);
      const stored = await raw.appointmentWaitlistEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(stored.status).toBe('SCHEDULED');
      expect(stored.resolvedAppointmentId).not.toBeNull();
    });
  });
});
