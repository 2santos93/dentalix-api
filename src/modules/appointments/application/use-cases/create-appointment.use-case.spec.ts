import { BadRequestException, ConflictException } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { CreateAppointmentUseCase } from './create-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';

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

  // These cases go through InMemoryAppointmentRepository's REAL filtering
  // (not a canned findOverlapping stub), so they would fail if the overlap
  // math, the CANCELLED exclusion, or the per-provider scoping regressed.
  describe('overlap enforcement (real in-memory filtering)', () => {
    it('allows an adjacent appointment — end of the new one equals the start of the next (half-open, no overlap)', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: new Date('2026-08-01T10:00:00.000Z'),
        end: new Date('2026-08-01T11:00:00.000Z'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov1',
        start: new Date('2026-08-01T11:00:00.000Z'),
        end: new Date('2026-08-01T12:00:00.000Z'),
      });

      expect(result.providerId).toBe('prov1');
      expect(result.start).toEqual(new Date('2026-08-01T11:00:00.000Z'));
    });

    it('does not block on a CANCELLED appointment for the same provider/slot', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: new Date('2026-08-01T10:00:00.000Z'),
        end: new Date('2026-08-01T11:00:00.000Z'),
        status: AppointmentStatus.CANCELLED,
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov1',
        start: new Date('2026-08-01T10:30:00.000Z'),
        end: new Date('2026-08-01T11:30:00.000Z'),
      });

      expect(result.providerId).toBe('prov1');
    });

    it('rejects a true overlap with ConflictException — real filtering, not a canned stub', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: new Date('2026-08-01T10:00:00.000Z'),
        end: new Date('2026-08-01T11:00:00.000Z'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({
          patientId: 'p2',
          providerId: 'prov1',
          start: new Date('2026-08-01T10:30:00.000Z'),
          end: new Date('2026-08-01T11:30:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('scopes overlap per provider — an identical slot for a different provider succeeds', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: new Date('2026-08-01T10:00:00.000Z'),
        end: new Date('2026-08-01T11:00:00.000Z'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov2',
        start: new Date('2026-08-01T10:00:00.000Z'),
        end: new Date('2026-08-01T11:00:00.000Z'),
      });

      expect(result.providerId).toBe('prov2');
    });
  });

  describe('DB exclusion-constraint backstop (23P01 → 409)', () => {
    // Shape captured from `tx.appointment.create()` hitting the EXCLUDE
    // constraint: PrismaClientUnknownRequestError, no code/meta, SQLSTATE only
    // in the message — the shape the global PrismaExceptionFilter does NOT
    // catch, so the use-case must.
    function ormExclusionError(): Prisma.PrismaClientUnknownRequestError {
      return new Prisma.PrismaClientUnknownRequestError(
        'Invalid `tx.appointment.create()` ... code: "23P01", message: ' +
          '"conflicting key value violates exclusion constraint ' +
          '\\"appointments_no_overlap_per_provider\\""',
        { clientVersion: '6.19.3' },
      );
    }

    function rawExclusionError(): Prisma.PrismaClientKnownRequestError {
      return new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23P01`.', {
        code: 'P2010',
        clientVersion: '6.19.3',
        meta: { code: '23P01' },
      });
    }

    it('maps the ORM exclusion violation (23P01) to the SAME 409 as the pre-check', async () => {
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toThrow('El profesional ya tiene una cita en ese horario');
      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('also maps the raw-path shape (P2010 / meta.code 23P01) to 409', async () => {
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(rawExclusionError()),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does NOT swallow unrelated create errors (rethrows as-is)', async () => {
      const boom = new Prisma.PrismaClientUnknownRequestError('some other db failure', {
        clientVersion: '6.19.3',
      });
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(boom),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBe(boom);
    });
  });
});
