import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import { CANCELLATION_MESSAGES } from '../../../cancellation-policies/domain/cancellation-policy';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import {
  UpdateAppointmentUseCase,
  type AppointmentAuditContext,
} from './update-appointment.use-case';

const HOUR = 3_600_000;

const ctx: AppointmentAuditContext = {
  tenantId: 't1',
  locationId: 'loc1',
  actor: { userId: 'u-rec', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

function setup() {
  const repo = new InMemoryAppointmentRepository();
  const drafts: AuditEventDraft[] = [];
  const tenantContext = new TenantContextService();
  const uc = new UpdateAppointmentUseCase(
    repo,
    {
      findByLocation: () => Promise.resolve(null),
    } as unknown as LocationScheduleRepository,
    {
      findById: (userId: string) => Promise.resolve({ userId }),
    } as unknown as StaffRepository,
    {
      record: (draft: AuditEventDraft) => {
        drafts.push(draft);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase,
    new InMemoryScheduleBlockRepository(),
    {
      findById: (id: string) =>
        Promise.resolve({ id, timeZone: 'America/Bogota' }),
    } as unknown as LocationRepository,
    tenantContext,
    inMemoryAvailability(),
  );
  return { repo, drafts, uc, tenantContext };
}

/** Una cita que empieza dentro de `hours` horas (desde el reloj real). */
function inHours(repo: InMemoryAppointmentRepository, hours: number) {
  const start = new Date(Date.now() + hours * HOUR);
  return repo.seed({ start, end: new Date(start.getTime() + 30 * 60_000) });
}

describe('Cancelar desde la agenda (DX-279)', () => {
  it('sin origen: 400 en español y la cita no cambia', async () => {
    const { repo, uc } = setup();
    const a = inHours(repo, 5);
    const attempt = uc.execute(
      a.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: { reasonCode: 'ILLNESS' },
      },
      ctx,
    );
    await expect(attempt).rejects.toEqual(
      new BadRequestException(CANCELLATION_MESSAGES.byKindRequired),
    );
    expect((await repo.findById(a.id))!.status).toBe(
      AppointmentStatus.SCHEDULED,
    );
  });

  it('sin motivo: 400 en español y la cita no cambia', async () => {
    const { repo, uc } = setup();
    const a = inHours(repo, 5);
    await expect(
      uc.execute(a.id, { status: AppointmentStatus.CANCELLED }, ctx),
    ).rejects.toEqual(
      new BadRequestException(CANCELLATION_MESSAGES.byKindRequired),
    );
    await expect(
      uc.execute(
        a.id,
        {
          status: AppointmentStatus.CANCELLED,
          cancellation: { byKind: 'STAFF_FOR_PATIENT' },
        },
        ctx,
      ),
    ).rejects.toEqual(
      new BadRequestException(CANCELLATION_MESSAGES.reasonRequired),
    );
    expect((await repo.findById(a.id))!.status).toBe(
      AppointmentStatus.SCHEDULED,
    );
  });

  it('5 h antes con una política de 24 h: tardía, con 300 min de aviso, y queda auditada sin el texto', async () => {
    const { repo, uc, drafts } = setup();
    repo.policies.set('loc1', { id: 'pol-1', version: 1, noticeHours: 24 });
    const a = inHours(repo, 5);
    const before = Date.now();
    const result = await uc.execute(
      a.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: 'TRANSPORT',
          reasonText: '  No consigue transporte  ',
        },
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: AppointmentStatus.CANCELLED,
      cancelledByKind: 'STAFF_FOR_PATIENT',
      cancelReasonCode: 'TRANSPORT',
      cancelReasonText: 'No consigue transporte',
      lateCancellation: true,
      policyVersionId: null,
    });
    expect([299, 300]).toContain(result.noticeMinutes);
    expect(result.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before);
    const cancelled = drafts.find(
      (d) => d.metadata.reason === 'APPOINTMENT_CANCELLED',
    );
    expect(cancelled).toMatchObject({
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: a.id,
      metadata: {
        status: { from: 'SCHEDULED', to: 'CANCELLED' },
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: 'TRANSPORT',
          lateCancellation: true,
        },
      },
    });
    expect(JSON.stringify(cancelled)).not.toContain('transporte');
  });

  it('la misma cancelación con origen CLÍNICA nunca es tardía', async () => {
    const { repo, uc } = setup();
    repo.policies.set('loc1', { id: 'pol-1', version: 1, noticeHours: 24 });
    const a = inHours(repo, 5);
    const result = await uc.execute(
      a.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: { byKind: 'CLINIC', reasonCode: 'CLINIC_RESCHEDULE' },
      },
      ctx,
    );
    expect(result).toMatchObject({
      cancelledByKind: 'CLINIC',
      lateCancellation: false,
    });
  });

  it('sin política en la sede nunca es tardía; con 48 h de aviso y política de 24 h, tampoco', async () => {
    const { repo, uc } = setup();
    const a = inHours(repo, 1);
    const sinPolitica = await uc.execute(
      a.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: { byKind: 'STAFF_FOR_PATIENT', reasonCode: 'FORGOT' },
      },
      ctx,
    );
    expect(sinPolitica.lateCancellation).toBe(false);

    repo.policies.set('loc1', { id: 'pol-1', version: 1, noticeHours: 24 });
    const b = inHours(repo, 48);
    const conAviso = await uc.execute(
      b.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: { byKind: 'STAFF_FOR_PATIENT', reasonCode: 'WORK' },
      },
      ctx,
    );
    expect(conAviso.lateCancellation).toBe(false);
  });

  it('marcar NO_SHOW guarda la hora y deja limpia la cancelación; reactivar lo borra todo', async () => {
    const { repo, uc } = setup();
    repo.policies.set('loc1', { id: 'pol-1', version: 1, noticeHours: 24 });
    const a = inHours(repo, 2);
    await uc.execute(
      a.id,
      {
        status: AppointmentStatus.CANCELLED,
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: 'COST',
          reasonText: 'x',
        },
      },
      ctx,
    );
    const noShow = await uc.execute(
      a.id,
      { status: AppointmentStatus.NO_SHOW },
      ctx,
    );
    expect(noShow.noShowMarkedAt).toBeInstanceOf(Date);
    expect(noShow).toMatchObject({
      cancelledAt: null,
      cancelledByKind: null,
      cancelReasonCode: null,
      cancelReasonText: null,
      noticeMinutes: null,
      lateCancellation: null,
    });
    const back = await uc.execute(
      a.id,
      { status: AppointmentStatus.SCHEDULED },
      ctx,
    );
    expect(back.noShowMarkedAt).toBeNull();
    expect(back.status).toBe(AppointmentStatus.SCHEDULED);
  });

  it('el origen y el motivo se ignoran si la cita no pasa a CANCELLED', async () => {
    const { repo, uc } = setup();
    const a = inHours(repo, 5);
    const result = await uc.execute(
      a.id,
      {
        status: AppointmentStatus.CONFIRMED,
        cancellation: { byKind: 'CLINIC', reasonCode: 'OTHER' },
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: 'CONFIRMED',
      cancelledByKind: null,
    });
  });
});

describe('Vista previa del aviso (DX-279)', () => {
  it('dice los minutos que faltan y si sería tardía con la política vigente', async () => {
    const { repo, uc } = setup();
    repo.policies.set('loc1', { id: 'pol-2', version: 2, noticeHours: 24 });
    const a = inHours(repo, 5);
    const preview = await uc.cancellationPreview(a.id);
    expect(preview).toMatchObject({
      appointmentId: a.id,
      lateCancellation: true,
      policy: { id: 'pol-2', version: 2, noticeHours: 24 },
    });
    expect([299, 300]).toContain(preview.noticeMinutes);
  });

  it('sin política: nunca tardía y `policy` null', async () => {
    const { repo, uc } = setup();
    const a = inHours(repo, 1);
    await expect(uc.cancellationPreview(a.id)).resolves.toMatchObject({
      lateCancellation: false,
      policy: null,
    });
  });

  it('404 si no existe y 403 si es de una sede no permitida (DX-089)', async () => {
    const { repo, uc, tenantContext } = setup();
    await expect(uc.cancellationPreview('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const a = inHours(repo, 5);
    await expect(
      tenantContext.run('t1', undefined, () => uc.cancellationPreview(a.id), [
        'loc2',
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
