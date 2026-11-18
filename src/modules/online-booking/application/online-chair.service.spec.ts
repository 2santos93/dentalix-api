import { ConflictException } from '@nestjs/common';
import type { AppointmentRepository } from '../../appointments/domain/ports/appointment-repository.port';
import type { ChairRepository } from '../../chairs/domain/ports/chair-repository.port';
import { OnlineChairService } from './online-chair.service';

const slot = {
  locationId: 'loc-1',
  start: new Date('2026-11-23T13:00:00Z'),
  end: new Date('2026-11-23T13:30:00Z'),
};

/** Sillones activos `ids` (orden de agenda) y los ocupados en `busy`. */
function service(ids: string[], busy: Set<string>) {
  const chairs = {
    listByLocation: jest.fn(() => Promise.resolve(ids.map((id) => ({ id })))),
  } as unknown as ChairRepository;
  const appointments = {
    findOverlappingForChair: jest.fn((chairId: string) =>
      Promise.resolve(
        busy.has(chairId) ? [{ start: slot.start, end: slot.end }] : [],
      ),
    ),
  } as unknown as AppointmentRepository;
  return new OnlineChairService(chairs, appointments);
}

const noFree = () => new ConflictException('sin sillón');

describe('OnlineChairService (DX-583, regla DX-480)', () => {
  it('sede sin sillones: la cita va sin sillón, como antes', async () => {
    const create = jest.fn((chairId: string | undefined) =>
      Promise.resolve(chairId),
    );
    await expect(
      service([], new Set()).withFreeChair(slot, create, noFree),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledWith(undefined);
  });

  it('elige el primer sillón libre en el orden de la agenda', async () => {
    const create = jest.fn((chairId: string | undefined) =>
      Promise.resolve(chairId),
    );
    await expect(
      service(['c1', 'c2', 'c3'], new Set(['c1'])).withFreeChair(
        slot,
        create,
        noFree,
      ),
    ).resolves.toBe('c2');
  });

  it('todos ocupados: no crea nada y responde «sin sillón libre»', async () => {
    const create = jest.fn();
    await expect(
      service(['c1'], new Set(['c1'])).withFreeChair(slot, create, noFree),
    ).rejects.toThrow('sin sillón');
    expect(create).not.toHaveBeenCalled();
  });

  it('carrera por el sillón: si otra cita lo ganó, reintenta con el siguiente libre', async () => {
    const busy = new Set<string>();
    const create = jest.fn((chairId: string | undefined) => {
      if (chairId === 'c1') {
        busy.add('c1'); // la otra reserva lo escribió a la vez
        return Promise.reject(
          new ConflictException('El sillón «1» ya está ocupado'),
        );
      }
      return Promise.resolve(chairId);
    });
    await expect(
      service(['c1', 'c2'], busy).withFreeChair(slot, create, noFree),
    ).resolves.toBe('c2');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('carrera con un solo sillón: «sin sillón libre», sin segundo intento', async () => {
    const busy = new Set<string>();
    const create = jest.fn(() => {
      busy.add('c1');
      return Promise.reject(
        new ConflictException('El sillón «1» ya está ocupado'),
      );
    });
    await expect(
      service(['c1'], busy).withFreeChair(slot, create, noFree),
    ).rejects.toThrow('sin sillón');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('un 409 que no es del sillón (el sillón sigue libre) se relanza tal cual', async () => {
    const error = new ConflictException('Solape del profesional');
    const create = jest.fn(() => Promise.reject(error));
    await expect(
      service(['c1', 'c2'], new Set()).withFreeChair(slot, create, noFree),
    ).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('otros errores no se reintentan', async () => {
    const create = jest.fn(() => Promise.reject(new Error('boom')));
    await expect(
      service(['c1', 'c2'], new Set()).withFreeChair(slot, create, noFree),
    ).rejects.toThrow('boom');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
