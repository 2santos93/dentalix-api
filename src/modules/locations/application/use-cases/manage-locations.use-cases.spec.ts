import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CreateLocationUseCase,
  ListLocationsUseCase,
  UpdateLocationUseCase,
} from './manage-locations.use-cases';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
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
    repsHabilitationCode: null,
    phone: null,
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

describe('UpdateLocationUseCase · REPS (DX-212)', () => {
  it('guarda el código de 12 dígitos sin espacios', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation(patch)),
    );
    const uc = new UpdateLocationUseCase(makeRepo({ update }));
    const result = await uc.execute('loc-1', {
      repsHabilitationCode: ' 110010123401 ',
    });
    expect(update).toHaveBeenCalledWith(
      'loc-1',
      expect.objectContaining({ repsHabilitationCode: '110010123401' }),
    );
    expect(result.repsHabilitationCode).toBe('110010123401');
  });

  it('vacío lo quita', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation(patch)),
    );
    await new UpdateLocationUseCase(makeRepo({ update })).execute('loc-1', {
      repsHabilitationCode: '',
    });
    expect(update).toHaveBeenCalledWith(
      'loc-1',
      expect.objectContaining({ repsHabilitationCode: null }),
    );
  });

  it('formato inválido: 400 con el formato esperado', async () => {
    const update = jest.fn();
    const uc = new UpdateLocationUseCase(makeRepo({ update }));
    await expect(
      uc.execute('loc-1', { repsHabilitationCode: '12345' }),
    ).rejects.toThrow(
      'El código de habilitación REPS debe tener 12 dígitos (p. ej. 110010123401)',
    );
    expect(update).not.toHaveBeenCalled();
  });
});

// DX-089: el restringido solo ve sus sedes.
describe('ListLocationsUseCase', () => {
  const tenantContext = new TenantContextService();
  const uc = new ListLocationsUseCase(
    makeRepo({
      list: () =>
        Promise.resolve([
          makeLocation({ id: 'loc-1' }),
          makeLocation({ id: 'loc-2' }),
        ]),
    }),
    tenantContext,
  );
  const ids = (locations: Location[]) => locations.map((l) => l.id);

  it('sin restricción, todas', async () => {
    expect(ids(await uc.execute())).toEqual(['loc-1', 'loc-2']);
  });

  it('con restricción, solo las permitidas (ninguna si no le queda ninguna)', async () => {
    const as = (allowed: string[]) =>
      tenantContext.run('t1', undefined, () => uc.execute(), allowed);
    expect(ids(await as(['loc-2']))).toEqual(['loc-2']);
    expect(ids(await as([]))).toEqual([]);
  });
});

describe('teléfono de la sede (DX-222)', () => {
  it('se crea con el teléfono recortado; vacío no lo guarda', async () => {
    const create = jest.fn((input: { name: string; phone?: string }) =>
      Promise.resolve(makeLocation({ name: input.name, phone: input.phone })),
    );
    const uc = new CreateLocationUseCase(makeRepo({ create }));

    await uc.execute({ name: 'Sede Sur', phone: ' 601 222 3333 ' });
    await uc.execute({ name: 'Sede Este', phone: '   ' });

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phone: '601 222 3333' }),
    );
    expect(create.mock.calls[1][0].phone).toBeUndefined();
  });

  it('al editar se recorta, vacío o null lo quitan y sin él no se toca', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation(patch)),
    );
    const uc = new UpdateLocationUseCase(makeRepo({ update }));

    const saved = await uc.execute('loc-1', { phone: ' +57 601 555 0101 ' });
    await uc.execute('loc-1', { phone: '' });
    await uc.execute('loc-1', { phone: null });
    await uc.execute('loc-1', { name: 'Otra' });

    expect(saved.phone).toBe('+57 601 555 0101');
    expect(update.mock.calls.map(([, patch]) => patch)).toEqual([
      expect.objectContaining({ phone: '+57 601 555 0101' }),
      expect.objectContaining({ phone: null }),
      expect.objectContaining({ phone: null }),
      expect.objectContaining({ phone: undefined }),
    ]);
  });
});
