import { NotFoundException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { GetAppointmentUseCase } from './get-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';

function fakeAppointment(id: string): Appointment {
  return {
    id,
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
  };
}

function makeRepo(
  overrides: Partial<AppointmentRepository> = {},
): AppointmentRepository {
  return {
    create: (input: CreateAppointmentRepoInput): Promise<Appointment> =>
      Promise.reject(
        new Error(
          `not implemented in this fake: create(${JSON.stringify(input)})`,
        ),
      ),
    findById: (): Promise<Appointment | null> => Promise.resolve(null),
    listByRange: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
    update: (): Promise<Appointment> =>
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
    const uc = new GetAppointmentUseCase(repo);

    const result = await uc.execute('a1');

    expect(result).toBe(appointment);
  });

  it('throws NotFoundException when the repository returns null (absent or another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Appointment | null> => Promise.resolve(null),
    });
    const uc = new GetAppointmentUseCase(repo);

    await expect(uc.execute('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
