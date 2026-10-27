import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  locationLocaleRequired,
  requireLocationFormat,
  resolveLocationRegional,
} from './location-regional';

const TENANT = '00000000-0000-4000-8000-000000000001';

interface Row {
  id: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: string | null;
}

/** `tx` mínima: `$queryRaw` devuelve las filas. */
function txWith(rows: Row[]): Prisma.TransactionClient {
  return {
    $queryRaw: jest.fn(() => Promise.resolve(rows)),
  } as unknown as Prisma.TransactionClient;
}

function conflictOf(run: () => unknown): object {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConflictException);
  return (caught as ConflictException).getResponse() as object;
}

async function asyncConflictOf(promise: Promise<unknown>): Promise<object> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as object;
}

const NEW_YORK: Row = {
  id: 'nueva-york',
  timeZone: 'America/New_York',
  locale: 'en-US',
  hourCycle: 'h12',
};
const BERLIN: Row = {
  id: 'berlin',
  timeZone: 'Europe/Berlin',
  locale: 'de-DE',
  hourCycle: 'h23',
};

describe('locationLocaleRequired (G1-B, spec §10)', () => {
  it('is the 409 LOCATION_LOCALE_REQUIRED with the location id', () => {
    expect(locationLocaleRequired('sede-1').getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'LOCATION_LOCALE_REQUIRED',
      message:
        'Configura el formato regional y el reloj de la sede y vuelve a intentarlo.',
      locationId: 'sede-1',
    });
  });
});

describe('requireLocationFormat (perezoso: lo llama quien formatea)', () => {
  it('returns the format with the location locale and hourCycle', () => {
    const fmt = requireLocationFormat(NEW_YORK);
    expect(fmt).toMatchObject({ locale: 'en-US', hourCycle: 'h12' });
    expect(fmt.clock(15, 5)).toBe('3:05 p. m.');
    expect(requireLocationFormat(BERLIN).clock(15, 5)).toBe('15:05');
  });

  it.each([
    ['NULL hourCycle', { ...BERLIN, hourCycle: null }],
    ['NULL locale', { ...BERLIN, locale: null }],
    ['unsupported locale', { ...BERLIN, locale: 'zz-ZZ-not-a-tag-!!' }],
    ['invalid hourCycle', { ...BERLIN, hourCycle: 'h11' }],
  ])('%s is 409 LOCATION_LOCALE_REQUIRED', (_label, row) => {
    expect(conflictOf(() => requireLocationFormat(row))).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
      locationId: 'berlin',
    });
  });
});

describe('resolveLocationRegional (estricto, la zona primero)', () => {
  it('returns fmt with the location hourCycle', async () => {
    const regionalOf = await resolveLocationRegional(
      txWith([NEW_YORK, BERLIN]),
      TENANT,
      ['nueva-york', 'berlin'],
    );
    const ny = regionalOf('nueva-york');
    expect(ny.timeZone).toBe('America/New_York');
    expect(ny.fmt).toMatchObject({ locale: 'en-US', hourCycle: 'h12' });
    const at = new Date('2026-10-27T19:05:00.000Z');
    expect(ny.fmt.time(at, ny.timeZone)).toBe('3:05 p. m.');
    const berlin = regionalOf('berlin');
    expect(berlin.fmt.time(at, berlin.timeZone)).toBe('20:05');
  });

  it('throws LOCATION_LOCALE_REQUIRED for a NULL hourCycle or locale, after the zone check', async () => {
    for (const row of [
      { ...BERLIN, hourCycle: null },
      { ...BERLIN, locale: null },
    ]) {
      expect(
        await asyncConflictOf(
          resolveLocationRegional(txWith([NEW_YORK, row]), TENANT, [
            'nueva-york',
            'berlin',
          ]),
        ),
      ).toMatchObject({
        code: 'LOCATION_LOCALE_REQUIRED',
        locationId: 'berlin',
      });
    }
  });

  it('NULL zone wins over NULL format', async () => {
    // Una sede sin formato y OTRA sin zona: gana el 409 de zona.
    const noFormat = { ...NEW_YORK, locale: null, hourCycle: null };
    const noZone = { ...BERLIN, timeZone: null };
    expect(
      await asyncConflictOf(
        resolveLocationRegional(txWith([noFormat, noZone]), TENANT, [
          'nueva-york',
          'berlin',
        ]),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'berlin',
    });
    // Y en la misma sede.
    expect(
      await asyncConflictOf(
        resolveLocationRegional(
          txWith([{ ...noZone, hourCycle: null }]),
          TENANT,
          ['berlin'],
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'berlin',
    });
  });

  it('a location that was not read is LOCATION_TIMEZONE_REQUIRED on lookup', async () => {
    const regionalOf = await resolveLocationRegional(txWith([BERLIN]), TENANT, [
      'berlin',
    ]);
    expect(conflictOf(() => regionalOf('otra'))).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
      locationId: 'otra',
    });
  });

  it('no ids reads nothing', async () => {
    const tx = txWith([]);
    await resolveLocationRegional(tx, TENANT, []);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
