import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { ListAppointmentsUseCase } from './list-appointments.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  ListAppointmentsByRangeParams,
} from '../../domain/ports/appointment-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../../../staff/domain/provider-location';

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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
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
    create: (): Promise<Appointment> =>
      Promise.reject(new Error('not implemented in this fake')),
    findById: (): Promise<Appointment | null> => Promise.resolve(null),
    listByRange: (): Promise<Appointment[]> => Promise.resolve([]),
    listUpcoming: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> =>
      Promise.resolve([]),
    undoArrival: () => Promise.resolve(null),
    listInClinic: () => Promise.resolve([]),
    currentCancellationPolicy: () => Promise.resolve(null),
    update: (): Promise<never> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

// Personal activo de la clínica: los ids que `providerIds` puede pedir.
// `locations`: sedes en las que atiende cada uno (DX-121d; sin entrada = todas).
function makeStaff(
  ids: string[] = ['prov1', 'prov2'],
  locations: Record<string, string[]> = {},
): StaffRepository {
  return {
    listActive: (): Promise<never> =>
      Promise.resolve(
        ids.map((userId) => ({
          userId,
          fullName: userId,
          role: 'DENTIST',
          locationIds: locations[userId] ?? null,
        })),
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
    const uc = new ListAppointmentsUseCase(
      repo,
      makeStaff(),
      new TenantContextService(),
    );

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
    const uc = new ListAppointmentsUseCase(
      repo,
      makeStaff(),
      new TenantContextService(),
    );

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
      const uc = new ListAppointmentsUseCase(
        repo,
        makeStaff(),
        new TenantContextService(),
      );

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
      const uc = new ListAppointmentsUseCase(
        makeRepo(),
        makeStaff(['prov1']),
        new TenantContextService(),
      );
      await expect(
        uc.execute({ from, to, providerIds: ['prov1', 'de-otra-clinica'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza más de 12 profesionales', async () => {
      const ids = Array.from({ length: 13 }, (_, i) => `prov${i}`);
      const uc = new ListAppointmentsUseCase(
        makeRepo(),
        makeStaff(ids),
        new TenantContextService(),
      );
      await expect(uc.execute({ from, to, providerIds: ids })).rejects.toThrow(
        /12/,
      );
    });
  });

  // DX-089 / DX-121d.
  describe('sedes permitidas y profesional ↔ sede', () => {
    const tenantContext = new TenantContextService();
    const asRestricted = <T>(fn: () => Promise<T>, header?: string) =>
      tenantContext.run('t1', header, fn, ['loc1']);

    it('una sede explícita no permitida es 403', async () => {
      const uc = new ListAppointmentsUseCase(
        makeRepo(),
        makeStaff(),
        tenantContext,
      );
      await expect(
        asRestricted(() => uc.execute({ from, to, locationId: 'loc2' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        asRestricted(() => uc.execute({ from, to, locationId: 'loc1' })),
      ).resolves.toEqual([]);
    });

    it('un profesional que no atiende en la sede objetivo es 400', async () => {
      const uc = new ListAppointmentsUseCase(
        makeRepo(),
        makeStaff(['prov1', 'prov2'], { prov1: ['loc1'] }),
        tenantContext,
      );
      await expect(
        uc.execute({ from, to, providerIds: ['prov1'], locationId: 'loc2' }),
      ).rejects.toThrow(PROVIDER_NOT_AT_LOCATION_MESSAGE);
      // La sede objetivo también puede ser la del request.
      await expect(
        tenantContext.run('t1', 'loc2', () =>
          uc.execute({ from, to, providerIds: ['prov1'] }),
        ),
      ).rejects.toThrow(PROVIDER_NOT_AT_LOCATION_MESSAGE);
      // Sin restricción atiende en todas; sin sede objetivo no se comprueba.
      await expect(
        uc.execute({ from, to, providerIds: ['prov2'], locationId: 'loc2' }),
      ).resolves.toEqual([]);
      await expect(
        uc.execute({ from, to, providerIds: ['prov1'] }),
      ).resolves.toEqual([]);
    });
  });
});
