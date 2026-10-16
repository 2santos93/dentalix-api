import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { CreateAppointmentUseCase } from './create-appointment.use-case';
import { Appointment } from '../../domain/entities/appointment.entity';
import {
  AppointmentRepository,
  AppointmentUpdate,
  CreateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryWaitlistRepository } from '../../../waitlist/application/__fixtures__/in-memory-waitlist';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { BusinessHours } from '../../../location-schedule/application/business-hours';
import { InMemoryAppointmentTypeRepository } from '../../../appointment-types/application/__fixtures__/in-memory-appointment-types';
import type { AppointmentTypeRepository } from '../../../appointment-types/domain/ports/appointment-type-repository.port';

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
    listUpcoming: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
    findOverlappingForPatient: (): Promise<Appointment[]> =>
      Promise.resolve([]),
    update: (): Promise<AppointmentUpdate> =>
      Promise.reject(new Error('not implemented in this fake')),
    ...overrides,
  };
}

// Dobles para las validaciones de pertenencia: por defecto el paciente y el
// profesional SÍ existen en la clínica, que es la precondición de casi todos los
// tests de abajo. Los tests que prueban lo contrario los sobreescriben.
function makePatients(found: unknown = { id: 'p1' }): PatientRepository {
  return {
    findById: (): Promise<never> => Promise.resolve(found) as Promise<never>,
  } as unknown as PatientRepository;
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

// Tipos de cita (DX-121): por defecto la clínica no tiene ninguno.
function makeTypes(
  repo: AppointmentTypeRepository = new InMemoryAppointmentTypeRepository(),
): AppointmentTypeRepository {
  return repo;
}

// Bloqueos (DX-122): por defecto la agenda no tiene ninguno.
function makeBlocks(
  repo: InMemoryScheduleBlockRepository = new InMemoryScheduleBlockRepository(),
): ScheduleBlockRepository {
  return repo;
}

function makeStaff(found: unknown = { userId: 'prov1' }): StaffRepository {
  return {
    findById: (): Promise<never> => Promise.resolve(found) as Promise<never>,
  } as unknown as StaffRepository;
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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
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

  describe('registerHistorical (carga histórica: seed demo, importaciones)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    // Hace 3 días a las 15:00 UTC (10:00 en Bogotá).
    const pastStart = new Date(
      Math.floor((Date.now() - 3 * DAY) / DAY) * DAY + 15 * 60 * 60 * 1000,
    );
    const pastEnd = new Date(pastStart.getTime() + 30 * 60 * 1000);

    it('acepta una cita en el pasado (la única regla que se salta)', async () => {
      const uc = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      const created = await uc.registerHistorical({
        patientId: 'p1',
        providerId: 'prov1',
        start: pastStart,
        end: pastEnd,
      });
      expect(created.start).toEqual(pastStart);
    });

    it('sigue rechazando end <= start', async () => {
      const uc = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        uc.registerHistorical({
          patientId: 'p1',
          providerId: 'prov1',
          start: pastEnd,
          end: pastStart,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sigue exigiendo que paciente y profesional sean de la clínica', async () => {
      const noPatient = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(null),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        noPatient.registerHistorical({
          patientId: 'ajeno',
          providerId: 'prov1',
          start: pastStart,
          end: pastEnd,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      const noProvider = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(),
        makeStaff(null),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        noProvider.registerHistorical({
          patientId: 'p1',
          providerId: 'ajeno',
          start: pastStart,
          end: pastEnd,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sigue rechazando solapes del profesional y del paciente con 409', async () => {
      const repo = new InMemoryAppointmentRepository();
      repo.seed({ providerId: 'prov1', start: pastStart, end: pastEnd });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        uc.registerHistorical({
          patientId: 'p2',
          providerId: 'prov1',
          start: pastStart,
          end: pastEnd,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sigue validando el horario de atención de la sede', async () => {
      // Abre solo un día DISTINTO al de la cita (10:00 Bogotá), así que ese día
      // está cerrado.
      const otherWeekday = (pastStart.getUTCDay() + 1) % 7;
      const closedThatDay: BusinessHours = {
        timezone: 'America/Bogota',
        ranges: [
          { weekday: otherWeekday, startMinute: 9 * 60, endMinute: 13 * 60 },
        ],
      };
      const uc = new CreateAppointmentUseCase(
        makeRepo({
          create: (): Promise<Appointment> =>
            Promise.reject(new Error('create should not be called')),
        }),
        makePatients(),
        makeStaff(),
        makeSchedule(closedThatDay),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        uc.registerHistorical({
          patientId: 'p1',
          providerId: 'prov1',
          start: pastStart,
          end: pastEnd,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('horario de atención de la sede', () => {
    // Sede en Bogotá (UTC-5 fijo) que abre lunes 9-13. `at()` construye horas en
    // Z sobre un día futuro, así que se calcula el lunes explícitamente.
    function mondayHours(): BusinessHours {
      return {
        timezone: 'America/Bogota',
        ranges: [{ weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 }],
      };
    }
    /** Próximo lunes a la hora local indicada, como instante UTC (Bogotá = +5). */
    function nextMondayLocal(hour: number): Date {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); // próximo lunes
      d.setUTCHours(hour + 5, 0, 0, 0);
      return d;
    }

    it('rechaza una cita fuera del horario, con el horario del día en el mensaje', async () => {
      const repo = makeRepo({
        create: (): Promise<Appointment> =>
          Promise.reject(new Error('create should not be called')),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(mondayHours()),
        makeTypes(),
        makeBlocks(),
      );
      const start = nextMondayLocal(20); // 20:00 local, cierra 13:00

      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov1',
          start,
          end: new Date(start.getTime() + 30 * 60 * 1000),
        }),
      ).rejects.toThrow(/Fuera del horario de atención \(lunes: 09:00–13:00\)/);
      // DX-121: 422 — la petición es válida, pero el hueco no existe.
      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov1',
          start,
          end: new Date(start.getTime() + 30 * 60 * 1000),
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('acepta una cita dentro del horario', async () => {
      const uc = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(),
        makeStaff(),
        makeSchedule(mondayHours()),
        makeTypes(),
        makeBlocks(),
      );
      const start = nextMondayLocal(10); // 10:00 local

      const result = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
      });

      expect(result.patientId).toBe('p1');
    });

    it('una sede SIN horario configurado no restringe nada (compatibilidad)', async () => {
      const uc = new CreateAppointmentUseCase(
        makeRepo(),
        makePatients(),
        makeStaff(),
        makeSchedule(null),
        makeTypes(),
        makeBlocks(),
      );
      const start = nextMondayLocal(3); // 03:00 local, madrugada

      const result = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
      });

      expect(result.patientId).toBe('p1');
    });
  });

  describe('pertenencia de paciente y profesional', () => {
    it('rechaza un paciente inexistente o de OTRA clínica (RLS lo devuelve null igual)', async () => {
      const repo = makeRepo({
        create: (): Promise<Appointment> =>
          Promise.reject(new Error('create should not be called')),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(null), // el repo de pacientes filtra por tenant vía RLS
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({
          patientId: 'de-otro-tenant',
          providerId: 'prov1',
          start,
          end,
        }),
      ).rejects.toThrow('Paciente no encontrado');
    });

    it('rechaza un providerId que no es staff activo de la clínica (antes pasaba cualquier UUID)', async () => {
      const repo = makeRepo({
        create: (): Promise<Appointment> =>
          Promise.reject(new Error('create should not be called')),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(null),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: '11111111-2222-3333-4444-555555555555',
          start,
          end,
        }),
      ).rejects.toThrow('Profesional no encontrado');
    });

    it('valida la pertenencia ANTES de mirar solapes (un id inválido hace que el solape no signifique nada)', async () => {
      let overlapChecked = false;
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => {
          overlapChecked = true;
          return Promise.resolve([]);
        },
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(null),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({ patientId: 'nope', providerId: 'prov1', start, end }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(overlapChecked).toBe(false);
    });
  });

  it('creates an appointment and returns the mapped entity when there is no overlap', async () => {
    const repo = makeRepo();
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
    const uc = new CreateAppointmentUseCase(
      repo,
      makePatients(),
      makeStaff(),
      makeSchedule(),
      makeTypes(),
      makeBlocks(),
    );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
      return new Prisma.PrismaClientKnownRequestError(
        'Raw query failed. Code: `23P01`.',
        {
          code: 'P2010',
          clientVersion: '6.19.3',
          meta: { code: '23P01' },
        },
      );
    }

    it('maps the ORM exclusion violation (23P01) to the SAME 409 as the pre-check', async () => {
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(ormExclusionError()),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

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
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(patientExclusion),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toThrow('El paciente ya tiene otra cita en ese horario');
    });

    it('also maps the raw-path shape (P2010 / meta.code 23P01) to 409', async () => {
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(rawExclusionError()),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does NOT swallow unrelated create errors (rethrows as-is)', async () => {
      const boom = new Prisma.PrismaClientUnknownRequestError(
        'some other db failure',
        {
          clientVersion: '6.19.3',
        },
      );
      const repo = makeRepo({
        findOverlapping: (): Promise<Appointment[]> => Promise.resolve([]),
        findOverlappingForPatient: (): Promise<Appointment[]> =>
          Promise.resolve([]),
        create: (): Promise<Appointment> => Promise.reject(boom),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toBe(boom);
    });
  });

  // DX-121: elegir un tipo («Endodoncia 90 min») fija la hora de fin.
  describe('tipo de cita', () => {
    it('sin `end`, la hora de fin sale de la duración del tipo', async () => {
      const types = new InMemoryAppointmentTypeRepository();
      const endo = types.seed({ name: 'Endodoncia', durationMinutes: 90 });
      const repo = new InMemoryAppointmentRepository();
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(types),
        makeBlocks(),
      );

      const created = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start: at('10:00'),
        appointmentTypeId: endo.id,
      });

      expect(created.end).toEqual(at('11:30'));
      expect(created.appointmentTypeId).toBe(endo.id);
    });

    it('un `end` explícito manda sobre la duración del tipo', async () => {
      const types = new InMemoryAppointmentTypeRepository();
      const endo = types.seed({ durationMinutes: 90 });
      const uc = new CreateAppointmentUseCase(
        new InMemoryAppointmentRepository(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(types),
        makeBlocks(),
      );
      const created = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start: at('10:00'),
        end: at('10:45'),
        appointmentTypeId: endo.id,
      });
      expect(created.end).toEqual(at('10:45'));
    });

    it('rechaza un tipo desactivado, retirado o de otra clínica con 400', async () => {
      const types = new InMemoryAppointmentTypeRepository();
      const inactive = types.seed({ active: false });
      const uc = new CreateAppointmentUseCase(
        new InMemoryAppointmentRepository(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(types),
        makeBlocks(),
      );
      for (const appointmentTypeId of [inactive.id, 'de-otra-clinica']) {
        await expect(
          uc.execute({
            patientId: 'p1',
            providerId: 'prov1',
            start: at('10:00'),
            appointmentTypeId,
          }),
        ).rejects.toThrow('El tipo de cita no existe o está desactivado');
      }
    });

    it('sin `end` ni tipo no hay forma de saber la duración: 400', async () => {
      const uc = new CreateAppointmentUseCase(
        new InMemoryAppointmentRepository(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(),
      );
      await expect(
        uc.execute({
          patientId: 'p1',
          providerId: 'prov1',
          start: at('10:00'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('bloqueos de agenda y pendientes (DX-122)', () => {
    const start = at('10:00');
    const end = at('10:30');

    it('un bloqueo de vacaciones del profesional impide agendar: 409 y no se crea', async () => {
      const repo = new InMemoryAppointmentRepository();
      const blocks = new InMemoryScheduleBlockRepository();
      blocks.seed({
        providerId: 'prov1',
        start: at('08:00'),
        end: at('20:00'),
      });
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(blocks),
      );

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).rejects.toThrow(
        new ConflictException(
          'La agenda del profesional está bloqueada (Vacaciones) del ' +
            blockRangeLabel(at('08:00'), at('20:00')) +
            '. Elige otro horario.',
        ),
      );
      await expect(
        repo.listByRange({ from: at('00:00'), to: at('23:59') }),
      ).resolves.toHaveLength(0);
    });

    it('el bloqueo de otro profesional o de otra sede no estorba', async () => {
      const blocks = new InMemoryScheduleBlockRepository();
      blocks.seed({ providerId: 'otro', start: at('08:00'), end: at('20:00') });
      blocks.seed({
        providerId: null,
        locationId: 'loc2',
        start: at('08:00'),
        end: at('20:00'),
      });
      const uc = new CreateAppointmentUseCase(
        new InMemoryAppointmentRepository(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(blocks),
      );

      await expect(
        uc.execute({ patientId: 'p1', providerId: 'prov1', start, end }),
      ).resolves.toMatchObject({ warnings: [] });
    });

    it('un bloqueo que deja agendar (almuerzo de la sede) crea la cita con un aviso', async () => {
      const blocks = new InMemoryScheduleBlockRepository();
      blocks.seed({
        providerId: null,
        locationId: 'loc1',
        kind: 'LUNCH',
        allowsBooking: true,
        start: at('10:00'),
        end: at('11:00'),
      });
      const uc = new CreateAppointmentUseCase(
        new InMemoryAppointmentRepository(),
        makePatients(),
        makeStaff(),
        makeSchedule(),
        makeTypes(),
        makeBlocks(blocks),
      );

      const created = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end,
      });
      expect(created.id).toBeDefined();
      expect(created.warnings).toHaveLength(1);
      expect(created.warnings[0]).toMatch(
        /^La cita cae en un bloqueo que permite agendar: Almuerzo/,
      );
    });

    it('desde pendientes: usa la sede de la entrada (horario y bloqueos) y la marca SCHEDULED', async () => {
      const waitlist = new InMemoryWaitlistRepository();
      const entry = waitlist.seed({ locationId: 'loc2', patientId: 'p1' });
      const repo = new InMemoryAppointmentRepository(waitlist);
      const blocks = new InMemoryScheduleBlockRepository();
      // Bloqueo de la sede del request (loc1): no aplica a una cita de loc2.
      blocks.seed({
        providerId: null,
        locationId: 'loc1',
        start: at('08:00'),
        end: at('20:00'),
      });
      let scheduleLocation: string | undefined;
      const schedule = {
        ...makeSchedule(),
        findByLocation: (locationId: string): Promise<never> => {
          scheduleLocation = locationId;
          return Promise.resolve(null) as Promise<never>;
        },
        findForCurrentLocation: (): Promise<never> =>
          Promise.reject(new Error('no debe mirar la sede del request')),
      };
      const uc = new CreateAppointmentUseCase(
        repo,
        makePatients(),
        makeStaff(),
        schedule,
        makeTypes(),
        makeBlocks(blocks),
      );

      const created = await uc.execute({
        patientId: 'p1',
        providerId: 'prov1',
        start,
        end,
        locationId: 'loc2',
        waitlistEntryId: entry.id,
        createdById: 'u-rec',
      });
      expect(created.locationId).toBe('loc2');
      expect(scheduleLocation).toBe('loc2');
      expect(waitlist.rows[0]).toMatchObject({
        status: 'SCHEDULED',
        resolvedAppointmentId: created.id,
        resolvedById: 'u-rec',
      });
    });
  });
});

/** «20/10 08:00 al 20/10 20:00» en la zona del fake de bloqueos (Bogotá). */
function blockRangeLabel(from: Date, to: Date): string {
  const f = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const label = (d: Date) => {
    const p = Object.fromEntries(
      f.formatToParts(d).map((x) => [x.type, x.value]),
    );
    return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
  };
  return `${label(from)} al ${label(to)}`;
}
