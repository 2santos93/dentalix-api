import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
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

// DX-200: el flujo del paciente en la clínica en UpdateAppointmentUseCase
// (llegó → en sillón → listo para cobrar → completada, y «Deshacer llegada»),
// con la máquina de transiciones, las horas, los permisos y la auditoría.

const TZ = 'America/Bogota';
const HOUR = 60 * 60 * 1000;

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
  );
  return { repo, uc, drafts };
}

/** Una cita de hoy que no cruza la medianoche de Bogotá. */
function todayAppointment(
  repo: InMemoryAppointmentRepository,
  status: AppointmentStatus = AppointmentStatus.CONFIRMED,
) {
  // Dentro de 30 min, o antes si eso ya cae mañana en Bogotá: la llegada solo
  // depende del DÍA civil de la cita.
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

describe('UpdateAppointmentUseCase · flujo del paciente (DX-200)', () => {
  it('llegó → en sillón → listo para cobrar → completada, con sus horas', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);

    const arrived = await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(arrived.status).toBe(AppointmentStatus.ARRIVED);
    expect(arrived.arrivedAt).toBeInstanceOf(Date);
    expect(arrived.seatedAt).toBeNull();

    const seated = await uc.execute(
      a.id,
      { status: AppointmentStatus.IN_CHAIR },
      ctx(ClinicRole.DENTIST),
    );
    expect(seated.seatedAt).toBeInstanceOf(Date);
    expect(seated.arrivedAt).toEqual(arrived.arrivedAt);

    const ready = await uc.execute(
      a.id,
      { status: AppointmentStatus.READY_FOR_CHECKOUT },
      ctx(ClinicRole.ASSISTANT),
    );
    expect(ready.readyForCheckoutAt).toBeInstanceOf(Date);

    const done = await uc.execute(
      a.id,
      { status: AppointmentStatus.COMPLETED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(done.status).toBe(AppointmentStatus.COMPLETED);
    // Las horas quedan como registro de la visita.
    expect(done.arrivedAt).toEqual(arrived.arrivedAt);
    expect(done.readyForCheckoutAt).toEqual(ready.readyForCheckoutAt);
  });

  it('COMPLETED sigue disponible desde agendada (las citas de siempre)', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    const done = await uc.execute(
      a.id,
      { status: AppointmentStatus.COMPLETED },
      ctx(ClinicRole.DENTIST),
    );
    expect(done.status).toBe(AppointmentStatus.COMPLETED);
    expect(done.arrivedAt).toBeNull();
  });

  it('el odontólogo no marca la llegada (403) y recepción no lo sienta (403)', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.DENTIST),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.IN_CHAIR },
        ctx(ClinicRole.RECEPTION),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin saltos imposibles: de agendada a «En sillón» es 409', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.IN_CHAIR },
        ctx(ClinicRole.ADMIN),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un paciente que llegó no puede quedar como no-show', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.NO_SHOW },
        ctx(ClinicRole.ADMIN),
      ),
    ).rejects.toThrow(/no es una inasistencia/);
  });

  it('la llegada solo se marca el día de la cita (zona de la sede)', async () => {
    const { repo, uc } = setup();
    const start = new Date(Date.now() + 3 * 24 * HOUR);
    const a = repo.seed({ start, end: new Date(start.getTime() + HOUR) });
    expect(civilDateIn(start, TZ)).not.toBe(civilDateIn(new Date(), TZ));
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      ),
    ).rejects.toThrow(/día de la cita/);
  });

  it('deja auditados los pasos del flujo, con el estado antes y después', async () => {
    const { repo, uc, drafts } = setup();
    const a = todayAppointment(repo);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    await uc.execute(
      a.id,
      { status: AppointmentStatus.IN_CHAIR },
      ctx(ClinicRole.DENTIST),
    );
    expect(drafts.map((d) => d.metadata)).toEqual([
      { reason: 'PATIENT_FLOW', status: { from: 'CONFIRMED', to: 'ARRIVED' } },
      { reason: 'PATIENT_FLOW', status: { from: 'ARRIVED', to: 'IN_CHAIR' } },
    ]);
    expect(drafts[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: a.id,
      patient: { kind: 'patient', id: a.patientId },
      actor: { kind: 'user', role: ClinicRole.RECEPTION },
    });
  });

  it('el cambio es condicional: si otro ya cambió el estado, 409 y nada cambia', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    // Entre la lectura y la escritura otra persona deshizo la llegada.
    const original = repo.findById.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const found = await original(id);
      if (calls++ === 0) await repo.undoArrival(id);
      return found;
    });
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.IN_CHAIR },
        ctx(ClinicRole.DENTIST),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await original(a.id))?.status).toBe(AppointmentStatus.CONFIRMED);
  });

  it('se fue sin pasar al sillón: se cancela, y al reactivarla no quedan horas', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    const cancelled = await uc.execute(
      a.id,
      { status: AppointmentStatus.CANCELLED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(cancelled.arrivedAt).toBeInstanceOf(Date);
    const again = await uc.execute(
      a.id,
      { status: AppointmentStatus.SCHEDULED },
      ctx(ClinicRole.RECEPTION),
    );
    expect(again.arrivedAt).toBeNull();
  });

  it('cualquier cambio de estado es condicional: si llegó mientras tanto, el no-show es 409', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
    // Recepción abrió la cita en SCHEDULED; entre la lectura y la escritura
    // otra persona marcó «Llegó».
    const original = repo.findById.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'findById').mockImplementation(async (id) => {
      const found = await original(id);
      if (calls++ === 0) {
        await repo.update(id, {
          status: AppointmentStatus.ARRIVED,
          arrivedAt: new Date(),
          preArrivalStatus: AppointmentStatus.SCHEDULED,
        });
      }
      return found;
    });
    await expect(
      uc.execute(
        a.id,
        { status: AppointmentStatus.NO_SHOW },
        ctx(ClinicRole.RECEPTION),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await original(a.id))?.status).toBe(AppointmentStatus.ARRIVED);
  });

  it('una cita a la que el paciente llegó nunca pasa a no-show (ni tras cancelarla o completarla)', async () => {
    const { repo, uc } = setup();
    const left = todayAppointment(repo);
    await uc.execute(
      left.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    await uc.execute(
      left.id,
      { status: AppointmentStatus.CANCELLED },
      ctx(ClinicRole.RECEPTION),
    );
    await expect(
      uc.execute(
        left.id,
        { status: AppointmentStatus.NO_SHOW },
        ctx(ClinicRole.RECEPTION),
      ),
    ).rejects.toThrow(/no es una inasistencia/);

    const done = todayAppointment(repo);
    await uc.execute(
      done.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    await uc.execute(
      done.id,
      { status: AppointmentStatus.COMPLETED },
      ctx(ClinicRole.RECEPTION),
    );
    await expect(
      uc.execute(
        done.id,
        { status: AppointmentStatus.NO_SHOW },
        ctx(ClinicRole.ADMIN),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await repo.findById(done.id))?.status).toBe(
      AppointmentStatus.COMPLETED,
    );
  });

  it('con el paciente en la clínica la cita no se mueve a otro día', async () => {
    const { repo, uc } = setup();
    const a = todayAppointment(repo);
    await uc.execute(
      a.id,
      { status: AppointmentStatus.ARRIVED },
      ctx(ClinicRole.RECEPTION),
    );
    const start = new Date(a.start.getTime() + 24 * HOUR);
    await expect(
      uc.execute(
        a.id,
        { start, end: new Date(start.getTime() + 30 * 60 * 1000) },
        ctx(ClinicRole.RECEPTION),
      ),
    ).rejects.toThrow(/en la clínica/);
    expect((await repo.findById(a.id))?.start).toEqual(a.start);
  });

  describe('«Deshacer llegada»', () => {
    it('vuelve al estado anterior, borra la hora y queda en auditoría', async () => {
      const { repo, uc, drafts } = setup();
      const a = todayAppointment(repo, AppointmentStatus.CONFIRMED);
      await uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      );

      const undone = await uc.undoArrival(a.id, ctx(ClinicRole.ASSISTANT));
      expect(undone.status).toBe(AppointmentStatus.CONFIRMED);
      expect(undone.arrivedAt).toBeNull();
      expect(drafts.at(-1)).toMatchObject({
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        resourceId: a.id,
        metadata: {
          reason: 'ARRIVAL_UNDONE',
          status: { from: 'ARRIVED', to: 'CONFIRMED' },
        },
      });
    });

    it('una cita agendada vuelve a agendada', async () => {
      const { repo, uc } = setup();
      const a = todayAppointment(repo, AppointmentStatus.SCHEDULED);
      await uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      );
      const undone = await uc.undoArrival(a.id, ctx(ClinicRole.RECEPTION));
      expect(undone.status).toBe(AppointmentStatus.SCHEDULED);
    });

    it('solo desde «En espera»: con el paciente en el sillón es 409', async () => {
      const { repo, uc } = setup();
      const a = todayAppointment(repo);
      await uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      );
      await uc.execute(
        a.id,
        { status: AppointmentStatus.IN_CHAIR },
        ctx(ClinicRole.DENTIST),
      );
      await expect(
        uc.undoArrival(a.id, ctx(ClinicRole.RECEPTION)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('el odontólogo no la deshace (403); una cita ajena o inexistente es 404', async () => {
      const { repo, uc } = setup();
      const a = todayAppointment(repo);
      await uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      );
      await expect(
        uc.undoArrival(a.id, ctx(ClinicRole.DENTIST)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        uc.undoArrival('nope', ctx(ClinicRole.RECEPTION)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('un PATCH directo a agendada desde «Llegó» indica «Deshacer llegada»', async () => {
      const { repo, uc } = setup();
      const a = todayAppointment(repo);
      await uc.execute(
        a.id,
        { status: AppointmentStatus.ARRIVED },
        ctx(ClinicRole.RECEPTION),
      );
      await expect(
        uc.execute(
          a.id,
          { status: AppointmentStatus.SCHEDULED },
          ctx(ClinicRole.RECEPTION),
        ),
      ).rejects.toThrow(/Deshacer llegada/);
    });
  });
});
