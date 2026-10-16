import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import {
  CreateScheduleBlockUseCase,
  DeleteScheduleBlockUseCase,
  ListAffectedAppointmentsUseCase,
  ListScheduleBlocksUseCase,
  UpdateScheduleBlockUseCase,
  type ScheduleBlockActor,
} from './schedule-blocks.use-cases';
import { InMemoryScheduleBlockRepository } from '../__fixtures__/in-memory-schedule-blocks';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';

const z = (iso: string) => new Date(iso);
const ADMIN: ScheduleBlockActor = { userId: 'admin', role: ClinicRole.ADMIN };
const RECEPTION: ScheduleBlockActor = {
  userId: 'rec',
  role: ClinicRole.RECEPTION,
};
const DOCTOR: ScheduleBlockActor = { userId: 'doc', role: ClinicRole.DENTIST };

function makeLocations(known: string[] = ['loc1', 'loc2']): LocationRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(
        known.includes(id) ? { id, timeZone: 'America/Bogota' } : null,
      ),
  } as unknown as LocationRepository;
}

function makeStaff(
  known: string[] = ['doc', 'doc2', 'admin'],
): StaffRepository {
  return {
    findById: (userId: string) =>
      Promise.resolve(known.includes(userId) ? { userId } : null),
  } as unknown as StaffRepository;
}

const VACATION = {
  providerId: 'doc',
  start: z('2026-10-20T13:00:00.000Z'),
  end: z('2026-10-25T00:00:00.000Z'),
  kind: ScheduleBlockKind.VACATION,
};

describe('bloqueos de agenda (DX-122)', () => {
  let repo: InMemoryScheduleBlockRepository;
  let create: CreateScheduleBlockUseCase;
  let update: UpdateScheduleBlockUseCase;
  let remove: DeleteScheduleBlockUseCase;

  beforeEach(() => {
    repo = new InMemoryScheduleBlockRepository();
    create = new CreateScheduleBlockUseCase(repo, makeLocations(), makeStaff());
    update = new UpdateScheduleBlockUseCase(repo, makeLocations(), makeStaff());
    remove = new DeleteScheduleBlockUseCase(repo);
  });

  describe('crear', () => {
    it('recepción bloquea las vacaciones de una doctora en todas las sedes', async () => {
      const block = await create.execute(VACATION, RECEPTION);
      expect(block).toMatchObject({
        providerId: 'doc',
        locationId: null,
        kind: 'VACATION',
        allowsBooking: false,
        createdById: 'rec',
      });
    });

    it('un bloqueo de sede exige la sede; sin sede ni profesional, 400', async () => {
      await expect(
        create.execute({ ...VACATION, providerId: undefined }, ADMIN),
      ).rejects.toThrow(BadRequestException);
      const sede = await create.execute(
        {
          ...VACATION,
          providerId: undefined,
          locationId: 'loc1',
          kind: ScheduleBlockKind.MEETING,
        },
        ADMIN,
      );
      expect(sede).toMatchObject({ providerId: null, locationId: 'loc1' });
    });

    it('rechaza fin antes del inicio, nota vacía y sede o profesional ajenos', async () => {
      await expect(
        create.execute({ ...VACATION, end: VACATION.start }, ADMIN),
      ).rejects.toThrow(BadRequestException);
      await expect(
        create.execute({ ...VACATION, note: '  ' }, ADMIN),
      ).rejects.toThrow(BadRequestException);
      await expect(
        create.execute({ ...VACATION, locationId: 'otra-clinica' }, ADMIN),
      ).rejects.toThrow(NotFoundException);
      await expect(
        create.execute({ ...VACATION, providerId: 'ajeno' }, ADMIN),
      ).rejects.toThrow(NotFoundException);
    });

    it('guarda la nota recortada', async () => {
      const block = await create.execute(
        { ...VACATION, note: '  Congreso SEPA  ' },
        ADMIN,
      );
      expect(block.note).toBe('Congreso SEPA');
    });

    it('encima de citas: no las toca, pide confirmación (409) y con ella crea', async () => {
      repo.appointments.push({
        id: 'a1',
        locationId: 'loc1',
        providerId: 'doc',
        start: z('2026-10-21T14:00:00.000Z'),
        end: z('2026-10-21T14:30:00.000Z'),
        status: 'SCHEDULED',
        patientFirstName: 'Ana',
        patientLastName: 'Ruiz',
      });
      await expect(create.execute(VACATION, RECEPTION)).rejects.toThrow(
        new ConflictException(
          'Hay 1 cita en ese horario. Las citas no se borran: revísalas y confirma el bloqueo.',
        ),
      );
      expect(repo.rows).toHaveLength(0);
      const block = await create.execute(
        { ...VACATION, confirmAffected: true },
        RECEPTION,
      );
      expect(block.id).toBeDefined();
      expect(repo.appointments).toHaveLength(1);
    });

    it('la doctora puede bloquear su propia agenda, pero no la de otra ni la sede', async () => {
      await expect(create.execute(VACATION, DOCTOR)).resolves.toMatchObject({
        providerId: 'doc',
      });
      await expect(
        create.execute({ ...VACATION, providerId: 'doc2' }, DOCTOR),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        create.execute(
          { ...VACATION, providerId: undefined, locationId: 'loc1' },
          DOCTOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('cambiar y retirar', () => {
    it('cambia el rango y el tipo; un bloqueo ajeno o retirado da 404', async () => {
      const block = repo.seed({ providerId: 'doc' });
      const updated = await update.execute(
        block.id,
        { kind: ScheduleBlockKind.MEETING, allowsBooking: true },
        ADMIN,
      );
      expect(updated).toMatchObject({ kind: 'MEETING', allowsBooking: true });
      await expect(
        update.execute('nope', { allowsBooking: true }, ADMIN),
      ).rejects.toThrow(NotFoundException);
      await remove.execute(block.id, ADMIN);
      await expect(remove.execute(block.id, ADMIN)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('al ampliar sobre citas pide confirmación', async () => {
      const block = repo.seed({
        providerId: 'doc',
        start: z('2026-10-20T13:00:00.000Z'),
        end: z('2026-10-20T14:00:00.000Z'),
      });
      repo.appointments.push({
        id: 'a1',
        locationId: 'loc1',
        providerId: 'doc',
        start: z('2026-10-20T15:00:00.000Z'),
        end: z('2026-10-20T15:30:00.000Z'),
        status: 'CONFIRMED',
        patientFirstName: 'Ana',
        patientLastName: 'Ruiz',
      });
      await expect(
        update.execute(block.id, { end: z('2026-10-20T16:00:00.000Z') }, ADMIN),
      ).rejects.toThrow(ConflictException);
      await expect(
        update.execute(
          block.id,
          { end: z('2026-10-20T16:00:00.000Z'), confirmAffected: true },
          ADMIN,
        ),
      ).resolves.toMatchObject({ end: z('2026-10-20T16:00:00.000Z') });
    });

    it('la doctora solo cambia o retira los suyos', async () => {
      const ajeno = repo.seed({ providerId: 'doc2' });
      await expect(
        update.execute(ajeno.id, { allowsBooking: true }, DOCTOR),
      ).rejects.toThrow(ForbiddenException);
      await expect(remove.execute(ajeno.id, DOCTOR)).rejects.toThrow(
        ForbiddenException,
      );
      const propio = repo.seed({ providerId: 'doc' });
      await expect(remove.execute(propio.id, DOCTOR)).resolves.toBeUndefined();
    });
  });

  describe('listar', () => {
    it('valida el rango (máx. 92 días) y la cantidad de profesionales', async () => {
      const list = new ListScheduleBlocksUseCase(
        repo,
        makeLocations(),
        makeStaff(),
      );
      repo.seed({ providerId: 'doc' });
      await expect(
        list.execute({
          from: z('2026-10-19T00:00:00Z'),
          to: z('2026-10-26T00:00:00Z'),
        }),
      ).resolves.toHaveLength(1);
      await expect(
        list.execute({
          from: z('2026-10-19T00:00:00Z'),
          to: z('2027-02-19T00:00:00Z'),
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        list.execute({
          from: z('2026-10-19T00:00:00Z'),
          to: z('2026-10-19T00:00:00Z'),
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        list.execute({
          from: z('2026-10-19T00:00:00Z'),
          to: z('2026-10-26T00:00:00Z'),
          locationId: 'otra-clinica',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('lista las citas que quedarían dentro de un bloqueo', async () => {
      const affected = new ListAffectedAppointmentsUseCase(
        repo,
        makeLocations(),
        makeStaff(),
      );
      repo.appointments.push({
        id: 'a1',
        locationId: 'loc1',
        providerId: 'doc',
        start: z('2026-10-21T14:00:00.000Z'),
        end: z('2026-10-21T14:30:00.000Z'),
        status: 'SCHEDULED',
        patientFirstName: 'Ana',
        patientLastName: 'Ruiz',
      });
      await expect(
        affected.execute({
          providerId: 'doc',
          start: VACATION.start,
          end: VACATION.end,
        }),
      ).resolves.toEqual([expect.objectContaining({ id: 'a1' })]);
      await expect(
        affected.execute({ start: VACATION.start, end: VACATION.end }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
