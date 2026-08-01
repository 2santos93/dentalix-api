import { BadRequestException, ConflictException } from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { CreateAppointmentUseCase } from './create-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  CreateAppointmentRepoInput,
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
    findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
    update: (): Promise<Appointment> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

describe('CreateAppointmentUseCase', () => {
  const start = at('10:00');
  const end = at('10:30');

  describe('no agendar en el pasado', () => {
    it('rechaza una cita cuya fecha ya pasó', async () => {
      const repo = makeRepo({
        create: (): Promise<Appointment> =>
          Promise.reject(new Error('create should not be called')),
      });
      const uc = new CreateAppointmentUseCase(repo);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov1',
          start: yesterday,
          end: new Date(yesterday.getTime() + 30 * 60 * 1000),
        }),
      ).rejects.toThrow('No se puede agendar una cita en el pasado');
    });

    it('rechaza HOY a una hora que ya pasó (el caso que se cuela por un date input sin min)', async () => {
      const repo = makeRepo({
        create: (): Promise<Appointment> =>
          Promise.reject(new Error('create should not be called')),
      });
      const uc = new CreateAppointmentUseCase(repo);
      // Una hora atrás: mismo día, instante pasado.
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov1',
          start: anHourAgo,
          end: new Date(anHourAgo.getTime() + 30 * 60 * 1000),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acepta una cita inmediata (start ~ahora) — solo se rechaza lo estrictamente anterior', async () => {
      const repo = makeRepo();
      const uc = new CreateAppointmentUseCase(repo);
      const soon = new Date(Date.now() + 1000);

      const result = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start: soon,
        end: new Date(soon.getTime() + 30 * 60 * 1000),
      });

      expect(result.patientId).toBe('p1');
    });
  });

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
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov1',
        start: at('11:00'),
        end: at('12:00'),
      });

      expect(result.providerId).toBe('prov1');
      expect(result.start).toEqual(at('11:00'));
    });

    it('does not block on a CANCELLED appointment for the same provider/slot', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
        status: AppointmentStatus.CANCELLED,
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov1',
        start: at('10:30'),
        end: at('11:30'),
      });

      expect(result.providerId).toBe('prov1');
    });

    it('rejects a true overlap with ConflictException — real filtering, not a canned stub', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({
          patientId: 'p2',
          providerId: 'prov1',
          start: at('10:30'),
          end: at('11:30'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza doble-agendar al MISMO PACIENTE aunque el profesional esté libre', async () => {
      const repo = new InMemoryAppointmentRepository();
      // El paciente ya tiene cita con prov1; se intenta otra solapada con prov2
      // (profesional distinto y libre). El paciente no puede estar en dos
      // sillones a la vez.
      repo.seed({
        patientId: 'p1',
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov2',
          start: at('10:30'),
          end: at('11:30'),
        }),
      ).rejects.toThrow('El paciente ya tiene otra cita en ese horario');
    });

    it('permite al mismo paciente una cita CONTIGUA (el fin de una es el inicio de la otra)', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        patientId: 'p1',
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p1',
        providerId: 'prov2',
        start: at('11:00'),
        end: at('11:30'),
      });

      expect(result.patientId).toBe('p1');
    });

    it('una cita CANCELADA del paciente no bloquea el horario', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        patientId: 'p1',
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
        status: AppointmentStatus.CANCELLED,
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p1',
        providerId: 'prov2',
        start: at('10:30'),
        end: at('11:30'),
      });

      expect(result.patientId).toBe('p1');
    });

    it('scopes overlap per provider — an identical slot for a different provider succeeds', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({
        providerId: 'prov1',
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(repo);

      const result = await uc.execute({
        patientId: 'p2',
        providerId: 'prov2',
        start: at('10:00'),
        end: at('11:00'),
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
    findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
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

    it('distingue la constraint del PACIENTE y devuelve su mensaje (no el del profesional)', async () => {
      const patientExclusion = new Prisma.PrismaClientUnknownRequestError(
        'Invalid `tx.appointment.create()` ... code: "23P01", message: ' +
          '"conflicting key value violates exclusion constraint ' +
          '\\"appointments_no_overlap_per_patient\\""',
        { clientVersion: '6.19.3' },
      );
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(patientExclusion),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toThrow('El paciente ya tiene otra cita en ese horario');
    });

    it('also maps the raw-path shape (P2010 / meta.code 23P01) to 409', async () => {
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
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
    findOverlappingForPatient: (): Promise<Appointment[]> => Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(boom),
      });
      const uc = new CreateAppointmentUseCase(repo);

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBe(boom);
    });
  });
});
