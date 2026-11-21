import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AppointmentArrivalSource,
  AppointmentStatus,
  ClinicRole,
} from '@prisma/client';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import {
  UpdateAppointmentUseCase,
  type AppointmentAuditContext,
} from './update-appointment.use-case';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { civilDateIn, civilDayRange } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';

// DX-265: «Ya llegué» del paciente por el MISMO camino que «Llegó» de
// recepción (UpdateAppointmentUseCase.arriveByPatient).

const TZ = 'America/Caracas';
const HOUR = 60 * 60 * 1000;

const schedule = {
  findByLocation: () => Promise.resolve(null),
  // DX-263-bis: sin festivos en la sede.
  holidaysOf: () => Promise.resolve({ timeZone: null, holidays: [] }),
} as unknown as LocationScheduleRepository;
const staff = {
  findById: (userId: string) => Promise.resolve({ userId, role: 'DENTIST' }),
} as unknown as StaffRepository;
const locations = {
  findById: (id: string) =>
    Promise.resolve({ id, timeZone: TZ, isActive: true }),
} as unknown as LocationRepository;

function ctx(role: ClinicRole): AppointmentAuditContext {
  return {
    tenantId: 't1',
    locationId: 'loc1',
    actor: { userId: `u-${role}`, role },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };
}

function setup(clock?: () => Date) {
  const repo = new InMemoryAppointmentRepository();
  const drafts: AuditEventDraft[] = [];
  const audit = {
    record: (d: AuditEventDraft) => {
      drafts.push(d);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
  const uc = new UpdateAppointmentUseCase(
    repo,
    schedule,
    staff,
    audit,
    new InMemoryScheduleBlockRepository(),
    locations,
    new TenantContextService(),
    inMemoryAvailability(),
    clock,
  );
  return { repo, uc, drafts };
}

/** Una cita de hoy que no cruza la medianoche de la sede. */
function todayAppointment(
  repo: InMemoryAppointmentRepository,
  status: AppointmentStatus = AppointmentStatus.CONFIRMED,
  // DX-237: por defecto, del odontólogo que actúa en estas pruebas.
  providerId = `u-${ClinicRole.DENTIST}`,
) {
  // Dentro de 30 min, o antes si eso ya cae mañana en la zona de la sede: la llegada solo
  // depende del DÍA civil de la cita.
  const today = civilDayRange(civilDateIn(new Date(), TZ), TZ);
  const start = new Date(
    Math.min(Date.now() + 30 * 60 * 1000, today.end.getTime() - HOUR),
  );
  return repo.seed({
    providerId,
    status,
    start,
    end: new Date(start.getTime() + 30 * 60 * 1000),
    locationId: 'loc1',
  });
}

const REQUEST = { requestId: 'req-p', ip: '203.0.113.9', userAgent: 'Movil' };

describe('UpdateAppointmentUseCase · «Ya llegué» del paciente (DX-265)', () => {
  it('pasa a «Llegó» con su hora, la vuelta de «Deshacer», el origen y el evento del paciente', async () => {
    const { repo, uc, drafts } = setup();
    const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
    const before = Date.now();
    const updated = await uc.arriveByPatient(a.id, {
      source: AppointmentArrivalSource.PATIENT_LINK,
      request: REQUEST,
    });
    expect(updated.status).toBe(AppointmentStatus.ARRIVED);
    expect(updated.arrivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    const row = (repo as unknown as { rows: { id: string }[] }).rows.find(
      (r) => r.id === a.id,
    ) as unknown as Record<string, unknown>;
    expect(row.preArrivalStatus).toBe(AppointmentStatus.CONFIRMED);
    expect(row.arrivalSource).toBe(AppointmentArrivalSource.PATIENT_LINK);
    // La misma limpieza que la llegada de recepción.
    expect(row.confirmationSentAt).toBeNull();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      actor: { kind: 'patient' },
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: a.id,
      patient: { kind: 'patient', id: a.patientId },
      requestId: 'req-p',
      ip: '203.0.113.9',
      metadata: {
        origin: 'PATIENT_LINK',
        reason: 'PATIENT_SELF_CHECK_IN',
        status: { from: 'CONFIRMED', to: 'ARRIVED' },
      },
    });
  });

  it('QR de la sede: origen SEDE_QR', async () => {
    const { repo, uc, drafts } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    await uc.arriveByPatient(a.id, {
      source: AppointmentArrivalSource.SEDE_QR,
      request: null,
    });
    expect(drafts[0].metadata).toMatchObject({ origin: 'SEDE_QR' });
  });

  it('las mismas reglas que recepción: solo hoy y desde agendada o confirmada', async () => {
    const { repo, uc, drafts } = setup();
    const tomorrow = repo.seed({
      providerId: 'p1',
      status: AppointmentStatus.CONFIRMED,
      start: new Date(Date.now() + 36 * HOUR),
      end: new Date(Date.now() + 36.5 * HOUR),
      locationId: 'loc1',
    });
    await expect(
      uc.arriveByPatient(tomorrow.id, {
        source: AppointmentArrivalSource.PATIENT_LINK,
        request: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const cancelled = todayAppointment(repo, AppointmentStatus.CANCELLED);
    await expect(
      uc.arriveByPatient(cancelled.id, {
        source: AppointmentArrivalSource.PATIENT_LINK,
        request: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      uc.arriveByPatient('no-existe', {
        source: AppointmentArrivalSource.PATIENT_LINK,
        request: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(drafts).toHaveLength(0);
  });

  it('«Deshacer llegada» de recepción borra también el origen; una llegada de recepción no lo lleva', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
    await uc.arriveByPatient(a.id, {
      source: AppointmentArrivalSource.SEDE_QR,
      request: null,
    });
    await uc.undoArrival(a.id, ctx(ClinicRole.RECEPTION));
    const staff = await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(staff.status).toBe(AppointmentStatus.ARRIVED);
    const row = (repo as unknown as { rows: { id: string }[] }).rows.find(
      (r) => r.id === a.id,
    ) as unknown as Record<string, unknown>;
    expect(row.arrivalSource ?? null).toBeNull();
  });
});
