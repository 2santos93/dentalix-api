import { BadRequestException } from '@nestjs/common';
import type {
  DiscountReportQuery,
  DiscountReportRepository,
  DiscountReportRow,
  DiscountReportTotal,
} from '../../domain/ports/discount-report-repository.port';
import {
  GetDiscountReportUseCase,
  INVALID_PERIOD_MESSAGE,
  PERIOD_TOO_LONG_MESSAGE,
  UNKNOWN_LOCATION_MESSAGE,
} from './get-discount-report.use-case';

const row = (over: Partial<DiscountReportRow> = {}): DiscountReportRow => ({
  itemId: 'i1',
  planId: 'p1',
  planStatus: 'DRAFT',
  planOptionLabel: null,
  planCreatedAt: new Date('2026-10-01T15:00:00Z'),
  planCreatedOn: '2026-10-01',
  patientId: 'pa1',
  patientName: 'Ana Pérez',
  toothNumber: '11',
  procedure: 'Resina',
  currency: 'COP',
  price: 300000,
  discount: 30000,
  reason: null,
  reasonNote: null,
  discountById: 'u1',
  discountByName: 'Dra. Ruiz',
  discountAt: new Date('2026-10-02T15:00:00Z'),
  discountOn: '2026-10-02',
  locationId: 'l1',
  locationName: 'Sede principal',
  ...over,
});

class FakeRepo implements DiscountReportRepository {
  lastQuery: DiscountReportQuery | null = null;
  lastPage: { offset: number; limit: number } | undefined;
  locations = new Set(['l1']);
  totalsResult: DiscountReportTotal[] = [
    { currency: 'COP', items: 2, gross: 1000000, discount: 75000 },
    { currency: 'EUR', items: 1, gross: 3, discount: 1 },
  ];
  findLocation(id: string) {
    return Promise.resolve(
      this.locations.has(id) ? { id, name: 'Sede principal' } : null,
    );
  }
  totals(query: DiscountReportQuery) {
    this.lastQuery = query;
    return Promise.resolve(this.totalsResult);
  }
  rows(query: DiscountReportQuery, page?: { offset: number; limit: number }) {
    this.lastQuery = query;
    this.lastPage = page;
    return Promise.resolve([
      row(),
      row({ itemId: 'i2', discount: 45000, price: 700000 }),
    ]);
  }
}

describe('GetDiscountReportUseCase (DX-204)', () => {
  it('totales por moneda con el % sobre el bruto, y el % de cada ítem', async () => {
    const repo = new FakeRepo();
    const report = await new GetDiscountReportUseCase(repo).execute({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(report.totals).toEqual([
      {
        currency: 'COP',
        items: 2,
        gross: 1000000,
        discount: 75000,
        percentOfGross: 7.5,
      },
      {
        currency: 'EUR',
        items: 1,
        gross: 3,
        discount: 1,
        percentOfGross: 33.33,
      },
    ]);
    expect(report.items.map((i) => i.percent)).toEqual([10, 6.43]);
    expect(report.total).toBe(3);
    expect(report).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      page: 1,
      pageSize: 50,
    });
  });

  it('pagina y recorta pageSize al máximo', async () => {
    const repo = new FakeRepo();
    await new GetDiscountReportUseCase(repo).execute({
      from: '2026-10-01',
      to: '2026-10-31',
      page: 3,
      pageSize: 1000,
    });
    expect(repo.lastPage).toEqual({ offset: 400, limit: 200 });
  });

  it('pasa los filtros de sede y profesional y nombra la sede', async () => {
    const repo = new FakeRepo();
    const report = await new GetDiscountReportUseCase(repo).execute({
      from: '2026-10-01',
      to: '2026-10-01',
      locationId: 'l1',
      professionalId: 'u1',
    });
    expect(repo.lastQuery).toEqual({
      from: '2026-10-01',
      to: '2026-10-01',
      locationId: 'l1',
      professionalId: 'u1',
    });
    expect(report.scope).toEqual({
      location: { id: 'l1', name: 'Sede principal' },
    });
  });

  it.each([
    [{ from: '2026-10-31', to: '2026-10-01' }, INVALID_PERIOD_MESSAGE],
    [{ from: '2026-02-30', to: '2026-03-01' }, INVALID_PERIOD_MESSAGE],
    [{ from: '2025-01-01', to: '2026-01-02' }, PERIOD_TOO_LONG_MESSAGE],
    [
      { from: '2026-10-01', to: '2026-10-02', locationId: 'otra' },
      UNKNOWN_LOCATION_MESSAGE,
    ],
  ])('400 en español: %j', async (input, message) => {
    await expect(
      new GetDiscountReportUseCase(new FakeRepo()).execute(input),
    ).rejects.toThrow(new BadRequestException(message));
  });

  it('exportRows devuelve todas las filas, sin paginar', async () => {
    const repo = new FakeRepo();
    const rows = await new GetDiscountReportUseCase(repo).exportRows({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(rows).toHaveLength(2);
    expect(repo.lastPage).toBeUndefined();
  });
});
