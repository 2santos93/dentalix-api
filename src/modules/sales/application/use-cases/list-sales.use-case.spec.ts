import { ListSalesUseCase } from './list-sales.use-case';
import { InMemorySaleRepository } from './__fixtures__/in-memory-sale.repository';

describe('ListSalesUseCase', () => {
  function makeUseCase() {
    const repo = new InMemorySaleRepository();
    return { repo, uc: new ListSalesUseCase(repo) };
  }

  it('lists only active sales, ordered by paidAt DESC', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({ id: 's1', paidAt: new Date('2026-03-01T00:00:00.000Z') });
    repo.seedSale({ id: 's2', paidAt: new Date('2026-03-03T00:00:00.000Z') });
    repo.seedSale({
      id: 's3',
      paidAt: new Date('2026-03-02T00:00:00.000Z'),
      deletedAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const sales = await uc.execute();

    expect(sales.map((s) => s.id)).toEqual(['s2', 's1']);
  });

  it('filters by [from, to) range', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({ id: 's1', paidAt: new Date('2026-03-01T00:00:00.000Z') });
    repo.seedSale({ id: 's2', paidAt: new Date('2026-03-10T00:00:00.000Z') });
    repo.seedSale({ id: 's3', paidAt: new Date('2026-03-20T00:00:00.000Z') });

    const sales = await uc.execute({
      from: new Date('2026-03-05T00:00:00.000Z'),
      to: new Date('2026-03-15T00:00:00.000Z'),
    });

    expect(sales.map((s) => s.id)).toEqual(['s2']);
  });

  it('filters by patientId', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({ id: 's1', patientId: 'p1' });
    repo.seedSale({ id: 's2', patientId: 'p2' });

    const sales = await uc.execute({ patientId: 'p1' });

    expect(sales.map((s) => s.id)).toEqual(['s1']);
  });
});
