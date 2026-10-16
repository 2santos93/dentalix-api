import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CreateLocationUseCase,
  UpdateLocationUseCase,
} from './manage-locations.use-cases';
import type {
  Location,
  LocationRepository,
} from '../../domain/ports/location-repository.port';

function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: 'loc-1',
    tenantId: 't1',
    name: 'Sede principal',
    address: null,
    country: 'CO',
    isActive: true,
    timeZone: 'America/Bogota',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeRepo(over: Partial<LocationRepository> = {}): LocationRepository {
  return {
    create: (input) =>
      Promise.resolve(
        makeLocation({ name: input.name, address: input.address ?? null }),
      ),
    list: () => Promise.resolve([]),
    findById: () => Promise.resolve(makeLocation()),
    update: (_id, patch) => Promise.resolve(makeLocation({ ...patch })),
    countActive: () => Promise.resolve(2),
    hasOperations: () => Promise.resolve(false),
    ...over,
  };
}

describe('CreateLocationUseCase', () => {
  it('recorta el nombre y descarta una dirección vacía', async () => {
    const created: { name: string; address?: string }[] = [];
    const uc = new CreateLocationUseCase(
      makeRepo({
        create: (input) => {
          created.push(input);
          return Promise.resolve(makeLocation(input as Partial<Location>));
        },
      }),
    );

    await uc.execute({ name: '  Sede Norte  ', address: '   ' });

    expect(created).toEqual([{ name: 'Sede Norte', address: undefined }]);
  });
});

describe('UpdateLocationUseCase', () => {
  it('404 si la sede no existe', async () => {
    const uc = new UpdateLocationUseCase(
      makeRepo({ findById: () => Promise.resolve(null) }),
    );
    await expect(uc.execute('nope', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('NO deja desactivar la última sede activa', async () => {
    // Citas, pagos e inventario exigen sede: sin ninguna activa la clínica no
    // podría operar. Mismo criterio que el "último administrador".
    const uc = new UpdateLocationUseCase(
      makeRepo({ countActive: () => Promise.resolve(1) }),
    );

    await expect(
      uc.execute('loc-1', { isActive: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sí deja desactivar una sede cuando quedan otras activas', async () => {
    const uc = new UpdateLocationUseCase(
      makeRepo({ countActive: () => Promise.resolve(2) }),
    );

    const updated = await uc.execute('loc-1', { isActive: false });

    expect(updated.isActive).toBe(false);
  });

  it('no aplica la protección cuando la sede YA estaba inactiva', async () => {
    // Renombrar una sede ya inactiva no debe chocar con la regla de la última
    // activa: no está quitando ninguna.
    const uc = new UpdateLocationUseCase(
      makeRepo({
        findById: () => Promise.resolve(makeLocation({ isActive: false })),
        countActive: () => Promise.resolve(1),
      }),
    );

    await expect(
      uc.execute('loc-1', { isActive: false, name: 'Sede vieja' }),
    ).resolves.toBeDefined();
  });
});

describe('país de la sede (DX-013)', () => {
  it('se crea con el país pedido y por defecto CO', async () => {
    const create = jest.fn((input: { country?: 'CO' | 'ES' }) =>
      Promise.resolve(makeLocation({ country: input.country ?? 'CO' })),
    );
    const uc = new CreateLocationUseCase(makeRepo({ create }));
    await uc.execute({ name: 'Madrid', country: 'ES' });
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ country: 'ES' }),
    );
  });

  it('se cambia al editar', async () => {
    const update = jest.fn((_id: string, patch: { country?: 'CO' | 'ES' }) =>
      Promise.resolve(makeLocation({ ...patch })),
    );
    const uc = new UpdateLocationUseCase(makeRepo({ update }));
    const updated = await uc.execute('loc-1', { country: 'ES' });
    expect(update).toHaveBeenCalledWith(
      'loc-1',
      expect.objectContaining({ country: 'ES' }),
    );
    expect(updated.country).toBe('ES');
  });
});
