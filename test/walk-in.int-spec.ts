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

    expect(result.patientCreated).toBe(true);
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
});
