import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  AppointmentStatus,
  ClinicRole,
  DocumentType,
  Prisma,
  PrismaClient,
  TriageFlag,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaWalkInRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-walk-in.repository';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { overlapExclusionScope } from '../src/modules/appointments/application/appointment-overlap-error';
import type { WalkInWrite } from '../src/modules/appointments/domain/ports/walk-in-repository.port';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PATIENT_DUPLICATE_CODE } from '../src/modules/appointments/domain/walk-in';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-470, capa BD de «Atender sin cita» por la MISMA ruta que la app
// (runWithTenant, rol dentalix_app, RLS FORCE):
//  - paciente nuevo + cita ARRIVED + auditoría en UNA transacción: si algo
//    falla después del alta (FK compuesta, solape), no queda ni el paciente;
//  - FK compuestas por clínica: paciente, sede y tipo de otra clínica no
//    entran aunque el id se colara;
//  - RLS: otra clínica no ve la cita, el paciente ni el motivo del sobrecupo;
//  - el sobrecupo se salta la EXCLUDE del profesional, nada más.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx470-int-a', 'dx470-int-b'];
const DAY = '2026-11-10';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000-05:00`);

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  urgentTypeId: string;
  userId: string;
  providerId: string;
}

describe('DX-470 · «Atender sin cita» en la BD (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaWalkInRepository(prisma, tenantContext);
  let a: Clinic;
  let b: Clinic;

  async function seedClinic(subdomain: string): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: tenant.id,
        name: 'Principal',
      }),
    });
    const patient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Eva',
        lastName: subdomain,
        docNumber: `${subdomain}-1`,
      },
    });
    const type = await raw.appointmentType.create({
      data: {
        tenantId: tenant.id,
        name: 'Consulta de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      },
    });
    const user = await raw.user.create({
      data: {
        email: `${subdomain}-${randomUUID()}@example.com`,
        passwordHash: 'x',
        fullName: 'Recepción',
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        role: ClinicRole.RECEPTION,
      },
    });
    const provider = await raw.user.create({
      data: {
        email: `${subdomain}-dent-${randomUUID()}@example.com`,
        passwordHash: 'x',
        fullName: 'Dra. Urgencias',
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: tenant.id,
        userId: provider.id,
        role: ClinicRole.DENTIST,
      },
    });
    return {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      urgentTypeId: type.id,
      userId: user.id,
      providerId: provider.id,
    };
  }

  function ctx(c: Clinic): AuditRequestContext {
    return {
      tenantId: c.tenantId,
      locationId: c.locationId,
      actor: { userId: c.userId, role: ClinicRole.RECEPTION },
      requestId: 'req-dx470',
      ip: null,
      userAgent: null,
    };
  }

  function write(c: Clinic, overrides: Partial<WalkInWrite> = {}): WalkInWrite {
    return {
      patient: {
        kind: 'new',
        data: {
          firstName: 'Lucía',
          lastName: 'Sin Cita',
          phone: '+34 600 000 000',
          docType: DocumentType.OTHER,
          docTypeLabel: null,
        },
      },
      providerId: c.providerId,
      locationId: c.locationId,
      appointmentTypeId: c.urgentTypeId,
      start: at('10:00'),
      end: at('10:30'),
      arrivedAt: at('10:00'),
      triageFlags: [TriageFlag.PAIN, TriageFlag.FEVER],
      triageNote: 'Muela 36, dolor nocturno',
      overbookReason: null,
      createdById: c.userId,
      ...overrides,
    };
  }

  const create = (c: Clinic, overrides: Partial<WalkInWrite> = {}) =>
    tenantContext.run(c.tenantId, c.locationId, () =>
      repo.create(write(c, overrides), ctx(c)),
    );

  const countPatients = (c: Clinic) =>
    raw.patient.count({ where: { tenantId: c.tenantId } });
  const countAppointments = (c: Clinic) =>
    raw.appointment.count({ where: { tenantId: c.tenantId } });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('las migraciones dejan las CHECK validadas y la EXCLUDE del profesional sin los sobrecupos', async () => {
    const checks = await raw.$queryRaw<{ name: string; validated: boolean }[]>`
      SELECT conname AS name, convalidated AS validated FROM pg_constraint
       WHERE conname IN ('appointments_triage_check',
                         'appointments_overbooked_walk_in_check',
                         'appointment_reserved_overrides_blocks_check')
       ORDER BY conname`;
    expect(checks).toEqual([
      { name: 'appointment_reserved_overrides_blocks_check', validated: true },
      { name: 'appointments_overbooked_walk_in_check', validated: true },
      { name: 'appointments_triage_check', validated: true },
    ]);
    const [exclude] = await raw.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'appointments_no_overlap_per_provider'`;
    expect(exclude.def).toMatch(/"tenantId" WITH =/);
    expect(exclude.def).toMatch(/NOT overbooked/);
  });

  it('paciente nuevo + cita ARRIVED + auditoría en una transacción', async () => {
    const before = await countPatients(a);
    const result = await create(a);

    expect(result.replayed).toBe(false);
    expect(!result.replayed && result.patientCreated).toBe(true);
    expect(result.appointment).toMatchObject({
      tenantId: a.tenantId,
      locationId: a.locationId,
      providerId: a.providerId,
      appointmentTypeId: a.urgentTypeId,
      status: AppointmentStatus.ARRIVED,
      arrivedAt: at('10:00'),
      walkIn: true,
      overbooked: false,
      triageFlags: ['PAIN', 'FEVER'],
      triageNote: 'Muela 36, dolor nocturno',
      patientFirstName: 'Lucía',
    });
    expect(await countPatients(a)).toBe(before + 1);
    const row = await raw.appointment.findUniqueOrThrow({
      where: { id: result.appointment.id },
    });
    expect(row.preArrivalStatus).toBe(AppointmentStatus.SCHEDULED);
    const patient = await raw.patient.findUniqueOrThrow({
      where: { id: result.appointment.patientId },
    });
    expect(patient).toMatchObject({
      tenantId: a.tenantId,
      phone: '+34 600 000 000',
      createdById: a.userId,
    });

    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, requestId: 'req-dx470' },
    });
    const reasons = events.map(
      (e) => (e.metadata as { reason?: string }).reason,
    );
    expect(reasons).toEqual(
      expect.arrayContaining(['WALK_IN_PATIENT', 'WALK_IN_ARRIVAL']),
    );
    // El triaje (dato de salud) nunca llega a la auditoría.
    const serialized = JSON.stringify(events.map((e) => e.metadata));
    expect(serialized).not.toMatch(/Muela|nocturno|PAIN|FEVER/);
    expect(serialized).toMatch(/triageFlags/);
  });

  it('todo o nada: documento repetido → 409 PATIENT_DUPLICATE y no queda nada', async () => {
    const patients = await countPatients(a);
    const appointments = await countAppointments(a);
    const error = await create(a, {
      patient: {
        kind: 'new',
        data: {
          firstName: 'Eva',
          lastName: 'Duplicada',
          phone: '+34 600 000 001',
          docType: DocumentType.NATIONAL_ID,
          docTypeLabel: null,
          // Mismo documento normalizado que el de la semilla (DX-107).
          docNumber: ` ${SUBDOMAINS[0].toUpperCase()}1 `,
        },
      },
      start: at('11:00'),
      end: at('11:30'),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PATIENT_DUPLICATE_CODE,
      existingPatientId: a.patientId,
    });
    expect(await countPatients(a)).toBe(patients);
    expect(await countAppointments(a)).toBe(appointments);
  });

  it('FK compuesta: sede de otra clínica → error y el alta del paciente se deshace', async () => {
    const patients = await countPatients(a);
    await expect(
      create(a, {
        locationId: b.locationId,
        start: at('12:00'),
        end: at('12:30'),
      }),
    ).rejects.toThrow();
    expect(await countPatients(a)).toBe(patients);
    expect(await countAppointments(b)).toBe(0);
  });

  it('FK compuesta: paciente o tipo de otra clínica no entran', async () => {
    const appointments = await countAppointments(a);
    await expect(
      create(a, {
        patient: { kind: 'existing', id: b.patientId },
        start: at('13:00'),
        end: at('13:30'),
      }),
    ).rejects.toThrow();
    await expect(
      create(a, {
        patient: { kind: 'existing', id: a.patientId },
        appointmentTypeId: b.urgentTypeId,
        start: at('13:00'),
        end: at('13:30'),
      }),
    ).rejects.toThrow();
    expect(await countAppointments(a)).toBe(appointments);
    expect(await countAppointments(b)).toBe(0);
  });

  it('sobrecupo: solapa al profesional (no a la EXCLUDE) y deja el motivo en su tabla; sin sobrecupo, 23P01', async () => {
    const first = await create(a, {
      patient: { kind: 'existing', id: a.patientId },
      start: at('14:00'),
      end: at('14:30'),
    });
    const overbooked = await create(a, {
      start: at('14:10'),
      end: at('14:40'),
      overbookReason: 'Dolor agudo, no puede esperar',
    });
    expect(overbooked.appointment.overbooked).toBe(true);
    expect(overbooked.overbookId).not.toBeNull();
    const override = await raw.appointmentReservedOverride.findUniqueOrThrow({
      where: { id: overbooked.overbookId! },
    });
    expect(override).toMatchObject({
      kind: 'WALK_IN_OVERBOOK',
      blockIds: [],
      reason: 'Dolor agudo, no puede esperar',
      appointmentId: overbooked.appointment.id,
      createdById: a.userId,
    });
    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, resourceId: overbooked.appointment.id },
    });
    const serialized = JSON.stringify(events.map((e) => e.metadata));
    expect(serialized).toContain('WALK_IN_OVERBOOK');
    expect(serialized).toContain(override.id);
    expect(serialized).not.toContain('Dolor agudo');

    const clash = await create(a, {
      start: at('14:15'),
      end: at('14:45'),
    }).catch((e: unknown) => e);
    expect(overlapExclusionScope(clash)).toBe('provider');
    expect(first.appointment.overbooked).toBe(false);
  });

  it('RLS: otra clínica no ve la cita, el paciente ni el motivo', async () => {
    const seen = await tenantContext.run(b.tenantId, b.locationId, () =>
      prisma.runWithTenant(async (tx) => ({
        appointments: await tx.appointment.count({
          where: { tenantId: a.tenantId },
        }),
        patients: await tx.patient.count({ where: { tenantId: a.tenantId } }),
        overrides: await tx.appointmentReservedOverride.count({
          where: { tenantId: a.tenantId },
        }),
      })),
    );
    expect(seen).toEqual({ appointments: 0, patients: 0, overrides: 0 });
    expect(await countAppointments(a)).toBeGreaterThan(0);
  });

  it('CHECKs: nota > 200, sobrecupo sin walkIn y reservado sin bloques no entran', async () => {
    const base = {
      tenantId: a.tenantId,
      locationId: a.locationId,
      patientId: a.patientId,
      providerId: randomUUID(),
      start: at('18:00'),
      end: at('18:30'),
    };
    await expect(
      raw.appointment.create({
        data: { ...base, triageNote: 'x'.repeat(201) },
      }),
    ).rejects.toThrow();
    await expect(
      raw.appointment.create({
        data: { ...base, triageNote: ' con espacios ' },
      }),
    ).rejects.toThrow(/appointments_triage_check/);
    await expect(
      raw.appointment.create({ data: { ...base, overbooked: true } }),
    ).rejects.toThrow(/appointments_overbooked_walk_in_check/);
    await expect(
      raw.$executeRawUnsafe(
        `INSERT INTO "appointments" ("id","tenantId","locationId","patientId","providerId","start","end","triageFlags","updatedAt")
         VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,gen_random_uuid(),now(),now() + interval '1 minute',ARRAY['ITCH']::"TriageFlag"[],now())`,
        a.tenantId,
        a.locationId,
        a.patientId,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
    const appointment = await raw.appointment.findFirstOrThrow({
      where: { tenantId: a.tenantId, walkIn: true },
    });
    await expect(
      raw.appointmentReservedOverride.create({
        data: {
          tenantId: a.tenantId,
          patientId: appointment.patientId,
          appointmentId: appointment.id,
          blockIds: [],
          reason: 'Sin bloques',
          createdById: a.userId,
        },
      }),
    ).rejects.toThrow(/appointment_reserved_overrides_blocks_check/);
  });

  // DX-509: lo que la API decide (dejar de ser sobrecupo) lo arbitra la
  // EXCLUDE del profesional, y el trigger lo apaga en cualquier movimiento.
  describe('DX-509 · fin del sobrecupo en la BD', () => {
    const appointments = new PrismaAppointmentRepository(prisma, tenantContext);
    const inA = <T>(fn: () => Promise<T>) =>
      tenantContext.run(a.tenantId, a.locationId, fn);

    async function overbookedOverBooked(hhmm: string, endHhmm: string) {
      const booked = await create(a, {
        patient: { kind: 'existing', id: a.patientId },
        start: at(hhmm),
        end: at(endHhmm),
      });
      const urgent = await create(a, {
        start: at(hhmm),
        end: at(endHhmm),
        overbookReason: 'Dolor agudo, no puede esperar',
      });
      expect(urgent.appointment.overbooked).toBe(true);
      return { booked: booked.appointment, urgent: urgent.appointment };
    }

    it('mover: el trigger lo apaga y la EXCLUDE lo cuenta (23P01 si choca); a un hueco libre queda normal', async () => {
      const { urgent } = await overbookedOverBooked('19:00', '19:30');
      // Se queda en su hora: un cambio que no la mueve no la toca.
      await inA(() => appointments.update(urgent.id, { notes: 'x' }));
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: urgent.id } }))
          .overbooked,
      ).toBe(true);
      // Moverla 10 min sin decir nada del sobrecupo: el trigger lo apaga y
      // entonces choca con la agendada.
      const clash = await inA(() =>
        appointments.update(urgent.id, {
          start: at('19:10'),
          end: at('19:40'),
        }),
      ).catch((e: unknown) => e);
      expect(overlapExclusionScope(clash)).toBe('provider');
      const moved = await inA(() =>
        appointments.update(urgent.id, {
          start: at('20:00'),
          end: at('20:30'),
          overbooked: false,
        }),
      );
      expect(moved.appointment.overbooked).toBe(false);
      // Ya cuenta: una cita nueva del profesional encima choca.
      const over = await create(a, {
        patient: { kind: 'existing', id: a.patientId },
        start: at('20:10'),
        end: at('20:40'),
      }).catch((e: unknown) => e);
      expect(overlapExclusionScope(over)).toBe('provider');
    });

    it('deshacer la llegada: con su hora ocupada, apagarlo es 23P01 y no cambia nada; manteniéndolo, agendada en sobrecupo', async () => {
      const { urgent } = await overbookedOverBooked('21:00', '21:30');
      const clash = await inA(() =>
        appointments.undoArrival(urgent.id, { clearOverbooked: true }),
      ).catch((e: unknown) => e);
      expect(overlapExclusionScope(clash)).toBe('provider');
      expect(
        await raw.appointment.findUniqueOrThrow({ where: { id: urgent.id } }),
      ).toMatchObject({ status: 'ARRIVED', overbooked: true });
      const kept = await inA(() => appointments.undoArrival(urgent.id));
      expect(kept).toMatchObject({ status: 'SCHEDULED', overbooked: true });
    });

    it('deshacer la llegada con su hora libre: agendada y normal', async () => {
      const urgent = await create(a, {
        start: at('22:00'),
        end: at('22:30'),
        overbookReason: 'Dolor agudo, no puede esperar',
      });
      const undone = await inA(() =>
        appointments.undoArrival(urgent.appointment.id, {
          clearOverbooked: true,
        }),
      );
      expect(undone).toMatchObject({ status: 'SCHEDULED', overbooked: false });
    });

    it('reactivar: con su hora ocupada, apagarlo es 23P01; con su hora libre, normal', async () => {
      const { urgent } = await overbookedOverBooked('16:00', '16:30');
      await raw.appointment.update({
        where: { id: urgent.id },
        data: {
          status: 'CANCELLED',
          arrivedAt: null,
          preArrivalStatus: null,
          cancelledAt: new Date(),
          cancelledByKind: 'STAFF_FOR_PATIENT',
          cancelReasonCode: 'ILLNESS',
          noticeMinutes: 0,
          lateCancellation: false,
        },
      });
      const clash = await inA(() =>
        appointments.update(urgent.id, {
          status: 'SCHEDULED',
          clearCancellation: true,
          overbooked: false,
        }),
      ).catch((e: unknown) => e);
      expect(overlapExclusionScope(clash)).toBe('provider');
      // Mantenerlo a sabiendas: la EXCLUDE no lo cuenta.
      const kept = await inA(() =>
        appointments.update(urgent.id, {
          status: 'SCHEDULED',
          clearCancellation: true,
        }),
      );
      expect(kept.appointment).toMatchObject({
        status: 'SCHEDULED',
        overbooked: true,
      });

      const free = await create(a, {
        start: at('17:00'),
        end: at('17:30'),
        overbookReason: 'Dolor agudo, no puede esperar',
      });
      await raw.appointment.update({
        where: { id: free.appointment.id },
        data: {
          status: 'CANCELLED',
          arrivedAt: null,
          preArrivalStatus: null,
          cancelledAt: new Date(),
          cancelledByKind: 'STAFF_FOR_PATIENT',
          cancelReasonCode: 'ILLNESS',
          noticeMinutes: 0,
          lateCancellation: false,
        },
      });
      const back = await inA(() =>
        appointments.update(free.appointment.id, {
          status: 'SCHEDULED',
          clearCancellation: true,
          overbooked: false,
        }),
      );
      expect(back.appointment).toMatchObject({
        status: 'SCHEDULED',
        overbooked: false,
      });
    });

    it('un UPDATE no enciende el sobrecupo ni cambia la clave de idempotencia', async () => {
      const row = await raw.appointment.findFirstOrThrow({
        where: { tenantId: a.tenantId, walkIn: true, overbooked: false },
      });
      await expect(
        raw.appointment.update({
          where: { id: row.id },
          data: { overbooked: true },
        }),
      ).rejects.toThrow(/Un sobrecupo solo nace/);
      await expect(
        raw.appointment.update({
          where: { id: row.id },
          data: { idempotencyKey: randomUUID() },
        }),
      ).rejects.toThrow(/clave de idempotencia/);
    });
  });

  // DX-510: dos envíos con la misma clave a la vez (doble clic): el candado
  // por clave los ordena; el segundo devuelve la cita del primero.
  describe('DX-510 · doble envío en paralelo', () => {
    it('misma clave a la vez: una cita, un paciente, el segundo es la repetición', async () => {
      const key = randomUUID();
      const patients = await countPatients(a);
      const appointments = await countAppointments(a);
      const idem = { key, fingerprint: 'f'.repeat(64) };
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          create(a, {
            start: at('08:00'),
            end: at('08:30'),
            idempotency: idem,
          }),
        ),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.appointment.id)).size).toBe(1);
      expect(await countPatients(a)).toBe(patients + 1);
      expect(await countAppointments(a)).toBe(appointments + 1);
      const replay = results.find((r) => r.replayed)!;
      expect(replay).toMatchObject({ fingerprint: 'f'.repeat(64) });
    });

    it('la clave es por clínica: la misma en otra clínica escribe la suya; otra clínica no la ve', async () => {
      const key = randomUUID();
      const idem = { key, fingerprint: 'a'.repeat(64) };
      const mine = await create(a, {
        start: at('08:30'),
        end: at('09:00'),
        idempotency: idem,
      });
      const theirs = await create(b, {
        start: at('08:30'),
        end: at('09:00'),
        idempotency: idem,
      });
      expect(theirs.replayed).toBe(false);
      expect(theirs.appointment.id).not.toBe(mine.appointment.id);
      const seenFromB = await tenantContext.run(b.tenantId, b.locationId, () =>
        repo.findByIdempotencyKey(key),
      );
      expect(seenFromB!.appointment.id).toBe(theirs.appointment.id);
    });
  });
});
