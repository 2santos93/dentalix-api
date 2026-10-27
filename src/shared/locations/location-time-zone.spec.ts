import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  loadLocationTimeZones,
  locationTimeZoneRequired,
  resolveLocationTimeZones,
} from './location-time-zone';
import { resolveReferenceLocation } from './reference-location';

const TENANT = '00000000-0000-4000-8000-000000000001';

interface Row {
  id: string;
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

describe('loadLocationTimeZones (G1: solo Location.timeZone)', () => {
  it('reads Location.timeZone (Asia/Tokyo, Pacific/Auckland)', async () => {
    const zones = await loadLocationTimeZones(
      txWith([
        { id: 'tokio', timeZone: 'Asia/Tokyo' },
        { id: 'auckland', timeZone: 'Pacific/Auckland' },
      ]),
      TENANT,
    );
    expect([...zones]).toEqual([
      ['tokio', 'Asia/Tokyo'],
      ['auckland', 'Pacific/Auckland'],
    ]);
  });

  it('corrupt zone raises LOCATION_TIMEZONE_REQUIRED', async () => {
    expect(
      await conflictOf(
        loadLocationTimeZones(
          txWith([{ id: 'marte', timeZone: 'Mars/Olympus' }]),
          TENANT,
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'marte',
      message:
        'Configura una zona horaria válida para la sede y vuelve a intentarlo.',
    });
  });

  it('NULL zone is 409 LOCATION_TIMEZONE_REQUIRED, never Bogotá', async () => {
    expect(
      await conflictOf(
        loadLocationTimeZones(
          txWith([{ id: 'antigua', timeZone: null }]),
          TENANT,
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'antigua',
    });
  });

  it('sin ids pedidos no consulta nada', async () => {
    const tx = txWith([]);
    expect((await loadLocationTimeZones(tx, TENANT, [])).size).toBe(0);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('resolveLocationTimeZones', () => {
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
      timeZone: 'Pacific/Auckland',
      currency: 'NZD',
      locale: 'en-NZ',
    },
    { id: 'tokio', timeZone: 'Asia/Tokyo', currency: 'JPY', locale: 'ja-JP' },
  ];

  it('reference location is the active location or the oldest active one', async () => {
    const tx = txWith(rows);
    await expect(
      resolveReferenceLocation(tx, TENANT, 'tokio'),
    ).resolves.toEqual({
      id: 'tokio',
      timeZone: 'Asia/Tokyo',
      currency: 'JPY',
      locale: 'ja-JP',
    });
    await expect(resolveReferenceLocation(tx, TENANT, null)).resolves.toEqual({
      id: 'principal',
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
