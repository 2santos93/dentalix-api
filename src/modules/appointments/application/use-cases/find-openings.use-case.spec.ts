import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FindOpeningsUseCase } from './find-openings.use-case';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import type { BusinessHours } from '../../../location-schedule/application/business-hours';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';

// Un martes futuro (para que "ahora" no recorte nada), en Bogotá (UTC−5).
function nextTuesday(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const DAY = nextTuesday();
const z = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

const HOURS: BusinessHours = {
  timezone: 'America/Bogota',
  ranges: [{ weekday: 2, startMinute: 9 * 60, endMinute: 13 * 60 }],
};

function schedule(hours: BusinessHours | null): LocationScheduleRepository {
  return {
    findByLocation: () => Promise.resolve(hours),
  } as unknown as LocationScheduleRepository;
}
const locations = {
  findById: (id: string) =>
    Promise.resolve(id === 'loc1' ? { id, timeZone: 'America/Bogota' } : null),
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
  ) {
    return new FindOpeningsUseCase(
      appointments,
      schedule(hours),
      blocks,
      locations,
      staff,
      patients,
    );
  }

  const query = {
    providerId: 'prov1',
    locationId: 'loc1',
    from: DAY,
    to: DAY,
    durationMinutes: 30,
  };

  it('horario de la sede − citas del profesional − bloqueos, en la zona de la sede', async () => {
    const appointments = new InMemoryAppointmentRepository();
    appointments.seed({
      providerId: 'prov1',
      start: z('15:00'),
      end: z('15:30'),
    });
    // Una cita CANCELADA no ocupa.
    appointments.seed({
      providerId: 'prov1',
      start: z('16:00'),
      end: z('16:30'),
      status: 'CANCELLED',
    });
    const blocks = new InMemoryScheduleBlockRepository();
    blocks.seed({
      providerId: null,
      locationId: 'loc1',
      start: z('17:00'),
      end: z('17:30'),
      allowsBooking: true,
    });
    // El de otra sede no estorba.
    blocks.seed({
      providerId: null,
      locationId: 'loc2',
      start: z('14:00'),
      end: z('18:00'),
    });

    const result = await build(appointments, blocks).execute(query);
    expect(result.timeZone).toBe('America/Bogota');
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('14:00'), z('15:00')],
      [z('15:30'), z('17:00')],
      [z('17:30'), z('18:00')],
    ]);
    expect(result.truncated).toBe(false);
  });

  it('con paciente, sus otras citas también ocupan', async () => {
    const appointments = new InMemoryAppointmentRepository();
    appointments.seed({
      providerId: 'otro',
      patientId: 'p1',
      start: z('14:00'),
      end: z('17:00'),
    });
    const result = await build(appointments).execute({
      ...query,
      patientId: 'p1',
    });
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('17:00'), z('18:00')],
    ]);
  });

  it('sede sin horario: propone el horario por defecto en la zona de la sede', async () => {
    const result = await build(undefined, undefined, null).execute(query);
    expect(result.openings.map((o) => [o.start, o.end])).toEqual([
      [z('14:00'), z('18:00')],
      [
        z('20:00'),
        new Date(new Date(`${DAY}T00:00:00.000Z`).getTime() + 86_400_000),
      ],
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
});
