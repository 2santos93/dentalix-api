import { ISO3166_COUNTRIES } from '../../../../../prisma/reference/iso3166';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
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
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

const AUDIT: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'admin-1', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

function makeLocation(overrides: Partial<Location> = {}): Location {
  return {
    id: 'loc-1',
    tenantId: 't1',
    name: 'Sede principal',
    address: null,
    country: 'CO',
    healthRegistrationNumber: null,
    showHealthRegistrationNumber: false,
    phone: null,
    defaultPhoneRegion: null,
    isActive: true,
    currency: 'COP',
    timeZone: 'America/Bogota',
    locale: 'es-CO',
    hourCycle: 'h23',
    regionalSettingsReviewedAt: new Date('2026-01-01'),
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
    updateRegional: () => Promise.resolve(null),
    ...over,
  };
}

/** Países de la lista de referencia (el puerto real consulta `countries`). */
const COUNTRIES = {
  has: (code: string) =>
    Promise.resolve(ISO3166_COUNTRIES.some((c) => c.code === code)),
};

/** Monedas admitidas en estos tests (el puerto real consulta `currencies`). */
const CURRENCIES = {
  has: (code: string) => Promise.resolve(['COP', 'EUR', 'JPY'].includes(code)),
};

/** Los valores regionales del alta: datos de test, no defaults. */
const TOKYO = {
  country: 'CO',
  currency: 'JPY',
  timeZone: 'Asia/Tokyo',
  locale: 'ja-JP',
  hourCycle: 'h23',
};
const NEW_YORK = {
  country: 'CO',
  currency: 'USD',
  timeZone: 'America/New_York',
  locale: 'en-US',
  hourCycle: 'h12',
};

function updateUseCase(repo: LocationRepository): UpdateLocationUseCase {
  return new UpdateLocationUseCase(repo, CURRENCIES, COUNTRIES);
}

/**
 * `updateRegional` en memoria: llama a `decide` con la sede actual y los
 * sondeos pedidos, y devuelve la sede con lo decidido aplicado.
 */
function regionalRepo(opts: {
  current?: Partial<Location>;
  openCash?: boolean;
  history?: boolean;
  written?: object[];
}): LocationRepository {
  const current = makeLocation(opts.current);
  return makeRepo({
    findById: () => Promise.resolve(current),
    updateRegional: async (_id, patch, decide) => {
      const write = await decide({
        current,
        hasOpenCashSession: () => Promise.resolve(opts.openCash ?? false),
        hasRegionalHistory: () => Promise.resolve(opts.history ?? false),
      });
      opts.written?.push(write);
      return makeLocation({
        ...current,
        ...patch,
        ...(write.currency ? { currency: write.currency } : {}),
        ...(write.timeZone ? { timeZone: write.timeZone } : {}),
        ...(write.locale ? { locale: write.locale } : {}),
        ...(write.hourCycle ? { hourCycle: write.hourCycle } : {}),
      });
    },
  });
}

function createUseCase(repo: LocationRepository): CreateLocationUseCase {
  return new CreateLocationUseCase(repo, CURRENCIES, COUNTRIES);
}

describe('CreateLocationUseCase', () => {
  it('recorta el nombre y descarta una dirección vacía', async () => {
    const created: object[] = [];
    const uc = createUseCase(
      makeRepo({
        create: (input) => {
          created.push(input);
          return Promise.resolve(makeLocation(input as Partial<Location>));
        },
      }),
    );

    await uc.execute(
      { name: '  Sede Norte  ', address: '   ', ...TOKYO },
      AUDIT,
    );

    expect(created).toEqual([
      {
        name: 'Sede Norte',
        address: undefined,
        phone: undefined,
        // DX-329: sin el campo, el alta sugiere el país (CO).
        defaultPhoneRegion: 'CO',
        ...TOKYO,
      },
    ]);
  });

  it('G1: crea con los cuatro valores canónicos (moneda en mayúsculas, locale canónico)', async () => {
    const create = jest.fn((input: Partial<Location>) =>
      Promise.resolve(makeLocation(input)),
    );
    await createUseCase(makeRepo({ create })).execute(
      {
        name: 'Tokio',
        country: 'CO',
        currency: 'jpy',
        timeZone: 'Asia/Tokyo',
        locale: 'JA-jp',
      },
      AUDIT,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'CO',
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
      }),
      AUDIT,
    );
  });

  it.each([
    ['country', 'Elige el país de la sede.'],
    ['currency', 'Elige la moneda de la sede.'],
    ['timeZone', 'Elige la zona horaria de la sede.'],
    ['locale', 'Elige el formato regional de la sede.'],
  ] as const)(
    'G1: sin %s es 400 con su mensaje y su campo, y no crea nada',
    async (field, message) => {
      const create = jest.fn();
      const input = { name: 'Sede', ...TOKYO, [field]: undefined };
      const error = await createUseCase(makeRepo({ create }))
        .execute(input, AUDIT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        message,
        field,
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('G1-B: crea con el reloj pedido (12 h y 24 h)', async () => {
    for (const regional of [NEW_YORK, TOKYO]) {
      const create = jest.fn((input: Partial<Location>) =>
        Promise.resolve(makeLocation(input)),
      );
      await createUseCase(
        makeRepo({
          create,
        }),
      ).execute({ name: 'Sede', ...regional, currency: 'EUR' }, AUDIT);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ hourCycle: regional.hourCycle }),
        AUDIT,
      );
    }
  });

  it('G1-B fase 1: sin reloj y con los otros tres (web de G1) pasa hourCycle null al repositorio, nunca un valor inventado', async () => {
    const create = jest.fn((input: Partial<Location>) =>
      Promise.resolve(makeLocation(input)),
    );
    const { hourCycle: _omitted, ...g1Body } = NEW_YORK;
    await createUseCase(makeRepo({ create })).execute(
      {
        name: 'Web G1',
        ...g1Body,
        currency: 'EUR',
      },
      AUDIT,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'en-US', hourCycle: null }),
      AUDIT,
    );
  });

  it('G1-B: un reloj inválido es 400 con su mensaje y su campo, y no crea nada', async () => {
    const create = jest.fn();
    const error = await createUseCase(makeRepo({ create }))
      .execute({ name: 'Sede', ...TOKYO, hourCycle: 'h24' }, AUDIT)
      .catch((e: unknown) => e);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
      field: 'hourCycle',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('G1: una moneda que no está en la lista es 400', async () => {
    const error = await createUseCase(makeRepo())
      .execute({ name: 'Sede', ...TOKYO, currency: 'XYZ' }, AUDIT)
      .catch((e: unknown) => e);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: 'La moneda XYZ no está en la lista de monedas admitidas.',
      field: 'currency',
    });
  });
});

describe('UpdateLocationUseCase', () => {
  it('404 si la sede no existe', async () => {
    const uc = updateUseCase(
      makeRepo({ findById: () => Promise.resolve(null) }),
    );
    await expect(uc.execute('nope', { name: 'X' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('NO deja desactivar la última sede activa', async () => {
    // Citas, pagos e inventario exigen sede: sin ninguna activa la clínica no
    // podría operar. Mismo criterio que el "último administrador".
    const uc = updateUseCase(
      makeRepo({ countActive: () => Promise.resolve(1) }),
    );

    await expect(
      uc.execute('loc-1', { isActive: false }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('sí deja desactivar una sede cuando quedan otras activas', async () => {
    const uc = updateUseCase(
      makeRepo({ countActive: () => Promise.resolve(2) }),
    );

    const { location } = await uc.execute('loc-1', { isActive: false });

    expect(location.isActive).toBe(false);
  });

  it('no aplica la protección cuando la sede YA estaba inactiva', async () => {
    // Renombrar una sede ya inactiva no debe chocar con la regla de la última
    // activa: no está quitando ninguna.
    const uc = updateUseCase(
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

describe('país de la sede (DX-312)', () => {
  it('create checks the country before the currency', async () => {
    const create = jest.fn();
    const uc = createUseCase(makeRepo({ create }));
    const error = await uc
      .execute({ name: 'X', ...TOKYO, country: 'XX', currency: 'ZZZ' }, AUDIT)
      .catch((e: unknown) => e);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      message: 'El país «XX» no está en la lista de países.',
      field: 'country',
    });
    const missing = await uc
      .execute(
        { name: 'X', ...TOKYO, country: undefined, currency: 'ZZZ' },
        AUDIT,
      )
      .catch((e: unknown) => e);
    expect((missing as BadRequestException).getResponse()).toMatchObject({
      message: 'Elige el país de la sede.',
      field: 'country',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('create stores any listed country, uppercased', async () => {
    const create = jest.fn((input: { country: string }) =>
      Promise.resolve(makeLocation({ country: input.country })),
    );
    await createUseCase(makeRepo({ create })).execute(
      {
        name: 'Caracas',
        ...TOKYO,
        country: ' ve ',
      },
      AUDIT,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'VE' }),
      AUDIT,
    );
  });

  it('update leaves the country alone when absent and rejects null', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation({ ...patch })),
    );
    const uc = updateUseCase(makeRepo({ update }));
    await uc.execute('loc-1', { name: 'Otra' });
    expect(update).toHaveBeenLastCalledWith(
      'loc-1',
      expect.objectContaining({ country: undefined }),
    );
    for (const country of [null, '', '  ']) {
      const error = await uc
        .execute('loc-1', { country })
        .catch((e: unknown) => e);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: 'Elige el país de la sede.',
        field: 'country',
      });
    }
    const unknown = await uc
      .execute('loc-1', { country: 'xx' })
      .catch((e: unknown) => e);
    expect((unknown as BadRequestException).getResponse()).toMatchObject({
      message: 'El país «XX» no está en la lista de países.',
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('país de la sede (DX-013)', () => {
  it('se crea con el país pedido', async () => {
    const create = jest.fn((input: { country: string }) =>
      Promise.resolve(makeLocation({ country: input.country })),
    );
    const uc = createUseCase(makeRepo({ create }));
    await uc.execute(
      {
        name: 'Madrid',
        country: 'ES',
        currency: 'EUR',
        timeZone: 'Europe/Madrid',
        locale: 'es-ES',
      },
      AUDIT,
    );
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ country: 'ES' }),
      AUDIT,
    );
  });

  it('se cambia al editar', async () => {
    const update = jest.fn((_id: string, patch: { country?: string }) =>
      Promise.resolve(makeLocation({ ...patch })),
    );
    const uc = updateUseCase(makeRepo({ update }));
    const { location: updated } = await uc.execute('loc-1', { country: 'ES' });
    expect(update).toHaveBeenCalledWith(
      'loc-1',
      expect.objectContaining({ country: 'ES' }),
    );
    expect(updated.country).toBe('ES');
  });
});

describe('UpdateLocationUseCase · nº de registro sanitario (DX-319)', () => {
  const updateSpy = () =>
    jest.fn((_id: string, patch: Partial<Location>) =>
      Promise.resolve(makeLocation(patch)),
    );

  it('guarda el texto recortado, sin validar formato ni país', async () => {
    const update = updateSpy();
    const uc = updateUseCase(makeRepo({ update }));
    const { location } = await uc.execute('loc-1', {
      healthRegistrationNumber: '  CS-28/1234 ',
      showHealthRegistrationNumber: true,
    });
    expect(update).toHaveBeenCalledWith(
      'loc-1',
      expect.objectContaining({
        healthRegistrationNumber: 'CS-28/1234',
        showHealthRegistrationNumber: true,
      }),
    );
    expect(location.healthRegistrationNumber).toBe('CS-28/1234');
    expect(location.showHealthRegistrationNumber).toBe(true);
  });

  it('vacío o null lo quitan; sin el campo no se toca', async () => {
    const update = updateSpy();
    const uc = updateUseCase(makeRepo({ update }));
    await uc.execute('loc-1', { healthRegistrationNumber: '   ' });
    await uc.execute('loc-1', { healthRegistrationNumber: null });
    await uc.execute('loc-1', { name: 'Otra' });
    expect(update.mock.calls.map(([, patch]) => patch)).toEqual([
      expect.objectContaining({ healthRegistrationNumber: null }),
      expect.objectContaining({ healthRegistrationNumber: null }),
      expect.objectContaining({
        healthRegistrationNumber: undefined,
        showHealthRegistrationNumber: undefined,
      }),
    ]);
  });

  it('devuelve el antes y el después para la auditoría solo si cambia', async () => {
    const before = makeLocation({ healthRegistrationNumber: '110010123401' });
    const uc = updateUseCase(
      makeRepo({
        findById: () => Promise.resolve(before),
        // Como Prisma: un campo undefined no se toca.
        update: (_id, patch) =>
          Promise.resolve(
            makeLocation({
              ...before,
              ...Object.fromEntries(
                Object.entries(patch).filter(([, v]) => v !== undefined),
              ),
            }),
          ),
      }),
    );

    const changed = await uc.execute('loc-1', {
      healthRegistrationNumber: 'NRS-7',
      showHealthRegistrationNumber: true,
    });
    expect(changed.healthRegistration).toEqual({
      before: { number: '110010123401', shown: false },
      after: { number: 'NRS-7', shown: true },
    });

    const same = await uc.execute('loc-1', {
      healthRegistrationNumber: ' 110010123401 ',
    });
    expect(same.healthRegistration).toBeNull();
    const renamed = await uc.execute('loc-1', { name: 'Sede Centro' });
    expect(renamed.healthRegistration).toBeNull();
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
    const uc = createUseCase(makeRepo({ create }));

    await uc.execute(
      { name: 'Sede Sur', phone: ' 601 222 3333 ', ...TOKYO },
      AUDIT,
    );
    await uc.execute({ name: 'Sede Este', phone: '   ', ...TOKYO }, AUDIT);

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phone: '601 222 3333' }),
      AUDIT,
    );
    expect(create.mock.calls[1][0].phone).toBeUndefined();
  });

  it('al editar se recorta, vacío o null lo quitan y sin él no se toca', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation(patch)),
    );
    const uc = updateUseCase(makeRepo({ update }));

    const { location: saved } = await uc.execute('loc-1', {
      phone: ' +57 601 555 0101 ',
    });
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

  describe('campos regionales (G1)', () => {
    const conflictCode = async (p: Promise<unknown>): Promise<string> => {
      try {
        await p;
      } catch (err) {
        const body = (err as ConflictException).getResponse() as {
          code: string;
        };
        return body.code;
      }
      return 'NO_ERROR';
    };

    it('caja abierta gana a la confirmación en moneda y en zona', async () => {
      const uc = updateUseCase(regionalRepo({ openCash: true, history: true }));
      await expect(
        conflictCode(
          uc.execute('loc-1', { currency: 'EUR', confirmRegionalChange: true }),
        ),
      ).resolves.toBe('LOCATION_REGIONAL_CASH_OPEN');
      await expect(
        conflictCode(
          uc.execute('loc-1', {
            timeZone: 'Asia/Tokyo',
            confirmRegionalChange: true,
          }),
        ),
      ).resolves.toBe('LOCATION_REGIONAL_CASH_OPEN');
    });

    it('con historial y sin confirmar pide confirmación, con el mensaje de cada campo', async () => {
      const uc = updateUseCase(regionalRepo({ history: true }));
      await expect(
        uc.execute('loc-1', { currency: 'EUR' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LOCATION_REGIONAL_CHANGE_UNCONFIRMED',
          message: expect.stringContaining('movimientos en COP') as string,
        },
      });
      await expect(
        uc.execute('loc-1', { timeZone: 'Asia/Tokyo' }),
      ).rejects.toMatchObject({
        response: {
          code: 'LOCATION_REGIONAL_CHANGE_UNCONFIRMED',
          message: expect.stringContaining(
            'Las citas conservan su hora',
          ) as string,
        },
      });
    });

    it('moneda y zona sin confirmar: un solo 409 con los dos avisos', async () => {
      const uc = updateUseCase(regionalRepo({ history: true }));
      await expect(
        uc.execute('loc-1', { currency: 'EUR', timeZone: 'Asia/Tokyo' }),
      ).rejects.toMatchObject({
        response: {
          message: expect.stringMatching(
            /movimientos en COP.*Las citas conservan su hora/,
          ) as string,
        },
      });
    });

    it('confirmado cambia la moneda, marca revisada y devuelve antes y después', async () => {
      const written: object[] = [];
      const uc = updateUseCase(regionalRepo({ history: true, written }));
      const out = await uc.execute('loc-1', {
        currency: 'jpy',
        confirmRegionalChange: true,
      });
      expect(written).toEqual([
        expect.objectContaining({ currency: 'JPY', reviewed: true }),
      ]);
      expect(out.regionalSettings).toEqual({
        before: {
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          hourCycle: 'h23',
        },
        after: {
          currency: 'JPY',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          hourCycle: 'h23',
        },
        reviewed: true,
      });
    });

    it('sin historial cambia sin confirmar; el locale nunca la pide', async () => {
      const probe = jest.fn(() => Promise.resolve(true));
      const repo = makeRepo({
        updateRegional: async (_i, _p, decide) => {
          await decide({
            current: makeLocation(),
            hasOpenCashSession: () => Promise.resolve(false),
            hasRegionalHistory: probe,
          });
          return makeLocation();
        },
      });
      const uc = updateUseCase(repo);
      await uc.execute('loc-1', { locale: 'ja-JP' });
      expect(probe).not.toHaveBeenCalled();
    });

    it('rellenar un NULL no es un cambio: ni caja ni confirmación, y queda revisada', async () => {
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({
          current: { currency: null, timeZone: null, locale: null },
          openCash: true,
          history: true,
          written,
        }),
      );
      await uc.execute('loc-1', {
        currency: 'COP',
        timeZone: 'America/Bogota',
        locale: 'es-CO',
      });
      expect(written).toEqual([
        {
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          reviewed: true,
        },
      ]);
    });

    it('confirmRegionalSettings sin cambios marca revisada y no escribe valores', async () => {
      const written: object[] = [];
      const uc = updateUseCase(regionalRepo({ written }));
      await uc.execute('loc-1', { confirmRegionalSettings: true });
      expect(written).toEqual([
        {
          currency: undefined,
          timeZone: undefined,
          locale: undefined,
          reviewed: true,
        },
      ]);
    });

    it('confirmar una sede con algún campo NULL es 400 con el primero que falta y no escribe', async () => {
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({
          written,
          current: { currency: 'COP', timeZone: null, locale: null },
        }),
      );
      await expect(
        uc.execute('loc-1', { confirmRegionalSettings: true }),
      ).rejects.toMatchObject({
        response: {
          field: 'timeZone',
          message:
            'La sede tiene que tener moneda, zona horaria, formato regional y reloj.',
        },
      });
      // Rellenando lo que falta sí se confirma.
      await uc.execute('loc-1', {
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
        confirmRegionalSettings: true,
      });
      expect(written).toEqual([
        expect.objectContaining({ timeZone: 'Asia/Tokyo', reviewed: true }),
      ]);
    });

    it('null en un campo regional es 400 con su campo', async () => {
      const uc = updateUseCase(regionalRepo({}));
      await expect(
        uc.execute('loc-1', { currency: null }),
      ).rejects.toMatchObject({
        response: {
          field: 'currency',
          message:
            'La sede tiene que tener moneda, zona horaria, formato regional y reloj.',
        },
      });
    });

    it('PATCH hourCycle needs no confirmation and is audited before/after', async () => {
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({ openCash: true, history: true, written }),
      );
      const out = await uc.execute('loc-1', { hourCycle: 'h12' });
      expect(written).toEqual([
        {
          currency: undefined,
          timeZone: undefined,
          locale: undefined,
          hourCycle: 'h12',
          reviewed: true,
        },
      ]);
      expect(out.regionalSettings).toEqual({
        before: {
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          hourCycle: 'h23',
        },
        after: {
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          hourCycle: 'h12',
        },
        reviewed: true,
      });
    });

    it('el mismo reloj no es un cambio: no marca revisada ni lo escribe', async () => {
      const written: object[] = [];
      const uc = updateUseCase(regionalRepo({ written }));
      await uc.execute('loc-1', { hourCycle: 'h23' });
      expect(written).toEqual([
        expect.objectContaining({ hourCycle: undefined, reviewed: false }),
      ]);
    });

    it('case-only zone rewrite is not reviewed nor audited as a regional change', async () => {
      // M5 (spec §7): una zona guardada antes de canonicalizar, en minúsculas.
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({
          current: { timeZone: 'asia/kolkata' },
          openCash: true,
          history: true,
          written,
        }),
      );
      const out = await uc.execute('loc-1', { timeZone: 'ASIA/KOLKATA' });
      expect(written).toEqual([
        expect.objectContaining({ timeZone: 'Asia/Kolkata', reviewed: false }),
      ]);
      expect(out.regionalSettings).toBeNull();
    });

    it('mixed PATCH audits the case-only zone rewrite as no zone change', async () => {
      // Task 5 m2: la zona guardada en minúsculas sale canónica en `before`.
      const uc = updateUseCase(
        regionalRepo({ current: { timeZone: 'asia/kolkata' } }),
      );
      const out = await uc.execute('loc-1', {
        timeZone: 'Asia/Kolkata',
        locale: 'en-IN',
      });
      expect(out.regionalSettings).toMatchObject({
        before: { timeZone: 'Asia/Kolkata', locale: 'es-CO' },
        after: { timeZone: 'Asia/Kolkata', locale: 'en-IN' },
        reviewed: true,
      });
    });

    it('a stored zone outside the IANA list is resent unchanged and other fields save', async () => {
      // G1 aceptaba toda zona que `Intl` acepta; la web la reenvía al guardar.
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({
          current: { timeZone: '+05:00' },
          history: true,
          written,
        }),
      );
      const out = await uc.execute('loc-1', {
        timeZone: '+05:00',
        locale: 'en-IN',
      });
      expect(written).toEqual([
        expect.objectContaining({
          timeZone: undefined,
          locale: 'en-IN',
          reviewed: true,
        }),
      ]);
      expect(out.regionalSettings).toMatchObject({
        before: { timeZone: '+05:00' },
        after: { timeZone: '+05:00', locale: 'en-IN' },
      });
    });

    it('a new zone outside the IANA list is still 400', async () => {
      const uc = updateUseCase(regionalRepo({}));
      await expect(
        uc.execute('loc-1', { timeZone: '+05:00' }),
      ).rejects.toMatchObject({
        response: {
          field: 'timeZone',
          message: 'La zona horaria «+05:00» no existe.',
        },
      });
    });

    it('a stored zone changed by another request before the lock is 400', async () => {
      const read = makeLocation({ timeZone: '+05:00' });
      const locked = makeLocation({ timeZone: 'Asia/Tokyo' });
      const uc = updateUseCase(
        makeRepo({
          findById: () => Promise.resolve(read),
          updateRegional: async (_id, _patch, decide) => {
            await decide({
              current: locked,
              hasOpenCashSession: () => Promise.resolve(false),
              hasRegionalHistory: () => Promise.resolve(false),
            });
            return locked;
          },
        }),
      );
      await expect(
        uc.execute('loc-1', { timeZone: '+05:00' }),
      ).rejects.toMatchObject({
        response: {
          field: 'timeZone',
          message: 'La zona horaria «+05:00» no existe.',
        },
      });
    });

    it('rellenar un reloj NULL no pide confirmación y queda revisada', async () => {
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({
          current: { hourCycle: null },
          openCash: true,
          history: true,
          written,
        }),
      );
      await uc.execute('loc-1', { hourCycle: 'h12' });
      expect(written).toEqual([
        expect.objectContaining({ hourCycle: 'h12', reviewed: true }),
      ]);
    });

    it('G1 web confirming D5 on a location without clock is 200', async () => {
      // M6: en fase 1 el reloj no entra en «revisar exige campos completos»;
      // una web de G1 no puede enviarlo y la función lo rellena.
      const written: object[] = [];
      const uc = updateUseCase(
        regionalRepo({ current: { hourCycle: null }, written }),
      );
      await uc.execute('loc-1', { confirmRegionalSettings: true });
      expect(written).toEqual([
        expect.objectContaining({ hourCycle: undefined, reviewed: true }),
      ]);
    });

    it('null o inválido en el reloj es 400 con su campo', async () => {
      const uc = updateUseCase(regionalRepo({}));
      await expect(
        uc.execute('loc-1', { hourCycle: null }),
      ).rejects.toMatchObject({
        response: {
          field: 'hourCycle',
          message:
            'La sede tiene que tener moneda, zona horaria, formato regional y reloj.',
        },
      });
      await expect(
        uc.execute('loc-1', { hourCycle: 'h24' }),
      ).rejects.toMatchObject({
        response: {
          field: 'hourCycle',
          message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
        },
      });
    });

    it('una moneda o zona inválida es 400 con el mensaje de la spec', async () => {
      const uc = updateUseCase(regionalRepo({}));
      await expect(
        uc.execute('loc-1', { currency: 'XXX' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        uc.execute('loc-1', { timeZone: 'Nope/Zone' }),
      ).rejects.toMatchObject({
        response: { message: 'La zona horaria «Nope/Zone» no existe.' },
      });
    });
  });
});

describe('prefijo telefónico de la sede (DX-329)', () => {
  const created = () => {
    const create = jest.fn((input: Partial<Location>) =>
      Promise.resolve(makeLocation(input)),
    );
    return { create, uc: createUseCase(makeRepo({ create })) };
  };

  it('create suggests the country when the field is absent, none when the library has no metadata', async () => {
    const { create, uc } = created();
    await uc.execute({ name: 'Sede', ...TOKYO, country: 've' }, AUDIT);
    await uc.execute({ name: 'Antártida', ...TOKYO, country: 'AQ' }, AUDIT);
    expect(create.mock.calls.map(([i]) => i.defaultPhoneRegion)).toEqual([
      'VE',
      null,
    ]);
  });

  it('create stores an explicit region (not the country) or null, validated', async () => {
    const { create, uc } = created();
    await uc.execute(
      {
        name: 'Sede',
        ...TOKYO,
        country: 'VE',
        defaultPhoneRegion: ' co ',
      },
      AUDIT,
    );
    await uc.execute(
      {
        name: 'Sede',
        ...TOKYO,
        country: 'VE',
        defaultPhoneRegion: null,
      },
      AUDIT,
    );
    expect(create.mock.calls.map(([i]) => i.defaultPhoneRegion)).toEqual([
      'CO',
      null,
    ]);
    const bad = await uc
      .execute({ name: 'Sede', ...TOKYO, defaultPhoneRegion: 'VEN' }, AUDIT)
      .catch((e: BadRequestException) => e);
    expect(bad).toBeInstanceOf(BadRequestException);
    expect((bad as BadRequestException).getResponse()).toMatchObject({
      field: 'defaultPhoneRegion',
      message: 'El prefijo telefónico indicado no está en la lista.',
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('update leaves the region alone when absent, also when the country changes', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation({ ...patch })),
    );
    const uc = updateUseCase(
      makeRepo({
        findById: () =>
          Promise.resolve(makeLocation({ defaultPhoneRegion: 'CO' })),
        update,
      }),
    );
    await uc.execute('loc-1', { country: 'VE' });
    expect(
      (update.mock.calls[0][1] as { defaultPhoneRegion?: unknown })
        .defaultPhoneRegion,
    ).toBeUndefined();
  });

  it.each([
    [null, null],
    ['', null],
    [' ve ', 'VE'],
  ])(
    'update with %p stores %p without touching the regional review',
    async (raw, expected) => {
      const update = jest.fn((_id: string, patch: object) =>
        Promise.resolve(makeLocation({ ...patch })),
      );
      const updateRegional = jest.fn();
      const uc = updateUseCase(makeRepo({ update, updateRegional }));
      const result = await uc.execute('loc-1', { defaultPhoneRegion: raw });
      expect(update.mock.calls[0][1]).toMatchObject({
        defaultPhoneRegion: expected,
      });
      expect(updateRegional).not.toHaveBeenCalled();
      expect(result.regionalSettings).toBeNull();
    },
  );

  it('update with an unknown region is 400 naming the field; a stored one is accepted unchanged', async () => {
    const update = jest.fn((_id: string, patch: object) =>
      Promise.resolve(makeLocation({ ...patch })),
    );
    const repo = (stored: string | null) =>
      makeRepo({
        findById: () =>
          Promise.resolve(makeLocation({ defaultPhoneRegion: stored })),
        update,
      });
    const error = await updateUseCase(repo(null))
      .execute('loc-1', { defaultPhoneRegion: 'AQ' })
      .catch((e: BadRequestException) => e);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      field: 'defaultPhoneRegion',
      message: 'El prefijo telefónico «AQ» no está en la lista.',
    });
    await updateUseCase(repo('AQ')).execute('loc-1', {
      defaultPhoneRegion: 'AQ',
    });
    expect(update.mock.calls[0][1]).toMatchObject({ defaultPhoneRegion: 'AQ' });
  });
});
