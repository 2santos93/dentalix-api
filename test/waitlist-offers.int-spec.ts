import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaScheduleBlockRepository } from '../src/modules/schedule-blocks/infrastructure/repositories/prisma-schedule-block.repository';
import { PrismaLocationRepository } from '../src/modules/locations/infrastructure/repositories/prisma-location.repository';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { PrismaAppointmentTypeRepository } from '../src/modules/appointment-types/infrastructure/repositories/prisma-appointment-type.repository';
import { PrismaWaitlistRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-waitlist.repository';
import { PrismaOpeningCandidatesRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-opening-candidates.repository';
import { CreateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/create-appointment.use-case';
import { UpdateAppointmentUseCase } from '../src/modules/appointments/application/use-cases/update-appointment.use-case';
import { ScheduleFromWaitlistUseCase } from '../src/modules/waitlist/application/use-cases/waitlist.use-cases';
import type { LocationScheduleRepository } from '../src/modules/location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../src/modules/staff/domain/ports/staff-repository.port';
import type { PatientRepository } from '../src/modules/patients/domain/ports/patient-repository.port';
import type { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';

// DX-210, capa DB: `waitlist_offers` (RLS FORCE, FK compuestas, CHECK), el
// tope de ofertas por paciente y día con dos ofertas a la vez, y las dos
// carreras de «Asignar» que solo Postgres arbitra: dos pendientes al mismo
// hueco (EXCLUDE por profesional) y la misma cita marcada movida dos veces
// (UPDATE condicional de `wantsEarlier`). `raw` (DIRECT_URL, owner) siembra,
// inspecciona y limpia; lo probado va por runWithTenant (dentalix_app, RLS).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx210-a', 'dx210-b'];
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
  await raw.waitlistOffer.deleteMany({ where });
  await raw.appointmentWaitlistEntry.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

const DAY = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const FAR = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const at = (time: string, day = DAY) => new Date(`${day}T${time}:00.000Z`);

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

describe('huecos libres → candidatos y ofertas (int, DX-210)', () => {
  let a: Clinic;
  let b: Clinic;
  const appointments = new PrismaAppointmentRepository(prisma, tenantContext);
  const blocks = new PrismaScheduleBlockRepository(prisma, tenantContext);
  const waitlist = new PrismaWaitlistRepository(prisma, tenantContext);
  const types = new PrismaAppointmentTypeRepository(prisma, tenantContext);
  const offers = new PrismaOpeningCandidatesRepository(prisma, tenantContext);
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
  const schedule = new ScheduleFromWaitlistUseCase(
    waitlist,
    types,
    create,
    noAudit,
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

  afterEach(async () => {
    const where = { tenantId: { in: [a.tenantId, b.tenantId] } };
    await raw.waitlistOffer.deleteMany({ where });
    await raw.appointmentWaitlistEntry.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
  });

  const inA = <T>(fn: () => Promise<T>) =>
    tenantContext.run(a.tenantId, a.locationId, fn);
  const asA = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    prisma.runWithTenant(a.tenantId, fn);
  const ctx = (): AuditRequestContext => ({
    tenantId: a.tenantId,
    locationId: a.locationId,
    actor: { userId: DOCTOR, role: 'RECEPTION' },
    requestId: null,
    ip: null,
    userAgent: null,
  });

  function offerData(c: Clinic, over: Record<string, unknown> = {}) {
    return {
      tenantId: c.tenantId,
      locationId: c.locationId,
      slotStart: at('10:00'),
      slotEnd: at('10:30'),
      providerId: DOCTOR,
      patientId: c.patientIds[0],
      channel: 'PHONE' as const,
      offerDay: new Date(`${DAY}T00:00:00.000Z`),
      createdById: DOCTOR,
      ...over,
    };
  }

  describe('RLS FORCE, FK compuestas y CHECK', () => {
    it('waitlist_offers tiene RLS ENABLE + FORCE y la política tenant_isolation', async () => {
      const [flags] = await raw.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"waitlist_offers"'::regclass`;
      expect(flags).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const policies = await raw.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE tablename = 'waitlist_offers'`;
      expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
    });

    it('cada clínica ve solo sus ofertas y no escribe en la otra', async () => {
      await raw.waitlistOffer.create({ data: offerData(b) });
      await expect(asA((tx) => tx.waitlistOffer.count())).resolves.toBe(0);
      await expect(
        asA((tx) => tx.waitlistOffer.create({ data: offerData(b) })),
      ).rejects.toThrow(/row-level security/);
    });

    it('no puede apuntar a sede, paciente, pendiente o cita de otra clínica', async () => {
      const bEntry = await raw.appointmentWaitlistEntry.create({
        data: {
          tenantId: b.tenantId,
          locationId: b.locationId,
          patientId: b.patientIds[0],
        },
      });
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
      for (const over of [
        { locationId: b.locationId },
        { patientId: b.patientIds[0] },
        { waitlistEntryId: bEntry.id },
        { appointmentId: bAppointment.id },
      ]) {
        await expect(
          asA((tx) => tx.waitlistOffer.create({ data: offerData(a, over) })),
        ).rejects.toMatchObject({ code: 'P2003' });
      }
    });

    it('rechaza un hueco al revés, pendiente y cita a la vez, y un resultado sin fecha', async () => {
      const entry = await raw.appointmentWaitlistEntry.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[0],
        },
      });
      const appointment = await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patientIds[0],
          providerId: DOCTOR,
          start: at('20:00'),
          end: at('20:30'),
        },
      });
      const check = /violates check constraint/;
      for (const over of [
        { slotEnd: at('10:00') },
        { waitlistEntryId: entry.id, appointmentId: appointment.id },
        { outcome: 'ACCEPTED' },
      ]) {
        await expect(
          asA((tx) => tx.waitlistOffer.create({ data: offerData(a, over) })),
        ).rejects.toThrow(check);
      }
    });
  });

  describe('tope de ofertas por paciente y día', () => {
    const input = (day = DAY) => ({
      locationId: a.locationId,
      slotStart: at('10:00'),
      slotEnd: at('10:30'),
      providerId: DOCTOR,
      patientId: a.patientIds[1],
      waitlistEntryId: null,
      appointmentId: null,
      channel: 'PHONE' as const,
      outcome: 'NO_ANSWER' as const,
      offerDay: day,
      createdById: DOCTOR,
    });

    it('cinco ofertas a la vez al mismo paciente: entran exactamente 2', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          inA(() => offers.createOffer(input(), 2)),
        ),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(2);
      await expect(
        raw.waitlistOffer.count({ where: { patientId: a.patientIds[1] } }),
      ).resolves.toBe(2);
    });

    it('otro día no cuenta, y el resumen da hoy y «aviso enviado»', async () => {
      await inA(() => offers.createOffer(input('2000-01-01'), 2));
      const created = await inA(() => offers.createOffer(input(), 2));
      expect(created).toMatchObject({
        offersToday: 1,
        offer: { offerDay: DAY, outcome: 'NO_ANSWER', outcomeById: DOCTOR },
      });
      const summary = await inA(() =>
        offers.offersSummary({
          patientIds: [a.patientIds[1], a.patientIds[2]],
          offerDay: DAY,
          locationId: a.locationId,
          slotStart: at('10:15'),
          slotEnd: at('10:45'),
        }),
      );
      expect(Object.fromEntries(summary)).toEqual({
        [a.patientIds[1]]: { today: 1, forSlot: true, pendingOfferId: null },
      });
    });

    it('`pendingOfferId`: la oferta MÁS RECIENTE del hueco aún sin respuesta', async () => {
      const pending = (n: number) =>
        inA(() =>
          offers.createOffer(
            { ...input(), channel: 'WA_ME', outcome: 'PENDING' },
            n,
          ),
        );
      const first = await pending(5);
      const second = await pending(5);
      const summary = () =>
        inA(() =>
          offers.offersSummary({
            patientIds: [a.patientIds[1]],
            offerDay: DAY,
            locationId: a.locationId,
            slotStart: at('10:00'),
            slotEnd: at('10:30'),
          }),
        );
      expect((await summary()).get(a.patientIds[1])?.pendingOfferId).toBe(
        second!.offer.id,
      );
      await inA(() =>
        offers.recordOutcome(second!.offer.id, 'DECLINED', DOCTOR),
      );
      expect((await summary()).get(a.patientIds[1])?.pendingOfferId).toBe(
        first!.offer.id,
      );
    });
  });

  describe('asignar el hueco', () => {
    it('dos pendientes asignados a la vez al mismo hueco: exactamente una cita y una 409 en español', async () => {
      const entries = await Promise.all(
        [0, 1].map((i) =>
          inA(() =>
            waitlist.create({
              patientId: a.patientIds[i],
              providerId: null,
              appointmentTypeId: null,
              durationMinutes: 30,
              priority: 'NORMAL',
              preferredWindow: null,
              note: null,
              createdById: DOCTOR,
            }),
          ),
        ),
      );
      const results = await Promise.allSettled(
        entries.map((e) =>
          inA(() =>
            schedule.execute(
              e.id,
              { providerId: DOCTOR, start: at('10:00') },
              ctx(),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.reason).toBeInstanceOf(ConflictException);
      expect((rejected?.reason as ConflictException).message).toBe(
        'El profesional ya tiene una cita en ese horario',
      );
      // El que perdió sigue pendiente: el panel lo vuelve a enseñar.
      const statuses = await raw.appointmentWaitlistEntry.findMany({
        where: { id: { in: entries.map((e) => e.id) } },
        select: { status: true },
      });
      expect(statuses.map((s) => s.status).sort()).toEqual([
        'OPEN',
        'SCHEDULED',
      ]);
    });

    it('un pendiente y una cita marcada al mismo hueco a la vez: gana uno, la cita perdedora conserva hora y marca', async () => {
      const entry = await inA(() =>
        waitlist.create({
          patientId: a.patientIds[0],
          providerId: null,
          appointmentTypeId: null,
          durationMinutes: 30,
          priority: 'URGENT',
          preferredWindow: null,
          note: null,
          createdById: DOCTOR,
        }),
      );
      const marked = await inA(() =>
        create.execute({
          patientId: a.patientIds[1],
          providerId: DOCTOR,
          start: at('09:00', FAR),
          end: at('09:30', FAR),
          wantsEarlier: true,
        }),
      );
      const results = await Promise.allSettled([
        inA(() =>
          schedule.execute(
            entry.id,
            { providerId: DOCTOR, start: at('11:00') },
            ctx(),
          ),
        ),
        inA(() =>
          update.moveToOpening(marked.id, { start: at('11:00') }, ctx()),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.find((r) => r.status === 'rejected')?.reason,
      ).toBeInstanceOf(ConflictException);
      const stored = await raw.appointment.findUniqueOrThrow({
        where: { id: marked.id },
      });
      if (stored.start.getTime() === at('11:00').getTime()) {
        expect(stored.wantsEarlier).toBe(false);
      } else {
        expect(stored).toMatchObject({
          start: at('09:00', FAR),
          wantsEarlier: true,
        });
      }
    });

    it('la misma cita marcada movida dos veces a la vez: una se mueve y pierde la marca, la otra 409', async () => {
      const marked = await inA(() =>
        create.execute({
          patientId: a.patientIds[2],
          providerId: DOCTOR,
          start: at('09:00', FAR),
          end: at('09:30', FAR),
          wantsEarlier: true,
        }),
      );
      const results = await Promise.allSettled([
        inA(() =>
          update.moveToOpening(marked.id, { start: at('14:00') }, ctx()),
        ),
        inA(() =>
          update.moveToOpening(marked.id, { start: at('16:00') }, ctx()),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.reason).toBeInstanceOf(ConflictException);
      const stored = await raw.appointment.findUniqueOrThrow({
        where: { id: marked.id },
      });
      expect(stored.wantsEarlier).toBe(false);
      expect([at('14:00').getTime(), at('16:00').getTime()]).toContain(
        stored.start.getTime(),
      );
    });

    it('candidatas: el índice parcial lee solo las marcadas, vivas y agendadas de la sede', async () => {
      await inA(() =>
        create.execute({
          patientId: a.patientIds[0],
          providerId: DOCTOR,
          start: at('09:00', FAR),
          end: at('09:30', FAR),
          wantsEarlier: true,
        }),
      );
      await inA(() =>
        create.execute({
          patientId: a.patientIds[1],
          providerId: DOCTOR,
          start: at('10:00', FAR),
          end: at('10:30', FAR),
        }),
      );
      const rows = await inA(() =>
        offers.listWantsEarlier({
          locationId: a.locationId,
          from: at('00:00'),
          providerId: DOCTOR,
        }),
      );
      expect(rows.map((r) => r.patient.id)).toEqual([a.patientIds[0]]);
      const [index] = await raw.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE indexname = 'appointments_tenant_location_wants_earlier_idx'`;
      expect(index.indexdef).toMatch(/WHERE .*"wantsEarlier"/);
    });
  });
});
