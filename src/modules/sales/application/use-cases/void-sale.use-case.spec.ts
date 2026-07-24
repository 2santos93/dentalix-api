import { NotFoundException } from '@nestjs/common';
import { VoidSaleUseCase } from './void-sale.use-case';
import { GetSaleUseCase } from './get-sale.use-case';
import { ListSalesUseCase } from './list-sales.use-case';
import { InMemorySaleRepository } from './__fixtures__/in-memory-sale.repository';

describe('VoidSaleUseCase', () => {
  function makeUseCase() {
    const repo = new InMemorySaleRepository();
    return {
      repo,
      uc: new VoidSaleUseCase(repo),
      getUc: new GetSaleUseCase(repo),
      listUc: new ListSalesUseCase(repo),
    };
  }

  it('soft-deletes the sale (sets deletedAt), never a hard delete', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({ id: 's1' });

    await uc.execute('s1');

    // Still physically present in the store — just marked deletedAt — same
    // "never hard delete" contract as RemoveTreatmentPlanItemUseCase.
    const stillThere = await repo.findById('s1');
    expect(stillThere).toBeNull(); // findById filters deletedAt:null too
  });

  it('excludes the voided sale from GetSale afterwards', async () => {
    const { repo, uc, getUc } = makeUseCase();
    repo.seedSale({ id: 's1' });

    await uc.execute('s1');

    await expect(getUc.execute('s1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('excludes the voided sale from ListSales afterwards', async () => {
    const { repo, uc, listUc } = makeUseCase();
    repo.seedSale({ id: 's1' });
    repo.seedSale({ id: 's2' });

    await uc.execute('s1');

    const sales = await listUc.execute();
    expect(sales.map((s) => s.id)).toEqual(['s2']);
  });

  it('throws NotFoundException when the sale does not exist', async () => {
    const { uc } = makeUseCase();

    await expect(uc.execute('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
