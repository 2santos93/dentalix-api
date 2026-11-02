import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FindOpeningsUseCase } from './find-openings.use-case';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import type { BusinessHours } from '../../../location-schedule/application/business-hours';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import { InMemoryProviderScheduleRepository } from '../../../provider-schedule/application/__fixtures__/in-memory-provider-schedule.repository';
import { ChairAssignmentService } from '../chair-assignment';
import { InMemoryChairRepository } from '../../../chairs/application/__fixtures__/in-memory-chairs';

// Un martes futuro (para que "ahora" no recorte nada), en la zona de la sede (UTC−4).
function nextTuesday(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = nextTuesday();
const z = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

const HOURS: BusinessHours = {
  timezone: 'America/Caracas',
  ranges: [{ weekday: 2, startMinute: 9 * 60, endMinute: 13 * 60 }],
};

function schedule(hours: BusinessHours | null): LocationScheduleRepository {
  return {
    findByLocation: () => Promise.resolve(hours),
  } as unknown as LocationScheduleRepository;
}
const locations = {
  findById: (id: string) =>
    Promise.resolve(id === 'loc1' ? { id, timeZone: 'America/Caracas' } : null),
} as unknown as LocationRepository;
const staff = {
  findById: (id: string) =>
    Promise.resolve(
      id === 'prov1'
        ? { userId: id, role: 'DENTIST' }
        : id === 'rec1'
          ? { userId: id, role: 'RECEPTION' }
          : null,
    ),
} as unknown as StaffRepository;
const patients = {
  findById: (id: string) => Promise.resolve(id === 'p1' ? { id } : null),
} as unknown as PatientRepository;

describe('FindOpeningsUseCase (DX-122)', () => {
  function build(
    appointments = new InMemoryAppointmentRepository(),
    blocks = new InMemoryScheduleBlockRepository(),
    hours: BusinessHours | null = HOURS,
    providerSchedules = new InMemoryProviderScheduleRepository(),
    chairs = new InMemoryChairRepository(),
  ) {
    return new FindOpeningsUseCase(
      appointments,
      schedule(hours),
      blocks,
      locations,
      staff,
      patients,
      new TenantContextService(),
      inMemoryAvailability(providerSchedules),
      new ChairAssignmentService(chairs, appointments, locations),
    );
  }

  const query = {
    providerId: 'prov1',
    locationId: 'loc1',
    from: DAY,
    to: DAY,
    durationMinutes: 30,
  };

  describe('con sillón (DX-492, DX-509-ter)', () => {
    function withChairs() {
      const appointments = new InMemoryAppointmentRepository();
      const chairs = new InMemoryChairRepository();
      const one = chairs.seed({ name: 'Sillón 1' });
      const two = chairs.seed({ name: 'Sillón 2' });
      const uc = build(appointments, undefined, undefined, undefined, chairs);
      return { appointments, chairs, one, two, uc };
    }
    const iso = (d: Date) => d.toISOString();

    it('profesional libre y sillón ocupado por otro: el hueco no pisa esa cita', async () => {
      const { appointments, one, uc } = withChairs();
      appointments.seed({
        providerId: 'otro',
        chairId: one.id,
        start: z('14:00'),
        end: z('14:30'),
      });
      const view = await uc.execute({ ...query, chairIds: [one.id] });
      expect(view.openings).toEqual([
        {
          start: z('13:00'),
          end: z('14:00'),
          chair: { id: one.id, name: 'Sillón 1', active: true },
        },
        {
          start: z('14:30'),
          end: z('17:00'),
          chair: { id: one.id, name: 'Sillón 1', active: true },
        },
      ]);
    });

    it('un sobrecupo también ocupa el sillón; la cita que se mueve, no', async () => {
      const { appointments, one, uc } = withChairs();
      appointments.seed({
        providerId: 'otro',
        chairId: one.id,
        overbooked: true,
        start: z('14:00'),
        end: z('14:30'),
      });
      const moving = appointments.seed({
        providerId: 'prov1',
        chairId: one.id,
        start: z('15:00'),
        end: z('15:30'),
      });
      const view = await uc.execute({
        ...query,
        chairIds: [one.id],
        excludeAppointmentId: moving.id,
      });
      expect(view.openings.map((o) => iso(o.start))).toEqual([
        iso(z('13:00')),
        iso(z('14:30')),
      ]);
    });

    it('con varios, cada hueco lleva un sillón libre en todo él', async () => {
      const { appointments, one, two, uc } = withChairs();
      appointments.seed({
        providerId: 'otro',
        chairId: one.id,
        start: z('14:00'),
        end: z('14:30'),
      });
      const view = await uc.execute({ ...query, chairIds: [one.id, two.id] });
      expect(view.openings).toEqual([
        {
          start: z('13:00'),
          end: z('17:00'),
          chair: { id: two.id, name: 'Sillón 2', active: true },
        },
      ]);
    });

    it('sillón de otra sede o desactivado: 400; de otra clínica: 404', async () => {
      const { chairs, uc } = withChairs();
      const elsewhere = chairs.seed({ locationId: 'loc2' });
      const off = chairs.seed({ active: false });
      await expect(
        uc.execute({ ...query, chairIds: [elsewhere.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        uc.execute({ ...query, chairIds: [off.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        uc.execute({ ...query, chairIds: ['ajeno'] }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sin chairIds, los huecos no llevan sillón', async () => {
      const { one, appointments, uc } = withChairs();
      appointments.seed({
        providerId: 'otro',
        chairId: one.id,
        start: z('14:00'),
        end: z('14:30'),
      });
      const view = await uc.execute(query);
      expect(view.openings).toEqual([{ start: z('13:00'), end: z('17:00') }]);
    });
  });

  it('horario de la sede − citas del profesional − bloqueos, en la zona de la sede', async () => {
    const appointments = new InMemoryAppointmentRepository();
    appointments.seed({
      providerId: 'prov1',
      start: z('14:00'),
      end: z('14:30'),
    });
    // Una cita CANCELADA no ocupa.
    appointments.seed({
      providerId: 'prov1',
      start: z('15:00'),
      end: z('15:30'),
      status: 'CANCELLED',
    });
    const blocks = new InMemoryScheduleBlockRepository();
    blocks.seed({
      providerId: null,
      locationId: 'loc1',
      start: z('16:00'),
      end: z('16:30'),
      allowsBooking: true,
    });
    // El de otra sede no estorba.
    blocks.seed({
      providerId: null,
      locationId: 'loc2',
      start: z('13:00'),
      end: z('17:00'),
    });

    const result = await build(appointments, blocks).execute(query);
    expect(result.timeZone).toBe('America/Caracas');
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('13:00'), z('14:00')],
      [z('14:30'), z('16:00')],
      [z('16:30'), z('17:00')],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('con paciente, sus otras citas también ocupan', async () => {
    const appointments = new InMemoryAppointmentRepository();
    appointments.seed({
      providerId: 'otro',
      patientId: 'p1',
      start: z('13:00'),
      end: z('16:00'),
    });
    const result = await build(appointments).execute({
      ...query,
      patientId: 'p1',
    });
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('16:00'), z('17:00')],
    ]);
  });

  it('DX-509-bis: la cita que se mueve no tapa su propia hora (ni por profesional ni por paciente)', async () => {
    const appointments = new InMemoryAppointmentRepository();
    const moving = appointments.seed({
      providerId: 'prov1',
      patientId: 'p1',
      start: z('14:00'),
      end: z('14:30'),
    });
    const blocked = await build(appointments).execute({
      ...query,
      patientId: 'p1',
    });
    expect(blocked.openings.map((o) => [o.start, o.end])).toEqual([
      [z('13:00'), z('14:00')],
      [z('14:30'), z('17:00')],
    ]);
    const freed = await build(appointments).execute({
      ...query,
      patientId: 'p1',
      excludeAppointmentId: moving.id,
    });
    expect(freed.openings.map((o) => [o.start, o.end])).toEqual([
      [z('13:00'), z('17:00')],
    ]);
    await expect(
      build(appointments).execute({ ...query, excludeAppointmentId: 'otra' }),
    ).rejects.toThrow(new NotFoundException('Cita no encontrada'));
  });

  it('sede sin horario: propone el horario por defecto en la zona de la sede', async () => {
    const result = await build(undefined, undefined, null).execute(query);
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('13:00'), z('17:00')],
      [z('19:00'), z('23:00')],
    ]);
  });

  it('valida fechas, tope de 31 días y que todo sea de la clínica', async () => {
    const uc = build();
    await expect(uc.execute({ ...query, from: '2026-02-30' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(uc.execute({ ...query, to: '2020-01-01' })).rejects.toThrow(
      BadRequestException,
    );
    const far = new Date(Date.parse(`${DAY}T00:00:00Z`) + 31 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await expect(uc.execute({ ...query, to: far })).rejects.toThrow(/31 días/);
    await expect(uc.execute({ ...query, locationId: 'ajena' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(uc.execute({ ...query, providerId: 'ajeno' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(uc.execute({ ...query, patientId: 'ajeno' })).rejects.toThrow(
      NotFoundException,
    );
    // Recepción no atiende: no tiene huecos que buscar.
    await expect(uc.execute({ ...query, providerId: 'rec1' })).rejects.toThrow(
      BadRequestException,
    );
  });

  describe('con el horario del profesional (DX-233)', () => {
    // Martes: el profesional solo 10:00–12:00 en loc1 (la sede, 9–13).
    function withSchedule() {
      const repo = new InMemoryProviderScheduleRepository();
      repo.weekly.set('prov1', [
        { locationId: 'loc1', weekday: 2, startMinute: 600, endMinute: 720 },
        { locationId: 'loc2', weekday: 4, startMinute: 540, endMinute: 780 },
      ]);
      return repo;
    }

    it('solo propone huecos dentro de su horario en esa sede', async () => {
      const appointments = new InMemoryAppointmentRepository();
      appointments.seed({
        providerId: 'prov1',
        start: z('15:00'),
        end: z('15:30'),
      });
      const result = await build(
        appointments,
        undefined,
        HOURS,
        withSchedule(),
      ).execute(query);
      expect(result.openings.map((o) => [o.start, o.end])).toEqual([
        [z('14:00'), z('15:00')],
        [z('15:30'), z('16:00')],
      ]);
    });

    it('con una excepción «no trabaja» ese día no devuelve nada', async () => {
      const repo = withSchedule();
      repo.overrides.set('prov1', [
        { id: 'o1', locationId: 'loc1', date: DAY, ranges: [], note: null },
      ]);
      const result = await build(undefined, undefined, HOURS, repo).execute(
        query,
      );
      expect(result.openings).toEqual([]);
    });

    it('con una excepción de otro horario, los huecos de la excepción', async () => {
      const repo = withSchedule();
      repo.overrides.set('prov1', [
        {
          id: 'o1',
          locationId: 'loc1',
          date: DAY,
          ranges: [{ startMinute: 540, endMinute: 600 }],
          note: null,
        },
      ]);
      const result = await build(undefined, undefined, HOURS, repo).execute(
        query,
      );
      expect(result.openings.map((o) => [o.start, o.end])).toEqual([
        [z('13:00'), z('14:00')],
      ]);
    });

    it('sin horario configurado, exactamente como antes (regresión)', async () => {
      const plain = await build().execute(query);
      expect(plain.openings.map((o) => [o.start, o.end])).toEqual([
        [z('13:00'), z('17:00')],
      ]);
    });
  });
});
