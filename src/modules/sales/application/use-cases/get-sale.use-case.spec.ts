import { NotFoundException } from '@nestjs/common';
import { GetSaleUseCase } from './get-sale.use-case';
import { InMemorySaleRepository } from './__fixtures__/in-memory-sale.repository';

describe('GetSaleUseCase', () => {
  function makeUseCase() {
    const repo = new InMemorySaleRepository();
    return { repo, uc: new GetSaleUseCase(repo) };
  }

  it('returns the sale with its line items', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({ id: 's1', total: 130 }, [
      { description: 'Cleaning', unitPrice: 100, quantity: 1, amount: 100 },
      { description: 'X-ray', unitPrice: 30, quantity: 1, amount: 30 },
    ]);

    const sale = await uc.execute('s1');

    expect(sale.id).toBe('s1');
    expect(sale.total).toBe(130);
    expect(sale.lineItems).toHaveLength(2);
  });

  it('throws NotFoundException when the sale does not exist', async () => {
    const { uc } = makeUseCase();

    await expect(uc.execute('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the sale is soft-deleted', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({
      id: 's1',
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await expect(uc.execute('s1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
