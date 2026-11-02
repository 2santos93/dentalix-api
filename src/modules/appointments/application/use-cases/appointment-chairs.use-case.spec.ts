import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { CreateAppointmentUseCase } from './create-appointment.use-case';
import { UpdateAppointmentUseCase } from './update-appointment.use-case';
import { ListAppointmentsUseCase } from './list-appointments.use-case';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { ChairAssignmentService } from '../chair-assignment';
import { InMemoryChairRepository } from '../../../chairs/application/__fixtures__/in-memory-chairs';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import { InMemoryAppointmentTypeRepository } from '../../../appointment-types/application/__fixtures__/in-memory-appointment-types';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import { systemScheduleBlockClock } from '../../../schedule-blocks/application/schedule-block-clock';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { Appointment } from '../../domain/entities/appointment.entity';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

// DX-211: el sillón como recurso de la cita. Día siempre futuro (crear y
// reagendar rechazan el pasado). La sede del doble es 'loc1' en la zona de la sede: las
// 15:00 UTC son las 10:00 de pared.
const DAY = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

const patients = {
  findById: (id: string) => Promise.resolve({ id }),
} as unknown as PatientRepository;
const staff = {
  findById: (userId: string) =>
    Promise.resolve(userId === 'ajeno' ? null : { userId, locationIds: null }),
  listActive: () =>
    Promise.resolve([
      { userId: 'dra', locationIds: null },
      { userId: 'dr', locationIds: null },
    ]),
} as unknown as StaffRepository;
const schedule = {
  findByLocation: () => Promise.resolve(null),
  findForCurrentLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;
const locations = {
  findById: (id: string) =>
    Promise.resolve({
      id,
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      hourCycle: 'h23',
    }),
} as unknown as LocationRepository;

describe('sillón de la cita (DX-211)', () => {
  let repo: InMemoryAppointmentRepository;
  let chairs: InMemoryChairRepository;
  let create: CreateAppointmentUseCase;
  let update: UpdateAppointmentUseCase;
  let list: ListAppointmentsUseCase;
  let drafts: AuditEventDraft[];

  beforeEach(() => {
    repo = new InMemoryAppointmentRepository();
    chairs = new InMemoryChairRepository();
    drafts = [];
    const assignment = new ChairAssignmentService(chairs, repo, locations);
    const ctx = new TenantContextService();
    create = new CreateAppointmentUseCase(
      repo,
      patients,
      staff,
      schedule,
      new InMemoryAppointmentTypeRepository(),
      new InMemoryScheduleBlockRepository(),
      ctx,
      inMemoryAvailability(),
      systemScheduleBlockClock,
      assignment,
    );
    const audit = {
      record: (draft: AuditEventDraft) => {
        drafts.push(draft);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    update = new UpdateAppointmentUseCase(
      repo,
      schedule,
      staff,
      audit,
      new InMemoryScheduleBlockRepository(),
      locations,
      ctx,
      inMemoryAvailability(),
      systemScheduleBlockClock,
      assignment,
    );
    list = new ListAppointmentsUseCase(repo, staff, ctx, chairs);
  });

  /** Sillón en la sede del doble, también embebido en las citas. */
  function seedChair(partial: Parameters<InMemoryChairRepository['seed']>[0]) {
    const chair = chairs.seed({ locationId: 'loc1', ...partial });
    repo.chairDirectory.set(chair.id, {
      id: chair.id,
      name: chair.name,
      active: chair.active,
    });
    return chair;
  }

  const book = (
    input: Partial<Parameters<CreateAppointmentUseCase['execute']>[0]>,
  ) =>
    create.execute({
      patientId: 'p1',
      providerId: 'dra',
      start: at('15:00'),
      end: at('15:30'),
      ...input,
    });

  describe('crear', () => {
    it('guarda el sillón y lo embebe en la respuesta', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      await expect(book({ chairId: chair.id })).resolves.toMatchObject({
        chairId: chair.id,
        chair: { id: chair.id, name: 'Sillón 1', active: true },
      });
    });

    it('dos profesionales en el mismo sillón y franja: 409 con el nombre y las horas de la sede', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      await book({ chairId: chair.id });
      await expect(
        book({ chairId: chair.id, providerId: 'dr', patientId: 'p2' }),
      ).rejects.toThrow(
        new ConflictException(
          'El sillón «Sillón 1» ya está ocupado de 10:00 a 10:30',
        ),
      );
    });

    it('en sillones distintos, las dos citas se guardan', async () => {
      const one = seedChair({ name: 'Sillón 1' });
      const two = seedChair({ name: 'Sillón 2' });
      await book({ chairId: one.id });
      await expect(
        book({ chairId: two.id, providerId: 'dr', patientId: 'p2' }),
      ).resolves.toMatchObject({ chairId: two.id });
    });

    it('sin sillón nada cambia: dos profesionales a la misma hora se guardan', async () => {
      await book({});
      await expect(
        book({ providerId: 'dr', patientId: 'p2' }),
      ).resolves.toMatchObject({ chairId: null, chair: null });
    });

    it('sillón de otra clínica: 404; de otra sede o desactivado: 400', async () => {
      await expect(book({ chairId: 'ajeno' })).rejects.toThrow(
        new NotFoundException('Sillón no encontrado'),
      );
      const sur = seedChair({ locationId: 'sur', name: 'Sillón Sur' });
      await expect(book({ chairId: sur.id })).rejects.toThrow(
        new BadRequestException(
          'El sillón «Sillón Sur» es de otra sede: elige un sillón de la sede de la cita',
        ),
      );
      const off = seedChair({ name: 'Viejo', active: false });
      await expect(book({ chairId: off.id })).rejects.toThrow(
        new BadRequestException(
          'El sillón «Viejo» está desactivado: elige otro sillón',
        ),
      );
    });

    it('sin profesional, toma el del sillón; uno elegido manda sobre él', async () => {
      const chair = seedChair({ defaultProviderId: 'dr' });
      await expect(
        book({ chairId: chair.id, providerId: undefined }),
      ).resolves.toMatchObject({ providerId: 'dr' });
      const other = seedChair({ defaultProviderId: 'dr' });
      await expect(
        book({
          chairId: other.id,
          providerId: 'dra',
          patientId: 'p2',
          start: at('16:00'),
          end: at('16:30'),
        }),
      ).resolves.toMatchObject({ providerId: 'dra' });
    });

    it('sin profesional ni del sillón: 400', async () => {
      const chair = seedChair({});
      await expect(
        book({ chairId: chair.id, providerId: undefined }),
      ).rejects.toThrow(
        new BadRequestException(
          'Elige un profesional: el sillón no tiene profesional por defecto',
        ),
      );
      await expect(book({ providerId: undefined })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('la carrera que gana otra cita (23P01 por sillón) da el mismo 409', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      const winner = repo.seed({
        chairId: chair.id,
        start: at('15:00'),
        end: at('15:30'),
      });
      jest
        .spyOn(repo, 'findOverlappingForChair')
        .mockResolvedValueOnce([])
        .mockResolvedValue([winner]);
      jest
        .spyOn(repo, 'create')
        .mockRejectedValue(
          new Prisma.PrismaClientUnknownRequestError(
            'ERROR: conflicting key value violates exclusion constraint "appointments_no_overlap_per_chair" (23P01)',
            { clientVersion: 'test' },
          ),
        );
      await expect(
        book({ chairId: chair.id, providerId: 'dr', patientId: 'p2' }),
      ).rejects.toThrow(
        new ConflictException(
          'El sillón «Sillón 1» ya está ocupado de 10:00 a 10:30',
        ),
      );
    });
  });

  describe('mover y reprogramar', () => {
    async function booked(chairId: string | undefined): Promise<Appointment> {
      return book(chairId ? { chairId } : {});
    }

    it('reprogramar una cita con sillón a una franja ocupada en ese sillón: 409', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      await book({ chairId: chair.id, start: at('16:00'), end: at('16:30') });
      const mine = await book({
        chairId: chair.id,
        providerId: 'dr',
        patientId: 'p2',
      });
      await expect(
        update.execute(mine.id, { start: at('16:15'), end: at('16:45') }),
      ).rejects.toThrow(
        new ConflictException(
          'El sillón «Sillón 1» ya está ocupado de 11:00 a 11:30',
        ),
      );
    });

    it('cambiar solo de sillón valida el sillón destino y deja el movimiento auditado', async () => {
      const one = seedChair({ name: 'Sillón 1' });
      const two = seedChair({ name: 'Sillón 2' });
      const mine = await booked(one.id);
      const moved = await update.execute(
        mine.id,
        { chairId: two.id },
        {
          tenantId: 't1',
          locationId: 'loc1',
          actor: { userId: 'rec', role: 'RECEPTION' },
          requestId: 'r1',
          ip: null,
          userAgent: null,
        },
      );
      expect(moved).toMatchObject({ chairId: two.id });
      const metadata = drafts[0]?.metadata as
        | {
            reason?: string;
            move?: {
              from: { chairId?: string | null };
              to: { chairId?: string | null };
            };
          }
        | undefined;
      expect(drafts).toHaveLength(1);
      expect(metadata?.reason).toBe('APPOINTMENT_MOVED');
      expect(metadata?.move?.from.chairId).toBe(one.id);
      expect(metadata?.move?.to.chairId).toBe(two.id);
    });

    it('asignar un sillón de otra sede o desactivado al editar: 400; quitarlo (null) vale', async () => {
      const mine = await booked(undefined);
      const sur = seedChair({ locationId: 'sur' });
      await expect(
        update.execute(mine.id, { chairId: sur.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const off = seedChair({ active: false });
      await expect(
        update.execute(mine.id, { chairId: off.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      const chair = seedChair({});
      await update.execute(mine.id, { chairId: chair.id });
      await expect(
        update.execute(mine.id, { chairId: null }),
      ).resolves.toMatchObject({ chairId: null });
    });

    it('con un sillón ya desactivado, la cita se puede completar pero no reprogramar', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      const mine = await booked(chair.id);
      chairs.rows[0].active = false;
      await expect(
        update.execute(mine.id, { status: AppointmentStatus.CONFIRMED }),
      ).resolves.toMatchObject({ status: AppointmentStatus.CONFIRMED });
      await expect(
        update.execute(mine.id, { start: at('17:00'), end: at('17:30') }),
      ).rejects.toThrow(
        new BadRequestException(
          'El sillón «Sillón 1» está desactivado: elige otro sillón',
        ),
      );
    });

    it('sin sillón, mover la cita no mira ningún sillón', async () => {
      const mine = await booked(undefined);
      const spy = jest.spyOn(repo, 'findOverlappingForChair');
      await update.execute(mine.id, { start: at('18:00'), end: at('18:30') });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('revisión: cambiar solo el sillón (A1) y canceladas (M2)', () => {
    it('cambiar solo el sillón con la misma hora y profesional no es reagendar: conserva la confirmación', async () => {
      const one = seedChair({ name: 'Sillón 1' });
      const two = seedChair({ name: 'Sillón 2' });
      const sentAt = new Date('2026-01-02T00:00:00.000Z');
      const mine = repo.seed({
        chairId: one.id,
        providerId: 'dra',
        start: at('15:00'),
        end: at('15:30'),
        confirmationSentAt: sentAt,
      });
      const spy = jest.spyOn(repo, 'update');
      const moved = await update.execute(mine.id, {
        chairId: two.id,
        start: at('15:00'),
        end: at('15:30'),
        providerId: 'dra',
      });
      expect(moved).toMatchObject({
        chairId: two.id,
        confirmationSentAt: sentAt,
      });
      const patch = spy.mock.calls[0][1];
      expect(patch.revokeConfirmations).toBeUndefined();
      expect(patch).not.toHaveProperty('confirmationSentAt');
    });

    it('se cambia el sillón de una cita de hoy ya empezada (en la clínica), aunque su hora ya pasó', async () => {
      const one = seedChair({ name: 'Sillón 1' });
      const two = seedChair({ name: 'Sillón 2' });
      const started = new Date(Date.now() - 10 * 60_000);
      const mine = repo.seed({
        chairId: one.id,
        start: started,
        end: new Date(started.getTime() + 30 * 60_000),
        status: AppointmentStatus.IN_CHAIR,
        arrivedAt: started,
        seatedAt: started,
      });
      await expect(
        update.execute(mine.id, {
          chairId: two.id,
          start: mine.start,
          end: mine.end,
          providerId: mine.providerId,
        }),
      ).resolves.toMatchObject({
        chairId: two.id,
        status: AppointmentStatus.IN_CHAIR,
      });
    });

    it('asignar un sillón de otra sede o desactivado a una cita cancelada también se rechaza', async () => {
      const mine = repo.seed({ status: AppointmentStatus.CANCELLED });
      const off = seedChair({ active: false });
      const sur = seedChair({ locationId: 'sur' });
      await expect(
        update.execute(mine.id, { chairId: off.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        update.execute(mine.id, { chairId: sur.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una cancelada sí puede pasar a un sillón activo ocupado (no lo ocupa)', async () => {
      const chair = seedChair({});
      repo.seed({ chairId: chair.id, start: at('15:00'), end: at('15:30') });
      const mine = repo.seed({
        status: AppointmentStatus.CANCELLED,
        patientId: 'p9',
        start: at('15:00'),
        end: at('15:30'),
      });
      await expect(
        update.execute(mine.id, { chairId: chair.id }),
      ).resolves.toMatchObject({ chairId: chair.id });
    });

    it('reactivar una cancelada cuyo sillón se desactivó exige un sillón activo', async () => {
      const chair = seedChair({ name: 'Viejo' });
      const mine = repo.seed({
        chairId: chair.id,
        status: AppointmentStatus.CANCELLED,
        start: at('18:00'),
        end: at('18:30'),
      });
      chairs.rows.find((c) => c.id === chair.id)!.active = false;
      await expect(
        update.execute(mine.id, { status: AppointmentStatus.SCHEDULED }),
      ).rejects.toThrow(
        new BadRequestException(
          'El sillón «Viejo» está desactivado: elige otro sillón',
        ),
      );
    });

    it('reactivar una cancelada cuyo sillón se ocupó mientras tanto: 409', async () => {
      const chair = seedChair({ name: 'Sillón 1' });
      const mine = repo.seed({
        chairId: chair.id,
        status: AppointmentStatus.CANCELLED,
        start: at('19:00'),
        end: at('19:30'),
      });
      repo.seed({
        chairId: chair.id,
        patientId: 'p7',
        providerId: 'otro',
        start: at('19:00'),
        end: at('19:30'),
      });
      await expect(
        update.execute(mine.id, { status: AppointmentStatus.SCHEDULED }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('revisión: mensaje sin profesional (B2)', () => {
    it('sin sillón ni profesional pide elegir un profesional', async () => {
      await expect(book({ providerId: undefined })).rejects.toThrow(
        new BadRequestException('Elige un profesional'),
      );
    });
  });

  describe('listar', () => {
    it('chairIds filtra por sillones de la sede; uno ajeno o de otra sede es 400', async () => {
      const one = seedChair({ name: 'Sillón 1' });
      const two = seedChair({ name: 'Sillón 2' });
      const sur = seedChair({ locationId: 'sur' });
      const a = await book({ chairId: one.id });
      await book({
        chairId: two.id,
        providerId: 'dr',
        patientId: 'p2',
      });
      await book({
        providerId: 'dr',
        patientId: 'p3',
        start: at('17:00'),
        end: at('17:30'),
      });
      const rows = await list.execute({
        from: at('00:00'),
        to: at('23:59'),
        locationId: 'loc1',
        chairIds: [one.id],
      });
      expect(rows.map((r) => r.id)).toEqual([a.id]);
      for (const chairIds of [['ajeno'], [sur.id]]) {
        await expect(
          list.execute({
            from: at('00:00'),
            to: at('23:59'),
            locationId: 'loc1',
            chairIds,
          }),
        ).rejects.toThrow(
          new BadRequestException('Algún sillón no es de esta sede'),
        );
      }
    });
  });
});
