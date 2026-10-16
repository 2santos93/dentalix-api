import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { WaitlistPriority } from '@prisma/client';
import {
  CreateWaitlistEntryUseCase,
  DismissWaitlistEntryUseCase,
  ListWaitlistUseCase,
  ScheduleFromWaitlistUseCase,
} from './waitlist.use-cases';
import { InMemoryWaitlistRepository } from '../__fixtures__/in-memory-waitlist';
import { InMemoryAppointmentRepository } from '../../../appointments/application/use-cases/__fixtures__/in-memory-appointment.repository';
import { CreateAppointmentUseCase } from '../../../appointments/application/use-cases/create-appointment.use-case';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import { InMemoryAppointmentTypeRepository } from '../../../appointment-types/application/__fixtures__/in-memory-appointment-types';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u-rec', role: 'RECEPTION' },
  requestId: 'req-1',
  ip: '127.0.0.1',
  userAgent: 'jest',
};

const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

function known<T>(ids: string[], shape: (id: string) => T) {
  return (id: string) => Promise.resolve(ids.includes(id) ? shape(id) : null);
}

const patients = {
  findById: known(['p1', 'p2'], (id) => ({ id })),
} as unknown as PatientRepository;
const staff = {
  findById: known(['prov1', 'prov2'], (userId) => ({ userId })),
} as unknown as StaffRepository;
const locations = {
  findById: known(['loc1', 'loc2'], (id) => ({
    id,
    timeZone: 'America/Bogota',
  })),
} as unknown as LocationRepository;
const noSchedule = {
  findByLocation: () => Promise.resolve(null),
  findForCurrentLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;

function audit(drafts: AuditEventDraft[]): RecordAuditEventUseCase {
  return {
    record: (d: AuditEventDraft) => {
      drafts.push(d);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
}

describe('pendientes por agendar (DX-122)', () => {
  let waitlist: InMemoryWaitlistRepository;
  let types: InMemoryAppointmentTypeRepository;
  let drafts: AuditEventDraft[];

  beforeEach(() => {
    waitlist = new InMemoryWaitlistRepository();
    types = new InMemoryAppointmentTypeRepository();
    drafts = [];
  });

  describe('listar', () => {
    it('OPEN por defecto, urgentes primero y luego por antigüedad, paginado', async () => {
      const old = waitlist.seed({ patientId: 'p1' });
      const urgent = waitlist.seed({
        patientId: 'p2',
        priority: WaitlistPriority.URGENT,
      });
      waitlist.seed({
        status: 'DISMISSED',
        dismissReason: 'x',
        resolvedAt: new Date(),
      });
      const list = new ListWaitlistUseCase(waitlist, locations);

      const page = await list.execute({});
      expect(page.items.map((e) => e.id)).toEqual([urgent.id, old.id]);
      expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      await expect(
        list.execute({ page: 2, pageSize: 1 }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ id: old.id })],
        total: 2,
      });
    });

    it('una sede de otra clínica es 404', async () => {
      const list = new ListWaitlistUseCase(waitlist, locations);
      await expect(list.execute({ locationId: 'ajena' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('alta manual', () => {
    function useCase() {
      return new CreateWaitlistEntryUseCase(
        waitlist,
        patients,
        locations,
        staff,
        types,
        audit(drafts),
      );
    }

    it('valida a quién y dónde, toma la duración del tipo y audita con el paciente', async () => {
      const type = types.seed({ durationMinutes: 90 });
      const entry = await useCase().execute(
        {
          patientId: 'p1',
          providerId: 'prov1',
          appointmentTypeId: type.id,
          priority: WaitlistPriority.URGENT,
          preferredWindow: '  Mañanas  ',
        },
        CTX,
      );
      expect(entry).toMatchObject({
        patientId: 'p1',
        durationMinutes: 90,
        priority: 'URGENT',
        preferredWindow: 'Mañanas',
        createdById: 'u-rec',
        status: 'OPEN',
      });
      expect(drafts).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'WAITLIST_ENTRY',
          resourceId: entry.id,
          patient: { kind: 'patient', id: 'p1' },
          metadata: { reason: 'WAITLIST_MANUAL' },
        }),
      ]);
    });

    it('rechaza paciente, sede o profesional ajenos (404) y tipo desactivado (400)', async () => {
      await expect(
        useCase().execute({ patientId: 'ajeno' }, CTX),
      ).rejects.toThrow(NotFoundException);
      await expect(
        useCase().execute({ patientId: 'p1', locationId: 'ajena' }, CTX),
      ).rejects.toThrow(NotFoundException);
      await expect(
        useCase().execute({ patientId: 'p1', providerId: 'ajeno' }, CTX),
      ).rejects.toThrow(NotFoundException);
      const off = types.seed({ active: false });
      await expect(
        useCase().execute({ patientId: 'p1', appointmentTypeId: off.id }, CTX),
      ).rejects.toThrow(BadRequestException);
      await expect(
        useCase().execute({ patientId: 'p1', note: '   ' }, CTX),
      ).rejects.toThrow(BadRequestException);
      expect(waitlist.rows).toHaveLength(0);
      expect(drafts).toHaveLength(0);
    });
  });

  describe('descartar', () => {
    it('con motivo, una sola vez, y deja audit_event', async () => {
      const entry = waitlist.seed({ patientId: 'p2' });
      const dismiss = new DismissWaitlistEntryUseCase(waitlist, audit(drafts));

      await expect(dismiss.execute(entry.id, '   ', CTX)).rejects.toThrow(
        BadRequestException,
      );
      const done = await dismiss.execute(entry.id, ' Se mudó de ciudad ', CTX);
      expect(done).toMatchObject({
        status: 'DISMISSED',
        dismissReason: 'Se mudó de ciudad',
      });
      await expect(dismiss.execute(entry.id, 'otra vez', CTX)).rejects.toThrow(
        ConflictException,
      );
      await expect(dismiss.execute('nope', 'x', CTX)).rejects.toThrow(
        NotFoundException,
      );
      expect(drafts).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          resourceType: 'WAITLIST_ENTRY',
          resourceId: entry.id,
          patient: { kind: 'patient', id: 'p2' },
          metadata: { reason: 'WAITLIST_DISMISSED' },
        }),
      ]);
    });
  });

  describe('agendar desde la entrada («Agendar aquí»)', () => {
    function useCase(blocks = new InMemoryScheduleBlockRepository()) {
      const appointments = new InMemoryAppointmentRepository(waitlist);
      const create = new CreateAppointmentUseCase(
        appointments,
        patients,
        staff,
        noSchedule,
        types,
        blocks,
      );
      return {
        appointments,
        schedule: new ScheduleFromWaitlistUseCase(
          waitlist,
          types,
          create,
          audit(drafts),
        ),
      };
    }

    it('crea la cita del paciente en la sede de la entrada, con su duración, y la saca de la lista', async () => {
      const entry = waitlist.seed({
        patientId: 'p2',
        locationId: 'loc2',
        durationMinutes: 45,
      });
      const { schedule } = useCase();

      const created = await schedule.execute(
        entry.id,
        { providerId: 'prov1', start: at('15:00') },
        CTX,
      );
      expect(created).toMatchObject({
        patientId: 'p2',
        providerId: 'prov1',
        locationId: 'loc2',
        start: at('15:00'),
        end: at('15:45'),
        warnings: [],
      });
      expect(waitlist.rows[0]).toMatchObject({
        status: 'SCHEDULED',
        resolvedAppointmentId: created.id,
      });
      expect(drafts).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'WAITLIST_ENTRY',
          resourceId: entry.id,
          patient: { kind: 'patient', id: 'p2' },
          metadata: { reason: 'WAITLIST_SCHEDULED' },
        }),
      ]);
    });

    it('hereda el tipo de la entrada si sigue activo; si se desactivó, agenda sin tipo', async () => {
      const active = types.seed({ name: 'Limpieza', durationMinutes: 40 });
      const off = types.seed({ name: 'Viejo', active: false });
      const a = waitlist.seed({
        appointmentTypeId: active.id,
        durationMinutes: 40,
      });
      const b = waitlist.seed({ appointmentTypeId: off.id });
      const { schedule } = useCase();

      await expect(
        schedule.execute(
          a.id,
          { providerId: 'prov1', start: at('09:00') },
          CTX,
        ),
      ).resolves.toMatchObject({ appointmentTypeId: active.id });
      await expect(
        schedule.execute(
          b.id,
          { providerId: 'prov1', start: at('11:00') },
          CTX,
        ),
      ).resolves.toMatchObject({ appointmentTypeId: null });
    });

    it('una entrada ya agendada o descartada: 409 y no se crea otra cita', async () => {
      const entry = waitlist.seed({});
      const { schedule, appointments } = useCase();
      await schedule.execute(
        entry.id,
        { providerId: 'prov1', start: at('09:00') },
        CTX,
      );

      await expect(
        schedule.execute(
          entry.id,
          { providerId: 'prov1', start: at('10:00') },
          CTX,
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        appointments.listByRange({ from: at('00:00'), to: at('23:59') }),
      ).resolves.toHaveLength(1);
      await expect(
        schedule.execute(
          'nope',
          { providerId: 'prov1', start: at('10:00') },
          CTX,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('si el hueco está bloqueado, 409 del bloqueo y la entrada sigue OPEN', async () => {
      const entry = waitlist.seed({ locationId: 'loc1' });
      const blocks = new InMemoryScheduleBlockRepository();
      blocks.seed({
        providerId: 'prov1',
        start: at('08:00'),
        end: at('20:00'),
      });
      const { schedule } = useCase(blocks);

      await expect(
        schedule.execute(
          entry.id,
          { providerId: 'prov1', start: at('10:00') },
          CTX,
        ),
      ).rejects.toThrow(/bloqueada/);
      expect(waitlist.rows[0].status).toBe('OPEN');
    });
  });
});
