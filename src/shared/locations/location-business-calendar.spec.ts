import { ConflictException, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { loadLocationBusinessCalendar } from './location-business-calendar';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';

interface FakeHoliday {
  tenantId: string;
  locationId: string;
  date: Date;
  recurring: boolean;
  deletedAt: Date | null;
}

/**
 * Un `tx` de mentira que aplica los filtros que le llegan: así se prueba que
 * el cargador pide la sede del tenant y solo los festivos vivos, no solo que
 * pinta lo que le devuelven.
 */
function fakeTx(seed: {
  location?: { timeZone: string | null } | null;
  weekdays?: number[] | null;
  holidays?: FakeHoliday[];
}) {
  const location =
    seed.location === undefined ? { timeZone: 'Asia/Tokyo' } : seed.location;
  const tx = {
    location: {
      findFirst: jest.fn(
        ({ where }: { where: { id: string; tenantId: string } }) =>
          Promise.resolve(
            location && where.id === LOCATION && where.tenantId === TENANT
              ? {
                  id: LOCATION,
                  timeZone: location.timeZone,
                  workingCalendar:
                    seed.weekdays === null
                      ? null
                      : { workingWeekdays: seed.weekdays ?? [1, 2, 3, 4, 5] },
                }
              : null,
          ),
      ),
    },
    locationHoliday: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { tenantId: string; locationId: string; deletedAt: null };
        }) =>
          Promise.resolve(
            (seed.holidays ?? []).filter(
              (h) =>
                h.tenantId === where.tenantId &&
                h.locationId === where.locationId &&
                (where.deletedAt !== null || h.deletedAt === null),
            ),
          ),
      ),
    },
  };
  return tx as unknown as Prisma.TransactionClient;
}

const holiday = (
  date: string,
  recurring = false,
  deletedAt: Date | null = null,
): FakeHoliday => ({
  tenantId: TENANT,
  locationId: LOCATION,
  date: new Date(`${date}T00:00:00.000Z`),
  recurring,
  deletedAt,
});

describe('loadLocationBusinessCalendar (DX-316, spec §4.2)', () => {
  it('reads the stored weekdays, the zone and the live holidays as civil dates', async () => {
    const calendar = await loadLocationBusinessCalendar(
      fakeTx({
        weekdays: [0, 1, 2, 3, 4],
        holidays: [holiday('2027-05-09'), holiday('2000-12-31', true)],
      }),
      TENANT,
      LOCATION,
    );
    expect(calendar).toEqual({
      locationId: LOCATION,
      timeZone: 'Asia/Tokyo',
      workingWeekdays: [0, 1, 2, 3, 4],
      holidays: [
        { date: '2027-05-09', recurring: false },
        { date: '2000-12-31', recurring: true },
      ],
    });
  });

  it('loadLocationBusinessCalendar never defaults when the row is missing', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        loadLocationBusinessCalendar(
          fakeTx({ weekdays: null }),
          TENANT,
          LOCATION,
        ),
      ).rejects.toThrow(new Error('LOCATION_WORKING_CALENDAR_MISSING'));
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('a location without a zone is 409 LOCATION_TIMEZONE_REQUIRED', async () => {
    const result = loadLocationBusinessCalendar(
      fakeTx({ location: { timeZone: null } }),
      TENANT,
      LOCATION,
    );
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toMatchObject({
      response: { code: 'LOCATION_TIMEZONE_REQUIRED', locationId: LOCATION },
    });
  });

  it('a location of another tenant (or none) is the same 409', async () => {
    await expect(
      loadLocationBusinessCalendar(
        fakeTx({}),
        '33333333-3333-4333-8333-333333333333',
        LOCATION,
      ),
    ).rejects.toMatchObject({
      response: { code: 'LOCATION_TIMEZONE_REQUIRED', locationId: LOCATION },
    });
  });

  it('leaves out the retired holidays', async () => {
    const calendar = await loadLocationBusinessCalendar(
      fakeTx({
        holidays: [
          holiday('2027-05-03'),
          holiday('2027-05-04', false, new Date('2027-01-01T00:00:00Z')),
        ],
      }),
      TENANT,
      LOCATION,
    );
    expect(calendar.holidays).toEqual([
      { date: '2027-05-03', recurring: false },
    ]);
  });
});
