import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { ChairAssignmentService } from './chair-assignment';
import { InMemoryAppointmentRepository } from './use-cases/__fixtures__/in-memory-appointment.repository';
import { InMemoryChairRepository } from '../../chairs/application/__fixtures__/in-memory-chairs';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';

const locations = {
  findById: (id: string) =>
    Promise.resolve({
      id,
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      hourCycle: 'h23',
    }),
} as unknown as LocationRepository;

const START = new Date('2031-03-03T15:00:00.000Z'); // 10:00 en Bogotá
const END = new Date('2031-03-03T15:30:00.000Z');

describe('sillón de una cita (DX-211)', () => {
  let appointments: InMemoryAppointmentRepository;
  let chairs: InMemoryChairRepository;
  let service: ChairAssignmentService;

  beforeEach(() => {
    appointments = new InMemoryAppointmentRepository();
    chairs = new InMemoryChairRepository();
    service = new ChairAssignmentService(chairs, appointments, locations);
  });

  it('devuelve el sillón activo de la sede de la cita', async () => {
    const chair = chairs.seed({ locationId: 'norte' });
    await expect(
      service.load(chair.id, { locationId: 'norte', requireActive: true }),
    ).resolves.toMatchObject({ id: chair.id });
  });

  it('otra clínica o inexistente: 404; otra sede o desactivado: 400', async () => {
    await expect(
      service.load('ajeno', { locationId: 'norte', requireActive: true }),
    ).rejects.toThrow(new NotFoundException('Sillón no encontrado'));
    const sur = chairs.seed({ locationId: 'sur', name: 'Sillón Sur' });
    await expect(
      service.load(sur.id, { locationId: 'norte', requireActive: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const off = chairs.seed({ locationId: 'norte', active: false });
    await expect(
      service.load(off.id, { locationId: 'norte', requireActive: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ocupado en la franja: 409 con el nombre y las horas de la sede', async () => {
    const chair = chairs.seed({ locationId: 'norte', name: 'Sillón 2' });
    appointments.seed({
      chairId: chair.id,
      providerId: 'otra-dra',
      start: START,
      end: END,
    });
    await expect(
      service.assertFree(chair, {
        locationId: 'norte',
        start: new Date('2031-03-03T15:15:00.000Z'),
        end: new Date('2031-03-03T15:45:00.000Z'),
      }),
    ).rejects.toThrow(
      new ConflictException(
        'El sillón «Sillón 2» ya está ocupado de 10:00 a 10:30',
      ),
    );
  });

  it('contigua, cancelada o la propia cita no ocupan el sillón', async () => {
    const chair = chairs.seed({ locationId: 'norte' });
    const own = appointments.seed({
      chairId: chair.id,
      start: START,
      end: END,
    });
    appointments.seed({
      chairId: chair.id,
      start: END,
      end: new Date('2031-03-03T16:00:00.000Z'),
    });
    appointments.seed({
      chairId: chair.id,
      start: START,
      end: END,
      status: AppointmentStatus.CANCELLED,
    });
    await expect(
      service.assertFree(chair, {
        locationId: 'norte',
        start: START,
        end: END,
        excludeId: own.id,
      }),
    ).resolves.toBeUndefined();
  });

  it('el 409 de la carrera (la BD) busca la cita que ocupa el sillón para dar sus horas', async () => {
    const chair = chairs.seed({ locationId: 'norte', name: 'Sillón 1' });
    await expect(
      service.raceConflict(chair.id, { start: START, end: END }),
    ).resolves.toEqual(
      new ConflictException(
        'El sillón «Sillón 1» ya está ocupado en ese horario',
      ),
    );
    appointments.seed({ chairId: chair.id, start: START, end: END });
    await expect(
      service.raceConflict(chair.id, { start: START, end: END }),
    ).resolves.toEqual(
      new ConflictException(
        'El sillón «Sillón 1» ya está ocupado de 10:00 a 10:30',
      ),
    );
  });
});
