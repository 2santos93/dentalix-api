import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { UpdateAppointmentUseCase } from './update-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  UpdateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';

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
    patientId: 'p1',
    providerId: 'prov1',
    start: at('10:00'),
    end: at('10:30'),
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
    const uc = new UpdateAppointmentUseCase(repo);

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
      const uc = new UpdateAppointmentUseCase(repo);

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
      const uc = new UpdateAppointmentUseCase(repo);

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
      const uc = new UpdateAppointmentUseCase(repo);

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
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]), // pre-check passes
        update: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new UpdateAppointmentUseCase(repo);

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
          Promise.reject(new Error('findOverlapping should not run for a status-only patch')),
        update: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new UpdateAppointmentUseCase(repo);

      await expect(
        uc.execute('a1', { status: AppointmentStatus.SCHEDULED }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does NOT swallow unrelated update errors (rethrows as-is)', async () => {
      const boom = new Prisma.PrismaClientUnknownRequestError('some other db failure', {
        clientVersion: '6.19.3',
      });
      const repo = makeRepo({
        findById: (): Promise<Appointment | null> => Promise.resolve(fakeAppointment()),
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        update: (): Promise<Appointment> => Promise.reject(boom),
      });
      const uc = new UpdateAppointmentUseCase(repo);

      await expect(
        uc.execute('a1', { notes: 'x' }),
      ).rejects.toBe(boom);
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
      const uc = new UpdateAppointmentUseCase(repo);

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
      const uc = new UpdateAppointmentUseCase(repo);

      const result = await uc.execute('a1', {
        status: AppointmentStatus.COMPLETED,
      });

      expect(result.status).toBe(AppointmentStatus.COMPLETED);
      expect(received).toEqual({ status: AppointmentStatus.COMPLETED });
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
      const uc = new UpdateAppointmentUseCase(repo);

      const result = await uc.execute('a1', { notes: 'El paciente asistió' });

      expect(result.notes).toBe('El paciente asistió');
    });
  });
});
