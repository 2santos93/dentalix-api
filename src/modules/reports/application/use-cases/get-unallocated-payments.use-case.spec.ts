import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  GetUnallocatedPaymentsUseCase,
  UNALLOCATED_MAX_PAGE_SIZE,
  UNALLOCATED_PERIOD_TOO_LONG_MESSAGE,
} from './get-unallocated-payments.use-case';
import type {
  UnallocatedLocation,
  UnallocatedPaymentRow,
  UnallocatedPaymentsRepository,
} from '../../domain/ports/unallocated-payments-repository.port';

const PRINCIPAL = '11111111-1111-4111-8111-111111111111';
const NORTE = '22222222-2222-4222-8222-222222222222';

const row = (
  over: Partial<UnallocatedPaymentRow> = {},
): UnallocatedPaymentRow => ({
  paymentId: 'pay-1',
  patientId: 'pat-1',
  patientName: 'Ana Pérez',
  locationId: PRINCIPAL,
  locationName: 'Sede Principal',
  timeZone: 'America/Caracas',
  // 2026-10-21 02:30 UTC = 20/10 22:30 en Caracas (UTC−4).
  paidAt: new Date('2026-10-21T02:30:00.000Z'),
  paymentAmount: 100,
  paymentCurrency: 'USD',
  planId: 'plan-1',
  planCurrency: 'USD',
  planCents: 10000,
  allocatedCents: 7000,
  unallocatedCents: 3000,
  ...over,
});

function fakeRepo(rows: UnallocatedPaymentRow[] = [row()]) {
  const locations: UnallocatedLocation[] = [
    { id: PRINCIPAL, name: 'Sede Principal', isActive: true },
    { id: NORTE, name: 'Sede Norte', isActive: true },
  ];
  const calls = { list: [] as unknown[] };
  const repo: UnallocatedPaymentsRepository = {
    listLocations: (allowed) =>
      Promise.resolve(
        allowed === 'ALL'
          ? locations
          : locations.filter((l) => allowed.includes(l.id)),
      ),
    locationInClinic: (id) =>
      Promise.resolve(locations.some((l) => l.id === id)),
    report: (period, scope, page) => {
      calls.list.push({ period, scope, page });
      return Promise.resolve({
        rows,
        total: rows.length,
        totals:
          rows.length > 0
            ? [
                {
                  currency: 'USD',
                  count: rows.length,
                  allocatedCents: rows.reduce(
                    (n, r) => n + r.allocatedCents,
                    0,
                  ),
                  unallocatedCents: rows.reduce(
                    (n, r) => n + r.unallocatedCents,
                    0,
                  ),
                },
              ]
            : [],
        withoutRateCount: 2,
      });
    },
  };
  return { repo, calls };
}

const base = { from: '2026-10-01', to: '2026-10-31' };

describe('GetUnallocatedPaymentsUseCase (DX-399)', () => {
  it('maps a row: civil day in the payment sede zone, amounts from cents', async () => {
    const { repo } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    const page = await useCase.execute({ ...base, allowedLocationIds: 'ALL' });
    expect(page.items).toEqual([
      {
        paymentId: 'pay-1',
        patient: { id: 'pat-1', fullName: 'Ana Pérez' },
        location: { id: PRINCIPAL, name: 'Sede Principal' },
        paidOn: '2026-10-20',
        paymentAmount: 100,
        paymentCurrency: 'USD',
        planId: 'plan-1',
        planCurrency: 'USD',
        allocated: 70,
        unallocated: 30,
      },
    ]);
    expect(page.totals).toEqual([
      { currency: 'USD', count: 1, allocated: 70, unallocated: 30 },
    ]);
    expect(page.paymentsWithoutRateCount).toBe(2);
    expect(page.options.locations.map((l) => l.id)).toEqual([PRINCIPAL, NORTE]);
  });

  it('paginates with defaults and caps the page size', async () => {
    const { repo, calls } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    await useCase.execute({ ...base, allowedLocationIds: 'ALL' });
    await useCase.execute({
      ...base,
      allowedLocationIds: 'ALL',
      page: 3,
      pageSize: 10_000,
    });
    expect((calls.list[0] as { page: unknown }).page).toEqual({
      skip: 0,
      take: 25,
    });
    expect((calls.list[1] as { page: unknown }).page).toEqual({
      skip: 2 * UNALLOCATED_MAX_PAGE_SIZE,
      take: UNALLOCATED_MAX_PAGE_SIZE,
    });
  });

  it('exportAll does not paginate', async () => {
    const { repo, calls } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    await useCase.exportAll({ ...base, allowedLocationIds: 'ALL' });
    expect((calls.list[0] as { page: unknown }).page).toBeUndefined();
  });

  it('scopes to the allowed sedes of a restricted member', async () => {
    const { repo, calls } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    await useCase.execute({ ...base, allowedLocationIds: [NORTE] });
    expect((calls.list[0] as { scope: unknown }).scope).toEqual({
      locationIds: [NORTE],
    });
  });

  it('403 for a sede outside the allowed ones or outside the clinic', async () => {
    const { repo } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    await expect(
      useCase.execute({
        ...base,
        locationId: PRINCIPAL,
        allowedLocationIds: [NORTE],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      useCase.execute({
        ...base,
        locationId: '33333333-3333-4333-8333-333333333333',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('400 for an inverted, malformed or over-24-months period', async () => {
    const { repo } = fakeRepo();
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    await expect(
      useCase.execute({
        from: '2026-10-31',
        to: '2026-10-01',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      useCase.execute({
        from: '2026-02-30',
        to: '2026-03-01',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      useCase.execute({
        from: '2024-01-01',
        to: '2026-01-01',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(UNALLOCATED_PERIOD_TOO_LONG_MESSAGE);
  });

  it('a member with no sede sees an empty report', async () => {
    const { repo } = fakeRepo([]);
    const useCase = new GetUnallocatedPaymentsUseCase(repo);
    const page = await useCase.execute({ ...base, allowedLocationIds: [] });
    expect(page.items).toEqual([]);
    expect(page.options.locations).toEqual([]);
  });
});
