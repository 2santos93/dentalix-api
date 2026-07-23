import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { UpdateAppointmentUseCase } from './update-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';

function fakeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    tenantId: 't1',
    patientId: 'p1',
    providerId: 'prov1',
    start: new Date('2026-08-01T10:00:00.000Z'),
    end: new Date('2026-08-01T10:30:00.000Z'),
    status: AppointmentStatus.SCHEDULED,
    reason: null,
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<AppointmentRepository> = {},
): AppointmentRepository {
  return {
    create: (): Promise<Appointment> =>
      Promise.reject(new Error('not implemented in this fake')),
    findById: (): Promise<Appointment | null> => Promise.resolve(null),
    listByRange: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    update: (): Promise<Appointment> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('UpdateAppointmentUseCase', () => {
  it('throws NotFoundException when the appointment does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Appointment | null> => Promise.resolve(null),
      update: (): Promise<Appointment> =>
        Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateAppointmentUseCase(repo);

    await expect(
      uc.execute('missing-id', { status: AppointmentStatus.CONFIRMED }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('changes status without touching overlap checks when start/end are not in the patch', async () => {
    const existing = fakeAppointment();
    const updated = fakeAppointment({ status: AppointmentStatus.CONFIRMED });
    let overlapChecked = false;
    let receivedPatch: UpdateAppointmentRepoInput | undefined;
    const repo = makeRepo({
      findById: (id: string): Promise<Appointment | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      findOverlapping: (): Promise<Appointment[]> => {
        overlapChecked = true;
        return Promise.resolve([]);
      },
      update: (
        _id: string,
        patch: UpdateAppointmentRepoInput,
      ): Promise<Appointment> => {
        receivedPatch = patch;
        return Promise.resolve(updated);
      },
    });
    const uc = new UpdateAppointmentUseCase(repo);

    const result = await uc.execute(existing.id, {
      status: AppointmentStatus.CONFIRMED,
    });

    expect(result).toBe(updated);
    expect(receivedPatch).toEqual({ status: AppointmentStatus.CONFIRMED });
    expect(overlapChecked).toBe(false);
  });

  it('reschedules (start/end) and re-checks overlap EXCLUDING its own id', async () => {
    const existing = fakeAppointment();
    const newStart = new Date('2026-08-01T14:00:00.000Z');
    const newEnd = new Date('2026-08-01T14:30:00.000Z');
    const updated = fakeAppointment({ start: newStart, end: newEnd });
    let overlapArgs:
      | { providerId: string; start: Date; end: Date; excludeId?: string }
      | undefined;
    const repo = makeRepo({
      findById: (id: string): Promise<Appointment | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      findOverlapping: (
        providerId: string,
        start: Date,
        end: Date,
        excludeId?: string,
      ): Promise<Appointment[]> => {
        overlapArgs = { providerId, start, end, excludeId };
        return Promise.resolve([]);
      },
      update: (): Promise<Appointment> => Promise.resolve(updated),
    });
    const uc = new UpdateAppointmentUseCase(repo);

    const result = await uc.execute(existing.id, {
      start: newStart,
      end: newEnd,
    });

    expect(result).toBe(updated);
    expect(overlapArgs).toEqual({
      providerId: existing.providerId,
      start: newStart,
      end: newEnd,
      excludeId: existing.id,
    });
  });

  it('rejects reschedule with ConflictException when the re-check (excluding self) finds another overlapping appointment', async () => {
    const existing = fakeAppointment();
    const other = fakeAppointment({ id: 'a-other' });
    const repo = makeRepo({
      findById: (id: string): Promise<Appointment | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      findOverlapping: (): Promise<Appointment[]> => Promise.resolve([other]),
      update: (): Promise<Appointment> =>
        Promise.reject(new Error('update should not be called on conflict')),
    });
    const uc = new UpdateAppointmentUseCase(repo);

    await expect(
      uc.execute(existing.id, {
        start: new Date('2026-08-01T14:00:00.000Z'),
        end: new Date('2026-08-01T14:30:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reschedule with BadRequestException when the resulting end <= start (only end provided, before existing start)', async () => {
    const existing = fakeAppointment();
    const repo = makeRepo({
      findById: (id: string): Promise<Appointment | null> =>
        Promise.resolve(id === existing.id ? existing : null),
      update: (): Promise<Appointment> =>
        Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateAppointmentUseCase(repo);

    await expect(
      uc.execute(existing.id, {
        end: new Date(existing.start.getTime() - 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
