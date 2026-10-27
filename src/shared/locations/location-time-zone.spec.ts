import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  loadLocationZones,
  loadPeriodLocationZones,
  locationTimeZoneRequired,
  resolveLocationTimeZones,
} from './location-time-zone';
import {
  loadTenantZones,
  resolveReferenceLocation,
} from './reference-location';

const TENANT = '00000000-0000-4000-8000-000000000001';

interface Row {
  id: string;
  country?: 'CO' | 'ES';
  timeZone: string | null;
  currency?: string | null;
  locale?: string | null;
}

/** `tx` mínima: `$queryRaw` devuelve las filas y `location.findFirst` busca en ellas. */
function txWith(rows: Row[]): Prisma.TransactionClient {
  return {
    $queryRaw: jest.fn(() => Promise.resolve(rows)),
    location: {
      findFirst: jest.fn(({ where }: { where: { id?: string } }) =>
        Promise.resolve(
          (where.id ? rows.find((r) => r.id === where.id) : rows[0]) ?? null,
        ),
      ),
    },
  } as unknown as Prisma.TransactionClient;
}

async function conflictOf(promise: Promise<unknown>): Promise<object> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as object;
}

describe('loadLocationZones (G1: solo Location.timeZone)', () => {
  it('reads Location.timeZone (Asia/Tokyo, Pacific/Auckland)', async () => {
    const zones = await loadLocationZones(
      txWith([
        { id: 'tokio', timeZone: 'Asia/Tokyo' },
        { id: 'auckland', timeZone: 'Pacific/Auckland' },
      ]),
      TENANT,
    );
    expect([...zones.configured]).toEqual([
      ['tokio', 'Asia/Tokyo'],
      ['auckland', 'Pacific/Auckland'],
    ]);
    expect(zones.zoneOf('auckland')).toBe('Pacific/Auckland');
  });

  it('a NULL or corrupt zone does not fail the load: it fails when used', async () => {
    const zones = await loadLocationZones(
      txWith([
        { id: 'tokio', timeZone: 'Asia/Tokyo' },
        { id: 'antigua', timeZone: null },
        { id: 'marte', timeZone: 'Mars/Olympus' },
      ]),
      TENANT,
    );
    expect([...zones.configured.keys()]).toEqual(['tokio']);
    expect(zones.unconfigured).toEqual(['antigua', 'marte']);
    for (const id of ['antigua', 'marte', 'desconocida']) {
      let caught: unknown;
      try {
        zones.zoneOf(id);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConflictException);
      expect((caught as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_TIMEZONE_REQUIRED',
        locationId: id,
        message:
          'Configura una zona horaria válida para la sede y vuelve a intentarlo.',
      });
    }
  });

  it('sin ids pedidos no consulta nada', async () => {
    const tx = txWith([]);
    const zones = await loadLocationZones(tx, TENANT, []);
    expect(zones.configured.size).toBe(0);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('loadPeriodLocationZones (vistas de período)', () => {
  const rows: Row[] = [
    { id: 'tokio', timeZone: 'Asia/Tokyo' },
    { id: 'antigua', timeZone: null },
  ];

  it('tenant-wide view ignores an unconfigured location without movements', async () => {
    const firstInUse = jest.fn(() => Promise.resolve(null));
    const zones = await loadPeriodLocationZones(
      txWith(rows),
      TENANT,
      undefined,
      firstInUse,
    );
    expect(firstInUse).toHaveBeenCalledWith(['antigua']);
    expect([...zones.configured.keys()]).toEqual(['tokio']);
  });

  it('tenant-wide view with movements at an unconfigured location is 409 LOCATION_TIMEZONE_REQUIRED', async () => {
    expect(
      await conflictOf(
        loadPeriodLocationZones(txWith(rows), TENANT, undefined, () =>
          Promise.resolve('antigua'),
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'antigua',
    });
  });

  it('a single-location view needs that location zone', async () => {
    const firstInUse = jest.fn(() => Promise.resolve(null));
    expect(
      await conflictOf(
        loadPeriodLocationZones(
          txWith([{ id: 'antigua', timeZone: null }]),
          TENANT,
          ['antigua'],
          firstInUse,
        ),
      ),
    ).toMatchObject({ locationId: 'antigua' });
    expect(firstInUse).not.toHaveBeenCalled();
  });

  it('a location of another clinic is not read: the view is empty, not 409', async () => {
    const zones = await loadPeriodLocationZones(
      txWith([]),
      TENANT,
      ['ajena'],
      () => Promise.resolve(null),
    );
    expect(zones.configured.size).toBe(0);
  });

  it('con todas las sedes configuradas no busca movimientos', async () => {
    const firstInUse = jest.fn(() => Promise.resolve(null));
    await loadPeriodLocationZones(
      txWith([{ id: 'tokio', timeZone: 'Asia/Tokyo' }]),
      TENANT,
      undefined,
      firstInUse,
    );
    expect(firstInUse).not.toHaveBeenCalled();
  });
});

describe('resolveLocationTimeZones', () => {
  it('a requested location without a valid zone is 409 at load (strict)', async () => {
    expect(
      await conflictOf(
        resolveLocationTimeZones(
          txWith([{ id: 'marte', timeZone: 'Mars/Olympus' }]),
          TENANT,
          ['marte'],
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'marte',
    });
  });

  it('unknown id raises LOCATION_TIMEZONE_REQUIRED', async () => {
    const zoneOf = await resolveLocationTimeZones(
      txWith([{ id: 'tokio', timeZone: 'Asia/Tokyo' }]),
      TENANT,
      ['tokio', 'otra'],
    );
    expect(zoneOf('tokio')).toBe('Asia/Tokyo');
    expect(() => zoneOf('otra')).toThrow(ConflictException);
    try {
      zoneOf('otra');
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_TIMEZONE_REQUIRED',
        locationId: 'otra',
      });
    }
  });
});

describe('locationTimeZoneRequired', () => {
  it('es un 409 con el id de la sede', () => {
    const error = locationTimeZoneRequired('sede-1');
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ locationId: 'sede-1' });
  });
});

describe('resolveReferenceLocation (R6)', () => {
  const rows: Row[] = [
    {
      id: 'principal',
      country: 'CO',
      timeZone: 'Pacific/Auckland',
      currency: 'NZD',
      locale: 'en-NZ',
    },
    {
      id: 'tokio',
      country: 'ES',
      timeZone: 'Asia/Tokyo',
      currency: 'JPY',
      locale: 'ja-JP',
    },
  ];

  it('reference location is the active location or the oldest active one', async () => {
    const tx = txWith(rows);
    await expect(
      resolveReferenceLocation(tx, TENANT, 'tokio'),
    ).resolves.toEqual({
      id: 'tokio',
      country: 'ES',
      timeZone: 'Asia/Tokyo',
      currency: 'JPY',
      locale: 'ja-JP',
    });
    await expect(resolveReferenceLocation(tx, TENANT, null)).resolves.toEqual({
      id: 'principal',
      country: 'CO',
      timeZone: 'Pacific/Auckland',
      currency: 'NZD',
      locale: 'en-NZ',
    });
    // Sin sede en contexto: la activa más antigua del tenant.
    const findFirst = (tx.location as unknown as { findFirst: jest.Mock })
      .findFirst;
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT, deletedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('clinic without active locations raises LOCATION_REQUIRED', async () => {
    expect(
      await conflictOf(resolveReferenceLocation(txWith([]), TENANT, null)),
    ).toMatchObject({
      code: 'LOCATION_REQUIRED',
      message:
        'La clínica no tiene ninguna sede activa. Crea una en Ajustes → Sedes.',
    });
  });

  it('la sede de referencia sin zona es 409 LOCATION_TIMEZONE_REQUIRED', async () => {
    expect(
      await conflictOf(
        resolveReferenceLocation(
          txWith([{ id: 'antigua', timeZone: null }]),
          TENANT,
          null,
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'antigua',
    });
  });
});

describe('loadTenantZones (filas de toda la clínica, con o sin sede)', () => {
  it('sin sede usa la principal; una sede sin zona solo falla si se busca', async () => {
    const zoneOf = await loadTenantZones(
      txWith([
        { id: 'principal', timeZone: 'Asia/Tokyo' },
        { id: 'antigua', timeZone: null },
      ]),
      TENANT,
    );
    expect(zoneOf(null)).toBe('Asia/Tokyo');
    expect(zoneOf('principal')).toBe('Asia/Tokyo');
    expect(() => zoneOf('antigua')).toThrow(ConflictException);
  });

  it('clínica sin sedes activas: LOCATION_REQUIRED solo para lo que no tiene sede', async () => {
    const zoneOf = await loadTenantZones(txWith([]), TENANT);
    let caught: unknown;
    try {
      zoneOf(null);
    } catch (error) {
      caught = error;
    }
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_REQUIRED',
    });
  });
});
