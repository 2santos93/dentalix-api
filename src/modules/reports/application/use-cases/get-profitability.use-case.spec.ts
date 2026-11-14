import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import { LEGACY_PREDEFINED_CATEGORY_KEYS } from '../../../expenses/domain/legacy-expense-categories';
import type { ProfitabilityLocation } from '../../domain/profitability';
import type {
  ProfitabilityLinesQuery,
  ProfitabilityRepository,
  ProfitabilitySums,
} from '../../domain/ports/profitability-repository.port';
import {
  GetProfitabilityUseCase,
  PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE,
  PROFITABILITY_INVALID_PERIOD_MESSAGE,
  PROFITABILITY_PERIOD_TOO_LONG_MESSAGE,
} from './get-profitability.use-case';

const chacao: ProfitabilityLocation = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Sede Chacao',
  isActive: true,
  timeZone: 'America/Caracas',
};
const valencia: ProfitabilityLocation = {
  id: 'a0000000-0000-4000-8000-000000000002',
  name: 'Sede Valencia',
  isActive: true,
  timeZone: 'America/Caracas',
};

class FakeRepo implements ProfitabilityRepository {
  sumsCalls: { basis: string; ids: string[] }[] = [];
  linesCalls: ProfitabilityLinesQuery[] = [];
  constructor(
    private readonly visible: ProfitabilityLocation[],
    private readonly data: ProfitabilitySums,
  ) {}
  listLocations(allowed: AllowedLocations) {
    return Promise.resolve(
      allowed === 'ALL'
        ? this.visible
        : this.visible.filter((l) => allowed.includes(l.id)),
    );
  }
  sums(
    _period: unknown,
    basis: string,
    locations: readonly ProfitabilityLocation[],
  ) {
    this.sumsCalls.push({ basis, ids: locations.map((l) => l.id) });
    return Promise.resolve(this.data);
  }
  lines(query: ProfitabilityLinesQuery) {
    this.linesCalls.push(query);
    return Promise.resolve({
      totalCents: 12_345,
      count: 1,
      lines: [
        {
          id: 'pay-1',
          date: '2026-10-05',
          locationId: chacao.id,
          amountCents: 12_345,
          concept: 'CCS-000001',
          category: null,
          method: 'Efectivo',
          paymentStatus: null,
        },
      ],
    });
  }
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

function setup(data?: Partial<ProfitabilitySums>) {
  const repo = new FakeRepo([chacao, valencia], {
    income: [
      { locationId: chacao.id, currency: 'USD', cents: 100_000, count: 4 },
      { locationId: valencia.id, currency: 'USD', cents: 50_000, count: 2 },
    ],
    expenses: [
      {
        locationId: valencia.id,
        currency: 'USD',
        category: 'Alquiler',
        cents: 80_000,
        count: 1,
      },
    ],
    ...data,
  });
  return { repo, useCase: new GetProfitabilityUseCase(repo) };
}

describe('GetProfitabilityUseCase (DX-410)', () => {
  it('una fila por sede visible y el total del grupo, con la base en la cabecera', async () => {
    const { useCase, repo } = setup();
    const r = await useCase.execute({
      ...OCTOBER,
      basis: 'CASH',
      allowedLocationIds: 'ALL',
    });
    expect(repo.sumsCalls).toEqual([
      { basis: 'CASH', ids: [chacao.id, valencia.id] },
    ]);
    expect(r).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      basis: 'CASH',
      definition: { label: 'Caja' },
      locationId: null,
      restrictedToLocations: false,
      hasActivity: true,
    });
    expect(r.locations.map((l) => [l.name, l.currencies[0].net])).toEqual([
      ['Sede Chacao', 1000],
      ['Sede Valencia', -300],
    ]);
    expect(r.total.currencies[0]).toMatchObject({
      income: 1500,
      expenses: 800,
      net: 700,
      margin: 46.7,
    });
  });

  it('un miembro restringido ve solo sus sedes, y el total solo las suma a ellas', async () => {
    const { useCase, repo } = setup();
    const r = await useCase.execute({
      ...OCTOBER,
      basis: 'ACCRUAL',
      allowedLocationIds: [chacao.id],
    });
    expect(repo.sumsCalls[0].ids).toEqual([chacao.id]);
    expect(r.restrictedToLocations).toBe(true);
    expect(r.definition.label).toBe('Devengo');
    expect(r.locations.map((l) => l.name)).toEqual(['Sede Chacao']);
    expect(r.total.currencies[0]).toMatchObject({ income: 1000, net: 1000 });
  });

  it('con `locationId`, solo esa sede; una sede ajena o no permitida es 403', async () => {
    const { useCase } = setup();
    const only = await useCase.execute({
      ...OCTOBER,
      basis: 'CASH',
      locationId: valencia.id,
      allowedLocationIds: 'ALL',
    });
    expect(only.locations.map((l) => l.locationId)).toEqual([valencia.id]);
    expect(only.locationId).toBe(valencia.id);
    await expect(
      useCase.execute({
        ...OCTOBER,
        basis: 'CASH',
        locationId: valencia.id,
        allowedLocationIds: [chacao.id],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      useCase.execute({
        ...OCTOBER,
        basis: 'CASH',
        locationId: 'b0000000-0000-4000-8000-000000000009',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin movimientos: hasActivity false y las sedes salen igual', async () => {
    const { useCase } = setup({ income: [], expenses: [] });
    const r = await useCase.execute({
      ...OCTOBER,
      basis: 'CASH',
      allowedLocationIds: 'ALL',
    });
    expect(r.hasActivity).toBe(false);
    expect(r.locations).toHaveLength(2);
    expect(r.total.currencies).toEqual([]);
  });

  it('valida el período (fechas, orden y como mucho 366 días)', async () => {
    const { useCase } = setup();
    const run = (from: string, to: string) =>
      useCase.execute({ from, to, basis: 'CASH', allowedLocationIds: 'ALL' });
    await expect(run('2026-10-31', '2026-10-01')).rejects.toThrow(
      new BadRequestException(PROFITABILITY_INVALID_PERIOD_MESSAGE),
    );
    await expect(run('2026-02-30', '2026-03-01')).rejects.toThrow(
      BadRequestException,
    );
    await expect(run('2025-01-01', '2026-01-02')).rejects.toThrow(
      new BadRequestException(PROFITABILITY_PERIOD_TOO_LONG_MESSAGE),
    );
    await expect(run('2024-01-01', '2024-12-31')).resolves.toBeDefined();
  });

  it('el detalle pasa los mismos filtros, pagina y nombra la sede de cada fila', async () => {
    const { useCase, repo } = setup();
    const r = await useCase.lines({
      ...OCTOBER,
      basis: 'CASH',
      side: 'INCOME',
      currency: 'USD',
      allowedLocationIds: 'ALL',
      page: 2,
      pageSize: 10,
    });
    expect(repo.linesCalls[0]).toMatchObject({
      period: OCTOBER,
      basis: 'CASH',
      side: 'INCOME',
      currency: 'USD',
      page: 2,
      pageSize: 10,
    });
    expect(repo.linesCalls[0].locations.map((l) => l.id)).toEqual([
      chacao.id,
      valencia.id,
    ]);
    expect(r).toMatchObject({
      total: 123.45,
      count: 1,
      page: 2,
      pageSize: 10,
      category: null,
      locationId: null,
    });
    expect(r.lines[0]).toEqual({
      id: 'pay-1',
      date: '2026-10-05',
      locationId: chacao.id,
      locationName: 'Sede Chacao',
      amount: 123.45,
      concept: 'CCS-000001',
      category: null,
      method: 'Efectivo',
      paymentStatus: null,
    });
  });

  it('el detalle: página 1 de 25 por defecto; la categoría solo vale para gastos', async () => {
    const { useCase, repo } = setup();
    await useCase.lines({
      ...OCTOBER,
      basis: 'ACCRUAL',
      side: 'EXPENSE',
      currency: 'USD',
      category: 'Alquiler',
      allowedLocationIds: 'ALL',
    });
    expect(repo.linesCalls[0]).toMatchObject({
      page: 1,
      pageSize: 25,
      category: 'Alquiler',
    });
    await expect(
      useCase.lines({
        ...OCTOBER,
        basis: 'CASH',
        side: 'INCOME',
        currency: 'USD',
        category: 'Alquiler',
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toThrow(
      new BadRequestException(PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE),
    );
  });

  it('DX-274-bis: la categoría del detalle va con la grafía canónica, también la de un nombre anterior', async () => {
    const { useCase, repo } = setup();
    const [oldRent] = [...LEGACY_PREDEFINED_CATEGORY_KEYS.keys()];
    const out = await useCase.lines({
      ...OCTOBER,
      basis: 'ACCRUAL',
      side: 'EXPENSE',
      currency: 'USD',
      category: ` ${oldRent.toUpperCase()} `,
      allowedLocationIds: 'ALL',
    });
    expect(repo.linesCalls[0]).toMatchObject({ category: 'Alquiler' });
    expect(out.category).toBe('Alquiler');
    await useCase.lines({
      ...OCTOBER,
      basis: 'ACCRUAL',
      side: 'EXPENSE',
      currency: 'USD',
      category: 'Seguros médicos',
      allowedLocationIds: 'ALL',
    });
    expect(repo.linesCalls[1]).toMatchObject({ category: 'Seguros médicos' });
  });
});
