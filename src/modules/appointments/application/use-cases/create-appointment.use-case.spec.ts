import { BadRequestException, ConflictException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { CreateAppointmentUseCase } from './create-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
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
    create: (input: CreateAppointmentRepoInput): Promise<Appointment> =>
      Promise.resolve(
        fakeAppointment({
          patientId: input.patientId,
          providerId: input.providerId,
          start: input.start,
          end: input.end,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          createdById: input.createdById ?? null,
        }),
      ),
    findById: (): Promise<Appointment | null> => Promise.resolve(null),
    listByRange: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    update: (): Promise<Appointment> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('CreateAppointmentUseCase', () => {
  const start = new Date('2026-08-01T10:00:00.000Z');
  const end = new Date('2026-08-01T10:30:00.000Z');

  it('creates an appointment and returns the mapped entity when there is no overlap', async () => {
    const repo = makeRepo();
    const uc = new CreateAppointmentUseCase(repo);

    const result = await uc.execute({
      patientId: 'p1',
      providerId: 'prov1',
      start,
      end,
      createdById: 'u1',
    });

    expect(result.patientId).toBe('p1');
    expect(result.providerId).toBe('prov1');
    expect(result.status).toBe(AppointmentStatus.SCHEDULED);
    expect(result.createdById).toBe('u1');
  });

  it('rejects when end <= start with BadRequestException (equal instants)', async () => {
    const repo = makeRepo();
    const uc = new CreateAppointmentUseCase(repo);

    await expect(
      uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end: start,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when end < start with BadRequestException', async () => {
    const repo = makeRepo();
    const uc = new CreateAppointmentUseCase(repo);

    await expect(
      uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end: new Date(start.getTime() - 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects with ConflictException when the repository reports an overlapping appointment', async () => {
    const conflicting = fakeAppointment({ id: 'a-existing' });
    const repo = makeRepo({
      findOverlapping: (): Promise<Appointment[]> =>
        Promise.resolve([conflicting]),
      create: (): Promise<Appointment> =>
        Promise.reject(new Error('create should not be called on conflict')),
    });
    const uc = new CreateAppointmentUseCase(repo);

    await expect(
      uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('checks overlap against the given providerId/start/end before creating', async () => {
    let checked: { providerId: string; start: Date; end: Date } | undefined;
    const repo = makeRepo({
      findOverlapping: (
        providerId: string,
        s: Date,
        e: Date,
      ): Promise<Appointment[]> => {
        checked = { providerId, start: s, end: e };
        return Promise.resolve([]);
      },
    });
    const uc = new CreateAppointmentUseCase(repo);

    await uc.execute({ patientId: 'p1', providerId: 'prov1', start, end });

    expect(checked).toEqual({ providerId: 'prov1', start, end });
  });

  it('never forwards a tenantId/status sneaked into the input to the repository', async () => {
    let captured: CreateAppointmentRepoInput | undefined;
    const repo = makeRepo({
      create: (input: CreateAppointmentRepoInput): Promise<Appointment> => {
        captured = input;
        return Promise.resolve(fakeAppointment());
      },
    });
    const uc = new CreateAppointmentUseCase(repo);

    const maliciousInput = {
      patientId: 'p1',
      providerId: 'prov1',
      start,
      end,
      tenantId: 'sneaky-tenant',
      status: AppointmentStatus.COMPLETED,
    } as unknown as Parameters<typeof uc.execute>[0];

    await uc.execute(maliciousInput);

    expect(captured && 'tenantId' in captured).toBe(false);
    expect(captured && 'status' in captured).toBe(false);
  });
});
