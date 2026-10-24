import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import {
  UpdateAppointmentUseCase,
  PLAN_ITEM_CLAIM_MESSAGES,
  type AppointmentAuditContext,
} from './update-appointment.use-case';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { PlanItemReservedElsewhere } from '../../domain/entities/appointment.entity';
import { PATIENT_FLOW_MESSAGES } from '../../domain/patient-flow';
import { PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE } from '../../domain/plan-item-reservation';
import { civilDateIn, civilDayRange } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';

// DX-273 (revisión DX-271, I1 e I2): la salida de COMPLETED por rol y con
// motivo, el aviso de tratamientos reservados en otra cita y «Traer a esta
// cita», en UpdateAppointmentUseCase.

const TZ = 'America/Bogota';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const schedule = {
  findByLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;
const staff = {
  findById: (userId: string) => Promise.resolve({ userId }),
} as unknown as StaffRepository;
const locations = {
  findById: (id: string) => Promise.resolve({ id, timeZone: TZ }),
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

function setup() {
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
  );
  return { repo, uc, drafts };
}

function todayAppointment(
  repo: InMemoryAppointmentRepository,
  status: AppointmentStatus,
) {
  const today = civilDayRange(civilDateIn(new Date(), TZ), TZ);
  const start = new Date(
    Math.min(Date.now() + 30 * 60 * 1000, today.end.getTime() - HOUR),
  );
  return repo.seed({
    status,
    start,
    end: new Date(start.getTime() + 30 * 60 * 1000),
    locationId: 'loc1',
  });
}

function completedYesterday(repo: InMemoryAppointmentRepository) {
  const start = new Date(Date.now() - DAY);
  return repo.seed({
    status: AppointmentStatus.COMPLETED,
    start,
    end: new Date(start.getTime() + HOUR),
    locationId: 'loc1',
  });
}

const reserved = (appointmentId: string): PlanItemReservedElsewhere => ({
  planItemId: 'item-1',
  name: 'Implante',
  toothNumber: '36',
  heldInClinic: false,
  appointmentId,
  start: new Date('2026-10-30T14:00:00.000Z'),
  locationId: 'loc1',
  locationName: 'Sede Principal',
  timeZone: TZ,
});

describe('UpdateAppointmentUseCase · salida de COMPLETED (DX-273)', () => {
  it.each([ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
    '%s no puede sacar una cita de COMPLETED: 403 en español y nada cambia',
    async (role) => {
      const { repo, uc } = setup();
      const done = completedYesterday(repo);
      for (const status of [
        AppointmentStatus.CANCELLED,
        AppointmentStatus.SCHEDULED,
      ]) {
        const attempt = uc.execute(
          done.id,
          { status, statusReason: 'Se marcó por error' },
          ctx(role),
        );
        await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
        await expect(attempt).rejects.toThrow(
          PATIENT_FLOW_MESSAGES.completedExitForbidden,
        );
      }
      expect((await repo.findById(done.id))!.status).toBe(
        AppointmentStatus.COMPLETED,
      );
      expect(repo.completedExits).toEqual([]);
    },
  );

  it.each([undefined, '', '  a  '])(
    'ADMIN sin motivo válido (%p): 400 y nada cambia',
    async (statusReason) => {
      const { repo, uc } = setup();
      const done = completedYesterday(repo);
      const attempt = uc.execute(
        done.id,
        { status: AppointmentStatus.CANCELLED, statusReason },
        ctx(ClinicRole.ADMIN),
      );
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        PATIENT_FLOW_MESSAGES.completedExitReason,
      );
      expect((await repo.findById(done.id))!.status).toBe(
        AppointmentStatus.COMPLETED,
      );
    },
  );

  it.each([ClinicRole.ADMIN, ClinicRole.DENTIST])(
    '%s con motivo: 200, el repositorio recibe el motivo recortado y quién, y la respuesta lo cuenta',
    async (role) => {
      const { repo, uc } = setup();
      const done = completedYesterday(repo);
      const result = await uc.execute(
        done.id,
        {
          status: AppointmentStatus.CANCELLED,
          statusReason: '  La cirugía no se hizo  ',
        },
        ctx(role),
      );
      expect(result.status).toBe(AppointmentStatus.CANCELLED);
      expect(repo.completedExits).toEqual([
        { reason: 'La cirugía no se hizo', audit: ctx(role) },
      ]);
      expect(result.completedExit).toEqual({
        reversalId: 'reversal-1',
        reason: 'La cirugía no se hizo',
        visitMinimums: [],
      });
    },
  );

  it('el motivo solo viaja al repositorio cuando la cita sale de COMPLETED', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    const result = await uc.execute(
      a.id,
      { status: AppointmentStatus.CANCELLED, statusReason: 'Sin uso aquí' },
      ctx(ClinicRole.RECEPTION),
    );
    expect(result.status).toBe(AppointmentStatus.CANCELLED);
    expect(repo.completedExits).toEqual([]);
    expect(result.completedExit).toBeUndefined();
  });
});

describe('UpdateAppointmentUseCase · tratamientos reservados en otra cita (DX-273)', () => {
  it('«Llegó» devuelve planItemsReservedElsewhere de la cita', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
    repo.reservedElsewhere.set(a.id, [reserved('future-1')]);
    const arrived = await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(arrived.planItemsReservedElsewhere).toEqual([reserved('future-1')]);
  });

  it('sin reservas en otra cita, lista vacía', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
    const arrived = await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(arrived.planItemsReservedElsewhere).toEqual([]);
  });

  it('una cita cancelada no avisa (ya no reserva nada)', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    repo.reservedElsewhere.set(a.id, [reserved('future-1')]);
    const cancelled = await uc.execute(
      a.id,
      { status: AppointmentStatus.CANCELLED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(cancelled.planItemsReservedElsewhere).toEqual([]);
  });

  it('una cita completada no avisa (la visita terminó, revisión M3)', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.READY_FOR_CHECKOUT);
    repo.reservedElsewhere.set(a.id, [reserved('future-1')]);
    const done = await uc.execute(
      a.id,
      { status: AppointmentStatus.COMPLETED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(done.planItemsReservedElsewhere).toEqual([]);
  });

  it('el repositorio recibe quién cambia la cita (auditar la reserva recuperada, revisión I1)', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    const update = jest.spyOn(repo, 'update');
    await uc.execute(
      a.id,
      { status: AppointmentStatus.CANCELLED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(update).toHaveBeenCalledWith(
      a.id,
      expect.objectContaining({ audit: ctx(ClinicRole.RECEPTION) }),
    );
  });

  it('«Deshacer llegada» también lo devuelve', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    repo.reservedElsewhere.set(a.id, [reserved('future-1')]);
    const undone = await uc.undoArrival(a.id, ctx(ClinicRole.RECEPTION));
    expect(undone.planItemsReservedElsewhere).toEqual([reserved('future-1')]);
  });
});

describe('UpdateAppointmentUseCase · «Traer a esta cita» (DX-273)', () => {
  it.each([
    AppointmentStatus.ARRIVED,
    AppointmentStatus.IN_CHAIR,
    AppointmentStatus.READY_FOR_CHECKOUT,
  ])(
    'con el paciente en la clínica (%s): mueve la reserva y devuelve la cita sin el aviso',
    async (status) => {
      const { repo, uc } = setup();
      const a = todayAppointment(repo, status);
      repo.reservedElsewhere.set(a.id, [reserved('future-1')]);
      const result = await uc.claimPlanItem(
        a.id,
        'item-1',
        ctx(ClinicRole.RECEPTION),
      );
      expect(repo.claims).toEqual([
        {
          appointmentId: a.id,
          planItemId: 'item-1',
          audit: ctx(ClinicRole.RECEPTION),
        },
      ]);
      expect(result.id).toBe(a.id);
      expect(result.planItemsReservedElsewhere).toEqual([]);
      expect(result.warnings).toEqual([]);
    },
  );

  it.each([
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
  ])('con la cita en %s: 409 y nada se mueve', async (status) => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, status);
    const attempt = uc.claimPlanItem(a.id, 'item-1', ctx(ClinicRole.ADMIN));
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(PLAN_ITEM_CLAIM_MESSAGES.notInClinic);
    expect(repo.claims).toEqual([]);
  });

  it('cita que no existe: 404', async () => {
    const { uc } = setup();
    await expect(
      uc.claimPlanItem('missing', 'item-1', ctx(ClinicRole.ADMIN)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('DX-288: dos citas en la clínica traen el mismo tratamiento a la vez: una lo trae y la otra recibe el 409 del repositorio, sin segundo traslado', async () => {
    const { repo, uc } = setup();
    const first = todayAppointment(repo, AppointmentStatus.ARRIVED);
    const second = todayAppointment(repo, AppointmentStatus.IN_CHAIR);
    repo.reservedElsewhere.set(first.id, [reserved('future-1')]);
    repo.reservedElsewhere.set(second.id, [reserved('future-1')]);
    const outcomes = await Promise.allSettled(
      [first, second].map((a) =>
        uc.claimPlanItem(a.id, 'item-1', ctx(ClinicRole.RECEPTION)),
      ),
    );
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    const loser = (outcomes[1] as PromiseRejectedResult).reason as unknown;
    expect(loser).toBeInstanceOf(ConflictException);
    expect((loser as ConflictException).message).toBe(
      PLAN_ITEM_CLAIM_HELD_IN_CLINIC_MESSAGE,
    );
    expect(repo.claims.map((c) => c.appointmentId)).toEqual([first.id]);
  });
});
