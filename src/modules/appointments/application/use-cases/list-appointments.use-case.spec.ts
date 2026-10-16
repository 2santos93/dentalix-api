import { BadRequestException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { ListAppointmentsUseCase } from './list-appointments.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  ListAppointmentsByRangeParams,
} from '../../domain/ports/appointment-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';

function fakeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    tenantId: 't1',
    locationId: 'loc1',
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
    listUpcoming: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> =>
      Promise.resolve([]),
    update: (): Promise<never> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

// Personal activo de la clínica: los ids que `providerIds` puede pedir.
function makeStaff(ids: string[] = ['prov1', 'prov2']): StaffRepository {
  return {
    listActive: (): Promise<never> =>
      Promise.resolve(
        ids.map((userId) => ({ userId, fullName: userId, role: 'DENTIST' })),
      ) as Promise<never>,
  } as unknown as StaffRepository;
}

describe('ListAppointmentsUseCase', () => {
  const from = new Date('2026-08-01T00:00:00.000Z');
  const to = new Date('2026-08-02T00:00:00.000Z');

  it('forwards from/to/providerId to the repository and returns its result untouched (ASC by start is the repo contract)', async () => {
    const a1 = fakeAppointment({
      id: 'a1',
      start: new Date('2026-08-01T09:00:00.000Z'),
    });
    const a2 = fakeAppointment({
      id: 'a2',
      start: new Date('2026-08-01T11:00:00.000Z'),
    });
    let received: ListAppointmentsByRangeParams | undefined;
    const repo = makeRepo({
      listByRange: (
        params: ListAppointmentsByRangeParams,
      ): Promise<Appointment[]> => {
        received = params;
        return Promise.resolve([a1, a2]);
      },
    });
    const uc = new ListAppointmentsUseCase(repo, makeStaff());

    const result = await uc.execute({ from, to, providerId: 'prov1' });

    expect(received).toEqual({
      from,
      to,
      providerId: 'prov1',
      providerIds: undefined,
      locationId: undefined,
    });
    expect(result).toEqual([a1, a2]);
  });

  it('works without a providerId filter (lists across all providers)', async () => {
    let received: ListAppointmentsByRangeParams | undefined;
    const repo = makeRepo({
      listByRange: (
        params: ListAppointmentsByRangeParams,
      ): Promise<Appointment[]> => {
        received = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListAppointmentsUseCase(repo, makeStaff());

    await uc.execute({ from, to });

    expect(received).toEqual({
      from,
      to,
      providerId: undefined,
      providerIds: undefined,
      locationId: undefined,
    });
  });

  // DX-121: columnas de la vista Día.
  describe('providerIds (columnas por profesional)', () => {
    it('pasa los profesionales (sin repetir) y la sede al repositorio', async () => {
      let received: ListAppointmentsByRangeParams | undefined;
      const repo = makeRepo({
        listByRange: (
          params: ListAppointmentsByRangeParams,
        ): Promise<Appointment[]> => {
          received = params;
          return Promise.resolve([]);
        },
      });
      const uc = new ListAppointmentsUseCase(repo, makeStaff());

      await uc.execute({
        from,
        to,
        providerIds: ['prov1', 'prov2', 'prov1'],
        locationId: 'loc1',
      });

      expect(received).toMatchObject({
        providerIds: ['prov1', 'prov2'],
        locationId: 'loc1',
      });
    });

    it('rechaza con 400 un id que no es del personal activo de la clínica', async () => {
      const uc = new ListAppointmentsUseCase(makeRepo(), makeStaff(['prov1']));
      await expect(
        uc.execute({ from, to, providerIds: ['prov1', 'de-otra-clinica'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza más de 12 profesionales', async () => {
      const ids = Array.from({ length: 13 }, (_, i) => `prov${i}`);
      const uc = new ListAppointmentsUseCase(makeRepo(), makeStaff(ids));
      await expect(uc.execute({ from, to, providerIds: ids })).rejects.toThrow(
        /12/,
      );
    });
  });
});
