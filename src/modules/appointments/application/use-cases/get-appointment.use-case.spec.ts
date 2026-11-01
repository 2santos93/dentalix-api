import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { GetAppointmentUseCase } from './get-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

function fakeAppointment(id: string): Appointment {
  return {
    id,
    tenantId: 't1',
    locationId: 'loc-1',
    patientId: 'p1',
    patientFirstName: null,
    patientLastName: null,
    providerId: 'prov1',
    start: new Date('2026-08-01T10:00:00.000Z'),
    end: new Date('2026-08-01T10:30:00.000Z'),
    status: AppointmentStatus.SCHEDULED,
    reason: null,
    notes: null,
    createdById: null,
    appointmentTypeId: null,
    appointmentType: null,
    confirmationSentAt: null,
    callbackRequestedAt: null,
    wantsEarlier: false,
    arrivedAt: null,
    seatedAt: null,
    readyForCheckoutAt: null,
    cancelledAt: null,
    cancelledByKind: null,
    cancelReasonCode: null,
    cancelReasonText: null,
    noticeMinutes: null,
    lateCancellation: null,
    noShowMarkedAt: null,
    policyVersionId: null,
    triageFlags: [],
    triageNote: null,
    walkIn: false,
    overbooked: false,
    chairId: null,
    chair: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeRepo(
  overrides: Partial<AppointmentRepository> = {},
): AppointmentRepository {
  return {
    resolveWriteLocationId: () => Promise.resolve('loc1'),
    findPlanItemsReservedElsewhere: () => Promise.resolve(new Map()),
    claimPlanItem: () =>
      Promise.reject(new Error('not implemented in this fake')),
    create: (input: CreateAppointmentRepoInput): Promise<Appointment> =>
      Promise.reject(
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<Appointment | null> => Promise.resolve(null),
    listByRange: (): Promise<Appointment[]> => Promise.resolve([]),
    listUpcoming: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> =>
      Promise.resolve([]),
    findOverlappingForChair: (): Promise<Appointment[]> => Promise.resolve([]),
    undoArrival: () => Promise.resolve(null),
    listInClinic: () => Promise.resolve([]),
    currentCancellationPolicy: () => Promise.resolve(null),
    update: (): Promise<never> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('GetAppointmentUseCase', () => {
  it('returns the appointment when found', async () => {
    const appointment = fakeAppointment('a1');
    const repo = makeRepo({
      findById: (id: string): Promise<Appointment | null> =>
        Promise.resolve(id === 'a1' ? appointment : null),
    });
    const uc = new GetAppointmentUseCase(repo, new TenantContextService());

    const result = await uc.execute('a1');

    expect(result).toBe(appointment);
  });

  it('throws NotFoundException when the repository returns null (absent or another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Appointment | null> => Promise.resolve(null),
    });
    const uc = new GetAppointmentUseCase(repo, new TenantContextService());

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// DX-089: una cita de una sede no permitida es 403, no 404 (existe).
describe('GetAppointmentUseCase · sedes permitidas', () => {
  it('403 si la cita es de una sede que el miembro no tiene', async () => {
    const tenantContext = new TenantContextService();
    const repo = makeRepo({
      findById: (): Promise<Appointment | null> =>
        Promise.resolve({ ...fakeAppointment('a1'), locationId: 'loc2' }),
    });
    const uc = new GetAppointmentUseCase(repo, tenantContext);
    await expect(
      tenantContext.run('t1', undefined, () => uc.execute('a1'), ['loc1']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      tenantContext.run('t1', undefined, () => uc.execute('a1'), ['loc2']),
    ).resolves.toMatchObject({ id: 'a1' });
  });
});
