import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { UpdateAppointmentUseCase } from './update-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryWaitlistRepository } from '../../../waitlist/application/__fixtures__/in-memory-waitlist';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { BusinessHours } from '../../../location-schedule/application/business-hours';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { AppointmentAuditContext } from './update-appointment.use-case';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../../../staff/domain/provider-location';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';

// Todas las horas de los fixtures son un `HH:MM` fijo sobre un día que SIEMPRE
// está en el FUTURO respecto de la corrida, porque Create/UpdateAppointment
// ahora rechazan un `start` en el pasado. Anclar el día (en vez de hardcodear
// una fecha) mantiene intactas las relaciones de solape entre los literales de
// abajo y evita que el spec se podra al pasar esa fecha.
const ANCHOR_DAY = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
function at(time: string): Date {
  return new Date(`${ANCHOR_DAY}T${time}:00.000Z`);
}

function fakeAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'a1',
    tenantId: 't1',
    locationId: 'loc1',
    patientId: 'p1',
    patientFirstName: null,
    patientLastName: null,
    providerId: 'prov1',
    start: at('10:00'),
    end: at('10:30'),
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Los dobles de `update` de este spec devuelven la cita; el puerto devuelve
 * además la entrada de pendientes creada (DX-122), que aquí no se crea.
 */
type RepoOverrides = Partial<Omit<AppointmentRepository, 'update'>> & {
  update?: (
    id: string,
    patch: UpdateAppointmentRepoInput,
  ) => Promise<Appointment>;
};

function makeRepo(overrides: RepoOverrides = {}): AppointmentRepository {
  const { update, ...rest } = overrides;
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
    ...rest,
    update: (id: string, patch: UpdateAppointmentRepoInput) =>
      update
        ? update(id, patch).then((appointment) => ({
            appointment,
            waitlistEntryId: null,
            reopenedWaitlistEntryId: null,
            resolvedWaitlistEntryId: null,
          }))
        : Promise.reject(new Error('not implemented in this fake')),
  };
}

// Bloqueos (DX-122): por defecto la agenda no tiene ninguno.
function makeBlocks(
  repo: InMemoryScheduleBlockRepository = new InMemoryScheduleBlockRepository(),
): ScheduleBlockRepository {
  return repo;
}

// Doble del horario de la sede: por defecto SIN horario configurado (null), que
// el dominio interpreta como "sin restricción" — así los tests existentes siguen
// probando lo suyo sin que el horario interfiera. Los tests del horario lo pasan.
function makeSchedule(hours: unknown = null): LocationScheduleRepository {
  return {
    findByLocation: (): Promise<never> =>
      Promise.resolve(hours) as Promise<never>,
    findForCurrentLocation: (): Promise<never> =>
      Promise.resolve(hours) as Promise<never>,
    replaceForCurrentLocation: (): Promise<never> =>
      Promise.reject(new Error('not implemented in this fake')),
  };
}

// Doble del personal: por defecto cualquier profesional SÍ es de la clínica.
// `known` acota los ids que existen (para el 404 de mover a un desconocido).
function makeStaff(known?: string[]): StaffRepository {
  return {
    findById: (userId: string): Promise<never> =>
      Promise.resolve(
        !known || known.includes(userId) ? { userId } : null,
      ) as Promise<never>,
  } as unknown as StaffRepository;
}

// Doble de las sedes (DX-200): la zona con la que se decide qué día es hoy.
function makeLocations(): LocationRepository {
  return {
    findById: (id: string) =>
      Promise.resolve({ id, timeZone: 'America/Bogota' }),
  } as unknown as LocationRepository;
}

// Doble de la auditoría que guarda lo que recibe.
function makeAudit(drafts: AuditEventDraft[] = []): RecordAuditEventUseCase {
  return {
    record: (draft: AuditEventDraft): Promise<void> => {
      drafts.push(draft);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
}

describe('UpdateAppointmentUseCase', () => {
  it('throws NotFoundException when the appointment does not exist (or belongs to another tenant)', async () => {
    const repo = makeRepo({
      findById: (): Promise<Appointment | null> => Promise.resolve(null),
      update: (): Promise<Appointment> =>
        Promise.reject(new Error('update should not be called')),
    });
    const uc = new UpdateAppointmentUseCase(
      repo,
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );

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
    const uc = new UpdateAppointmentUseCase(
      repo,
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );

    const result = await uc.execute(existing.id, {
      status: AppointmentStatus.CONFIRMED,
    });

    expect(result).toEqual({
      ...updated,
      warnings: [],
      warningCodes: [],
      planItemsReservedElsewhere: [],
    });
    // DX-005: un cambio de estado limpia los indicadores del enlace de confirmación.
    expect(receivedPatch).toEqual({
      status: AppointmentStatus.CONFIRMED,
      confirmationSentAt: null,
      callbackRequestedAt: null,
      // DX-200: el cambio va condicionado al estado leído.
      expectStatus: AppointmentStatus.SCHEDULED,
    });
    expect(overlapChecked).toBe(false);
  });

  it('reschedules (start/end) and re-checks overlap EXCLUDING its own id', async () => {
    const existing = fakeAppointment();
    const newStart = at('14:00');
    const newEnd = at('14:30');
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
    const uc = new UpdateAppointmentUseCase(
      repo,
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );

    const result = await uc.execute(existing.id, {
      start: newStart,
      end: newEnd,
    });

    expect(result).toEqual({
      ...updated,
      warnings: [],
      warningCodes: [],
      planItemsReservedElsewhere: [],
    });
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
    const uc = new UpdateAppointmentUseCase(
      repo,
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );

    await expect(
      uc.execute(existing.id, {
        start: at('14:00'),
        end: at('14:30'),
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
    const uc = new UpdateAppointmentUseCase(
      repo,
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );

    await expect(
      uc.execute(existing.id, {
        end: new Date(existing.start.getTime() - 1000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // These cases go through InMemoryAppointmentRepository's REAL filtering
  // (not a canned findOverlapping stub), so they would fail if the
  // self-exclusion (`excludeId`) or the overlap math regressed.
  describe('overlap enforcement (real in-memory filtering)', () => {
    it('self-exclusion: rescheduling to a slot that only overlaps its own current slot succeeds', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      // Shift by 15 minutes — the new window still overlaps the row's OWN
      // current [10:00,11:00) slot, so if `excludeId` were not applied this
      // would incorrectly self-conflict.
      const result = await uc.execute(existing.id, {
        start: at('10:15'),
        end: at('11:15'),
      });

      expect(result.start).toEqual(at('10:15'));
      expect(result.end).toEqual(at('11:15'));
    });

    it('self-exclusion does not hide a genuine overlap with a DIFFERENT active appointment', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      repo.seed({
        providerId: 'prov1',
        start: at('14:00'),
        end: at('15:00'),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, {
          start: at('14:30'),
          end: at('15:30'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a CANCELLED appointment does not block a reschedule into its former slot', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        id: 'to-reschedule',
        providerId: 'prov1',
        start: at('09:00'),
        end: at('09:30'),
      });
      repo.seed({
        providerId: 'prov1',
        start: at('14:00'),
        end: at('15:00'),
        status: AppointmentStatus.CANCELLED,
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute(existing.id, {
        start: at('14:30'),
        end: at('15:30'),
      });

      expect(result.start).toEqual(at('14:30'));
    });
  });

  describe('DB exclusion-constraint backstop (23P01 → 409)', () => {
    // Shape Prisma raises from an ORM update hitting the EXCLUDE constraint:
    // PrismaClientUnknownRequestError, no code/meta, SQLSTATE in the message.
    function ormExclusionError(): Prisma.PrismaClientUnknownRequestError {
      return new Prisma.PrismaClientUnknownRequestError(
        'Invalid `tx.appointment.update()` ... code: "23P01", message: ' +
          '"conflicting key value violates exclusion constraint ' +
          '\\"appointments_no_overlap_per_provider\\""',
        { clientVersion: '6.19.3' },
      );
    }

    it('maps an overlapping RESCHEDULE that slips past the pre-check to 409', async () => {
      const existing = fakeAppointment();
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]), // pre-check passes
        update: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute('a1', {
          start: at('11:00'),
          end: at('11:30'),
        }),
      ).rejects.toThrow('El profesional ya tiene una cita en ese horario');
    });

    it('maps an UN-CANCEL into a taken slot to 409 (no pre-check runs on a status-only patch)', async () => {
      const existing = fakeAppointment({ status: AppointmentStatus.CANCELLED });
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        findOverlapping: (): Promise<Appointment[]> =>
          Promise.reject(
            new Error('findOverlapping should not run for a status-only patch'),
          ),
        update: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute('a1', { status: AppointmentStatus.SCHEDULED }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does NOT swallow unrelated update errors (rethrows as-is)', async () => {
      const boom = new Prisma.PrismaClientUnknownRequestError(
        'some other db failure',
        {
          clientVersion: '6.19.3',
        },
      );
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> =>
          Promise.resolve(fakeAppointment()),
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]),
        undoArrival: () => Promise.resolve(null),
        listInClinic: () => Promise.resolve([]),
        update: (): Promise<Appointment> => Promise.reject(boom),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(uc.execute('a1', { notes: 'x' })).rejects.toBe(boom);
    });
  });

  describe('solape del paciente al reagendar', () => {
    it('rechaza mover la cita a un horario donde el paciente ya tiene otra', async () => {
      const existing = fakeAppointment({
        patientId: 'p1',
        providerId: 'prov1',
      });
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        // El paciente ya tiene otra cita (con otro profesional) en el destino.
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([
            fakeAppointment({ id: 'other', providerId: 'prov2' }),
          ]),
        update: (): Promise<Appointment> =>
          Promise.reject(new Error('update should not be called')),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute('a1', { start: at('14:00'), end: at('14:30') }),
      ).rejects.toThrow('El paciente ya tiene otra cita en ese horario');
    });
  });

  describe('no reagendar al pasado', () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    it('rechaza mover una cita a un instante que ya pasó', async () => {
      const existing = fakeAppointment();
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        update: (): Promise<Appointment> =>
          Promise.reject(new Error('update should not be called')),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute('a1', {
          start: anHourAgo,
          end: new Date(anHourAgo.getTime() + 30 * 60 * 1000),
        }),
      ).rejects.toThrow('No se puede reagendar una cita al pasado');
    });

    // El matiz que hace usable la agenda: una cita que YA pasó se sigue
    // pudiendo cerrar (completar/cancelar) o editar. La validación de pasado
    // vive solo en la rama de reschedule, así que un patch sin start/end pasa.
    it('PERMITE completar una cita que ya pasó (patch de solo estado)', async () => {
      const past = fakeAppointment({
        start: anHourAgo,
        end: new Date(anHourAgo.getTime() + 30 * 60 * 1000),
      });
      let received: UpdateAppointmentRepoInput | undefined;
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(past),
        update: (
          _id: string,
          patch: UpdateAppointmentRepoInput,
        ): Promise<Appointment> => {
          received = patch;
          return Promise.resolve({
            ...past,
            status: AppointmentStatus.COMPLETED,
          });
        },
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute('a1', {
        status: AppointmentStatus.COMPLETED,
      });

      expect(result.status).toBe(AppointmentStatus.COMPLETED);
      expect(received).toEqual({
        status: AppointmentStatus.COMPLETED,
        confirmationSentAt: null,
        callbackRequestedAt: null,
        expectStatus: AppointmentStatus.SCHEDULED,
      });
    });

    it('PERMITE editar las notas de una cita que ya pasó', async () => {
      const past = fakeAppointment({
        start: anHourAgo,
        end: new Date(anHourAgo.getTime() + 30 * 60 * 1000),
      });
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(past),
        update: (): Promise<Appointment> =>
          Promise.resolve({ ...past, notes: 'El paciente asistió' }),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute('a1', { notes: 'El paciente asistió' });

      expect(result.notes).toBe('El paciente asistió');
    });
  });

  // DX-005: los indicadores "confirmación pendiente" y "pide llamada" se
  // refieren a la cita TAL COMO ERA cuando se envió el enlace. Si recepción la
  // reagenda o le cambia el estado a mano, ya no aplican.
  describe('indicadores de confirmación por enlace', () => {
    const SENT = new Date('2026-01-02T00:00:00.000Z');

    it('cambiar el estado limpia confirmationSentAt y callbackRequestedAt', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        start: at('10:00'),
        end: at('10:30'),
        confirmationSentAt: SENT,
        callbackRequestedAt: SENT,
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute(existing.id, {
        status: AppointmentStatus.CONFIRMED,
      });

      expect(result.confirmationSentAt).toBeNull();
      expect(result.callbackRequestedAt).toBeNull();
    });

    it('reagendar también los limpia', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        start: at('10:00'),
        end: at('10:30'),
        confirmationSentAt: SENT,
        callbackRequestedAt: SENT,
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute(existing.id, {
        start: at('12:00'),
        end: at('12:30'),
      });

      expect(result.confirmationSentAt).toBeNull();
      expect(result.callbackRequestedAt).toBeNull();
    });

    it('editar solo notas/motivo los conserva', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({
        start: at('10:00'),
        end: at('10:30'),
        confirmationSentAt: SENT,
        callbackRequestedAt: SENT,
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute(existing.id, {
        notes: 'Trae radiografía',
      });

      expect(result.confirmationSentAt).toEqual(SENT);
      expect(result.callbackRequestedAt).toEqual(SENT);
    });
  });

  // DX-121: mover una cita a otra hora y/o a otro profesional («Mover a…» y el
  // arrastre de la vista Día usan este mismo PATCH).
  describe('mover a otro profesional (DX-121)', () => {
    const PROV2 = 'prov2';
    const ctx: AppointmentAuditContext = {
      tenantId: 't1',
      locationId: null,
      actor: { userId: 'u-recepcion', role: 'RECEPTION' },
      requestId: 'req-1',
      ip: '127.0.0.1',
      userAgent: 'jest',
    };

    it('mueve la cita y comprueba el solape contra el profesional NUEVO', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      repo.seed({
        patientId: 'p2',
        providerId: PROV2,
        start: at('10:00'),
        end: at('10:30'),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, { providerId: PROV2 }),
      ).rejects.toThrow('El profesional ya tiene una cita en ese horario');

      const moved = await uc.execute(existing.id, {
        providerId: PROV2,
        start: at('11:00'),
        end: at('11:30'),
      });
      expect(moved).toMatchObject({ providerId: PROV2, start: at('11:00') });
    });

    it('404 si el profesional nuevo no es de la clínica', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(['prov1']),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );
      await expect(
        uc.execute(existing.id, { providerId: 'intruso' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cambiar solo de profesional (misma hora) también anula el enlace de confirmación', async () => {
      const existing = fakeAppointment({
        confirmationSentAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      let receivedPatch: UpdateAppointmentRepoInput | undefined;
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        update: (
          _id: string,
          patch: UpdateAppointmentRepoInput,
        ): Promise<Appointment> => {
          receivedPatch = patch;
          return Promise.resolve(fakeAppointment({ providerId: PROV2 }));
        },
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(existing.id, { providerId: PROV2 });

      expect(receivedPatch).toMatchObject({
        providerId: PROV2,
        confirmationSentAt: null,
        callbackRequestedAt: null,
        revokeConfirmations: true,
      });
    });

    it('fuera del horario de la sede DE LA CITA responde 422 y no escribe', async () => {
      const existing = fakeAppointment();
      // La sede atiende solo OTRO día de la semana: ese día está cerrado.
      const otherDay = (at('12:00').getUTCDay() + 1) % 7;
      const hours: BusinessHours = {
        timezone: 'UTC',
        ranges: [{ weekday: otherDay, startMinute: 480, endMinute: 1080 }],
      };
      const asked: string[] = [];
      const schedule = {
        ...makeSchedule(),
        findByLocation: (locationId: string): Promise<BusinessHours> => {
          asked.push(locationId);
          return Promise.resolve(hours);
        },
      } as LocationScheduleRepository;
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(existing),
        update: (): Promise<Appointment> =>
          Promise.reject(new Error('update should not be called')),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        schedule,
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, { start: at('12:00'), end: at('12:30') }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(asked).toEqual(['loc1']);
    });

    it('audita el movimiento con la hora y el profesional antes y después', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const drafts: AuditEventDraft[] = [];
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(drafts),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(
        existing.id,
        { providerId: PROV2, start: at('11:00'), end: at('11:30') },
        ctx,
      );

      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        tenantId: 't1',
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        resourceId: existing.id,
        patient: { kind: 'patient', id: existing.patientId },
        actor: { kind: 'user', userId: 'u-recepcion', role: 'RECEPTION' },
        metadata: {
          reason: 'APPOINTMENT_MOVED',
          move: {
            from: {
              start: at('10:00').toISOString(),
              end: at('10:30').toISOString(),
              providerId: 'prov1',
            },
            to: {
              start: at('11:00').toISOString(),
              end: at('11:30').toISOString(),
              providerId: PROV2,
            },
          },
        },
      });
    });

    it('no audita un cambio de estado ni un movimiento rechazado', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      repo.seed({ patientId: 'p9', start: at('11:00'), end: at('11:30') });
      const drafts: AuditEventDraft[] = [];
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(drafts),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(
        existing.id,
        { status: AppointmentStatus.CONFIRMED },
        ctx,
      );
      await expect(
        uc.execute(existing.id, { start: at('11:00'), end: at('11:30') }, ctx),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(drafts).toHaveLength(0);
    });
  });

  // DX-122: bloqueos de agenda al mover, y «Pendientes por agendar» al
  // cancelar o marcar no-show.
  describe('bloqueos y pendientes (DX-122)', () => {
    const ctx: AppointmentAuditContext = {
      tenantId: 't1',
      locationId: null,
      actor: { userId: 'u-rec', role: 'RECEPTION' },
      requestId: 'req-1',
      ip: '127.0.0.1',
      userAgent: 'jest',
    };

    function vacation(
      blocks: InMemoryScheduleBlockRepository,
      providerId = 'prov1',
    ) {
      return blocks.seed({
        providerId,
        locationId: null,
        start: at('08:00'),
        end: at('20:00'),
        allowsBooking: false,
      });
    }

    it('mover a un horario bloqueado del profesional: 409 en español y nada cambia', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('07:00'), end: at('07:30') });
      const blocks = new InMemoryScheduleBlockRepository();
      vacation(blocks);
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(blocks),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, { start: at('10:00'), end: at('10:30') }),
      ).rejects.toThrow(
        /La agenda del profesional está bloqueada \(Vacaciones\)/,
      );
      await expect(repo.findById(existing.id)).resolves.toMatchObject({
        start: at('07:00'),
      });
    });

    it('mover a OTRO profesional que está de vacaciones también da 409', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const blocks = new InMemoryScheduleBlockRepository();
      vacation(blocks, 'prov2');
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(blocks),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, { providerId: 'prov2' }),
      ).rejects.toThrow(ConflictException);
    });

    it('un bloqueo que deja agendar (almuerzo): mueve y devuelve el aviso', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const blocks = new InMemoryScheduleBlockRepository();
      blocks.seed({
        providerId: null,
        locationId: 'loc1',
        kind: 'LUNCH',
        allowsBooking: true,
        start: at('18:00'),
        end: at('19:00'),
      });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(blocks),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      const result = await uc.execute(existing.id, {
        start: at('18:00'),
        end: at('18:30'),
      });
      expect(result.start).toEqual(at('18:00'));
      expect(result.warnings).toEqual([
        'La cita cae en un bloqueo que permite agendar: Almuerzo (13:00–14:00).',
      ]);
    });

    it('cambiar solo el estado dentro de un bloqueo no se rechaza', async () => {
      const repo = new InMemoryAppointmentRepository();
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const blocks = new InMemoryScheduleBlockRepository();
      vacation(blocks);
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(blocks),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await expect(
        uc.execute(existing.id, { status: AppointmentStatus.CONFIRMED }),
      ).resolves.toMatchObject({ status: AppointmentStatus.CONFIRMED });
    });

    it('cancelar y luego marcar no-show deja UNA sola entrada OPEN, auditada una vez', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const repo = new InMemoryAppointmentRepository(waitlist);
      const existing = repo.seed({
        patientId: 'p9',
        start: at('10:00'),
        end: at('10:45'),
      });
      const drafts: AuditEventDraft[] = [];
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(drafts),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(
        existing.id,
        { status: AppointmentStatus.CANCELLED },
        ctx,
      );
      await uc.execute(existing.id, { status: AppointmentStatus.NO_SHOW }, ctx);

      expect(waitlist.rows).toHaveLength(1);
      expect(waitlist.rows[0]).toMatchObject({
        status: 'OPEN',
        patientId: 'p9',
        sourceAppointmentId: existing.id,
        providerId: 'prov1',
        durationMinutes: 45,
        createdById: 'u-rec',
      });
      const created = drafts.filter((d) => d.resourceType === 'WAITLIST_ENTRY');
      expect(created).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          resourceId: waitlist.rows[0].id,
          patient: { kind: 'patient', id: 'p9' },
          metadata: { reason: 'WAITLIST_FROM_APPOINTMENT' },
        }),
      ]);
    });

    it('confirmar, completar o reagendar no crean pendientes', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const repo = new InMemoryAppointmentRepository(waitlist);
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(existing.id, { status: AppointmentStatus.CONFIRMED });
      await uc.execute(existing.id, { start: at('11:00'), end: at('11:30') });
      await uc.execute(existing.id, { status: AppointmentStatus.COMPLETED });
      expect(waitlist.rows).toHaveLength(0);
    });
  });

  describe('reactivar una cita cancelada (DX-122, revisión H1)', () => {
    const ctx: AppointmentAuditContext = {
      tenantId: 't1',
      locationId: null,
      actor: { userId: 'u-rec', role: 'RECEPTION' },
      requestId: 'req-1',
      ip: null,
      userAgent: null,
    };

    it.each([
      AppointmentStatus.SCHEDULED,
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.COMPLETED,
    ])(
      'CANCELLED → %s cierra la entrada OPEN con la propia cita y lo audita',
      async (status) => {
        const waitlist = new InMemoryWaitlistRepository();
        const repo = new InMemoryAppointmentRepository(waitlist);
        const existing = repo.seed({
          patientId: 'p9',
          start: at('10:00'),
          end: at('10:30'),
        });
        const drafts: AuditEventDraft[] = [];
        const uc = new UpdateAppointmentUseCase(
          repo,
          makeSchedule(),
          makeStaff(),
          makeAudit(drafts),
          makeBlocks(),
          makeLocations(),
          new TenantContextService(),
          inMemoryAvailability(),
        );

        await uc.execute(
          existing.id,
          { status: AppointmentStatus.CANCELLED },
          ctx,
        );
        await uc.execute(existing.id, { status }, ctx);

        expect(waitlist.rows).toEqual([
          expect.objectContaining({
            status: 'SCHEDULED',
            resolvedAppointmentId: existing.id,
            resolvedById: 'u-rec',
          }),
        ]);
        expect(
          drafts
            .filter((d) => d.resourceType === 'WAITLIST_ENTRY')
            .map((d) => [d.action, d.metadata]),
        ).toEqual([
          ['CREATE', { reason: 'WAITLIST_FROM_APPOINTMENT' }],
          ['UPDATE', { reason: 'APPOINTMENT_REACTIVATED' }],
        ]);
      },
    );

    it('cancelarla otra vez tras reactivarla reabre la misma entrada y lo audita', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const repo = new InMemoryAppointmentRepository(waitlist);
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const drafts: AuditEventDraft[] = [];
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(drafts),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(
        existing.id,
        { status: AppointmentStatus.CANCELLED },
        ctx,
      );
      await uc.execute(
        existing.id,
        { status: AppointmentStatus.SCHEDULED },
        ctx,
      );
      await uc.execute(existing.id, { status: AppointmentStatus.NO_SHOW }, ctx);

      expect(waitlist.rows).toEqual([
        expect.objectContaining({
          status: 'OPEN',
          resolvedAppointmentId: null,
          resolvedById: null,
          resolvedAt: null,
        }),
      ]);
      expect(
        drafts
          .filter((d) => d.resourceType === 'WAITLIST_ENTRY')
          .map((d) => [d.action, d.metadata]),
      ).toEqual([
        ['CREATE', { reason: 'WAITLIST_FROM_APPOINTMENT' }],
        ['UPDATE', { reason: 'APPOINTMENT_REACTIVATED' }],
        ['UPDATE', { reason: 'WAITLIST_REOPENED' }],
      ]);
    });

    it('una entrada descartada o agendada con otra cita no se reabre', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const repo = new InMemoryAppointmentRepository(waitlist);
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(existing.id, { status: AppointmentStatus.CANCELLED });
      waitlist.markScheduled(waitlist.rows[0].id, 'otra-cita', null);
      await uc.execute(existing.id, { status: AppointmentStatus.SCHEDULED });
      await uc.execute(existing.id, { status: AppointmentStatus.CANCELLED });
      expect(waitlist.rows).toEqual([
        expect.objectContaining({
          status: 'SCHEDULED',
          resolvedAppointmentId: 'otra-cita',
        }),
      ]);
    });

    it('pasar de cancelada a no-show no la cierra; editar notas tampoco', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const repo = new InMemoryAppointmentRepository(waitlist);
      const existing = repo.seed({ start: at('10:00'), end: at('10:30') });
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );

      await uc.execute(existing.id, { status: AppointmentStatus.CANCELLED });
      await uc.execute(existing.id, { status: AppointmentStatus.NO_SHOW });
      await uc.execute(existing.id, { notes: 'llamar' });
      expect(waitlist.rows[0].status).toBe('OPEN');
    });
  });

  describe('«Adelantar si hay hueco» (DX-210)', () => {
    const ctx = (
      role: AppointmentAuditContext['actor']['role'],
    ): AppointmentAuditContext => ({
      tenantId: 't1',
      locationId: null,
      actor: { userId: 'u-1', role },
      requestId: 'req-1',
      ip: null,
      userAgent: null,
    });
    // Tres semanas después: la cita que el paciente quiere adelantar.
    const FAR = new Date(Date.now() + 21 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const far = (t: string) => new Date(`${FAR}T${t}:00.000Z`);

    function setup() {
      const repo = new InMemoryAppointmentRepository();
      const drafts: AuditEventDraft[] = [];
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(),
        makeStaff(),
        makeAudit(drafts),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );
      return { repo, drafts, uc };
    }

    it.each(['RECEPTION', 'DENTIST', 'ADMIN'] as const)(
      '%s la marca y queda auditado',
      async (role) => {
        const { repo, drafts, uc } = setup();
        const a = repo.seed({ start: far('10:00'), end: far('10:30') });
        const res = await uc.execute(a.id, { wantsEarlier: true }, ctx(role));
        expect(res.wantsEarlier).toBe(true);
        expect(drafts).toEqual([
          expect.objectContaining({
            action: 'UPDATE',
            resourceType: 'APPOINTMENT',
            resourceId: a.id,
            patient: { kind: 'patient', id: a.patientId },
            metadata: { reason: 'WANTS_EARLIER_ON' },
          }),
        ]);
      },
    );

    it('la asistente no la cambia (403) y no se escribe nada', async () => {
      const { repo, drafts, uc } = setup();
      const a = repo.seed({ start: far('10:00'), end: far('10:30') });
      await expect(
        uc.execute(a.id, { wantsEarlier: true }, ctx('ASSISTANT')),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await repo.findById(a.id))?.wantsEarlier).toBe(false);
      expect(drafts).toHaveLength(0);
    });

    it('quitarla audita WANTS_EARLIER_OFF; repetir el mismo valor no audita', async () => {
      const { repo, drafts, uc } = setup();
      const a = repo.seed({
        start: far('10:00'),
        end: far('10:30'),
        wantsEarlier: true,
      });
      await uc.execute(a.id, { wantsEarlier: true }, ctx('RECEPTION'));
      expect(drafts).toHaveLength(0);
      await uc.execute(a.id, { wantsEarlier: false }, ctx('RECEPTION'));
      expect(drafts.map((d) => d.metadata)).toEqual([
        { reason: 'WANTS_EARLIER_OFF' },
      ]);
    });

    it('mover al hueco: la cita va al hueco (misma duración), pierde la marca y se audita el movimiento', async () => {
      const { repo, drafts, uc } = setup();
      const a = repo.seed({
        start: far('10:00'),
        end: far('10:30'),
        wantsEarlier: true,
      });
      const res = await uc.moveToOpening(
        a.id,
        { start: at('15:00'), providerId: 'prov2' },
        ctx('RECEPTION'),
      );
      expect(res).toMatchObject({
        start: at('15:00'),
        end: at('15:30'),
        providerId: 'prov2',
        wantsEarlier: false,
      });
      expect(drafts.map((d) => d.metadata.reason)).toEqual([
        'APPOINTMENT_MOVED',
      ]);
    });

    it('mover al hueco una cita sin la marca (o cancelada) da 409 en español', async () => {
      const { repo, uc } = setup();
      const plain = repo.seed({ start: far('10:00'), end: far('10:30') });
      const cancelled = repo.seed({
        start: far('11:00'),
        end: far('11:30'),
        wantsEarlier: true,
        status: AppointmentStatus.CANCELLED,
      });
      for (const id of [plain.id, cancelled.id]) {
        await expect(
          uc.moveToOpening(id, { start: at('15:00') }, ctx('RECEPTION')),
        ).rejects.toThrow(/ya no está para adelantar/);
      }
    });

    it('«Adelantar» solo a un hueco ANTERIOR a la cita: uno igual o posterior da 409 y la cita no cambia', async () => {
      const { repo, uc } = setup();
      const a = repo.seed({
        start: at('15:00'),
        end: at('15:30'),
        wantsEarlier: true,
      });
      for (const start of [at('15:00'), far('10:00')]) {
        await expect(
          uc.moveToOpening(a.id, { start }, ctx('RECEPTION')),
        ).rejects.toThrow(
          new ConflictException(
            'El hueco tiene que ser anterior a la cita: «Adelantar si hay hueco» no la retrasa.',
          ),
        );
      }
      expect(await repo.findById(a.id)).toMatchObject({
        start: at('15:00'),
        wantsEarlier: true,
      });
    });

    it('mover al hueco respeta el anti-solape: si otro ya lo ocupó, 409 y la cita conserva su hora y su marca', async () => {
      const { repo, uc } = setup();
      repo.seed({ patientId: 'p9', start: at('15:00'), end: at('15:30') });
      const a = repo.seed({
        start: far('10:00'),
        end: far('10:30'),
        wantsEarlier: true,
      });
      await expect(
        uc.moveToOpening(a.id, { start: at('15:00') }, ctx('RECEPTION')),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await repo.findById(a.id)).toMatchObject({
        start: far('10:00'),
        wantsEarlier: true,
      });
    });

    it('mover al hueco fuera del horario de la sede: 422', async () => {
      const repo = new InMemoryAppointmentRepository();
      const a = repo.seed({
        start: far('10:00'),
        end: far('10:30'),
        wantsEarlier: true,
      });
      // Abre solo de 08:00 a 09:00 UTC todos los días: las 15:00 quedan fuera.
      const hours: BusinessHours = {
        timezone: 'UTC',
        ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 480,
          endMinute: 540,
        })),
      };
      const uc = new UpdateAppointmentUseCase(
        repo,
        makeSchedule(hours),
        makeStaff(),
        makeAudit(),
        makeBlocks(),
        makeLocations(),
        new TenantContextService(),
        inMemoryAvailability(),
      );
      await expect(
        uc.moveToOpening(a.id, { start: at('15:00') }, ctx('RECEPTION')),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });
});

// DX-089 / DX-121d.
describe('UpdateAppointmentUseCase · sedes permitidas y profesional ↔ sede', () => {
  const tenantContext = new TenantContextService();
  const uc = (staff: StaffRepository = makeStaff()) =>
    new UpdateAppointmentUseCase(
      makeRepo({
        findById: (): Promise<Appointment | null> =>
          Promise.resolve(fakeAppointment()),
        update: (): Promise<Appointment> => Promise.resolve(fakeAppointment()),
      }),
      makeSchedule(),
      staff,
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      tenantContext,
      inMemoryAvailability(),
    );

  it('una cita de una sede no permitida es 403 (no 404)', async () => {
    await expect(
      tenantContext.run(
        't1',
        undefined,
        () => uc().execute('a1', { notes: 'x' }),
        ['loc2'],
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('pasar la cita a un profesional que no atiende en su sede es 400', async () => {
    const staff = {
      findById: (userId: string): Promise<never> =>
        Promise.resolve({ userId, locationIds: ['loc2'] }) as Promise<never>,
    } as unknown as StaffRepository;
    await expect(
      uc(staff).execute('a1', { providerId: 'prov2' }),
    ).rejects.toThrow(PROVIDER_NOT_AT_LOCATION_MESSAGE);
  });
});

describe('UpdateAppointmentUseCase · ítems del plan de una cita cerrada (DX-271)', () => {
  const useCase = (
    existing: Appointment,
    calls: UpdateAppointmentRepoInput[],
  ) =>
    new UpdateAppointmentUseCase(
      makeRepo({
        findById: () => Promise.resolve(existing),
        update: (_id, patch) => {
          calls.push(patch);
          return Promise.resolve({ ...existing, ...patch } as Appointment);
        },
      }),
      makeSchedule(),
      makeStaff(),
      makeAudit(),
      makeBlocks(),
      makeLocations(),
      new TenantContextService(),
      inMemoryAvailability(),
    );
  const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const PASSED = 'Esta cita ya pasó: sus tratamientos no se cambian.';
  it.each([
    [fakeAppointment({ status: AppointmentStatus.COMPLETED }), PASSED],
    [
      fakeAppointment({ status: AppointmentStatus.NO_SHOW }),
      'Esta cita está marcada como «no asistió»: sus tratamientos no se cambian.',
    ],
    [
      fakeAppointment({ status: AppointmentStatus.CANCELLED }),
      'Esta cita está cancelada: sus tratamientos no se cambian.',
    ],
    [
      fakeAppointment({ status: AppointmentStatus.CANCELLED, start: past }),
      PASSED,
    ],
    [
      fakeAppointment({ start: past, end: new Date(past.getTime() + 1800000) }),
      PASSED,
    ],
  ])(
    'planItemIds en una cita cerrada o pasada → 409 sin escribir (%#)',
    async (existing, message) => {
      const calls: UpdateAppointmentRepoInput[] = [];
      await expect(
        useCase(existing, calls).execute(existing.id, {
          planItemIds: [],
          notes: 'x',
        }),
      ).rejects.toThrow(new ConflictException(message));
      expect(calls).toHaveLength(0);
    },
  );

  it('reactivar una cita cancelada futura y cambiar sus ítems a la vez sí se puede', async () => {
    const existing = fakeAppointment({ status: AppointmentStatus.CANCELLED });
    const calls: UpdateAppointmentRepoInput[] = [];
    await useCase(existing, calls).execute(existing.id, {
      status: AppointmentStatus.SCHEDULED,
      planItemIds: [],
    });
    expect(calls).toHaveLength(1);
  });

  it('una cita futura o en la clínica admite planItemIds', async () => {
    for (const existing of [
      fakeAppointment(),
      fakeAppointment({
        status: AppointmentStatus.IN_CHAIR,
        start: past,
        end: new Date(past.getTime() + 1800000),
      }),
    ]) {
      const calls: UpdateAppointmentRepoInput[] = [];
      await useCase(existing, calls).execute(existing.id, { planItemIds: [] });
      expect(calls).toHaveLength(1);
    }
  });
});
