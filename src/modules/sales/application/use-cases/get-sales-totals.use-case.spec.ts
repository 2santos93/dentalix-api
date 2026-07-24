import { GetSalesTotalsUseCase } from './get-sales-totals.use-case';
import { VoidSaleUseCase } from './void-sale.use-case';
import { InMemorySaleRepository } from './__fixtures__/in-memory-sale.repository';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

interface FakeConvertInput {
  amount: number;
  from: string;
  to: string;
  date: string;
}

/**
 * Deterministic fake for `ConvertAmountUseCase`: fixed COP<->USD rate (1
 * USD = 4000 COP), same-currency passthrough (mirrors the real use case's
 * `from === to` short-circuit). Records every call so specs can assert
 * per-sale-date conversion (the whole point of `GetSalesTotalsUseCase`:
 * convert each sale by ITS OWN paidAt date, not "today").
 *
 * `ConvertAmountUseCase` is a concrete class (constructed with
 * `getRatesForDate`, a private field), not an interface port — so a plain
 * object literal isn't structurally assignable to it. Cast via
 * `as unknown as ConvertAmountUseCase` at the injection site, same pattern
 * used elsewhere in this codebase for faking concrete class dependencies.
 */
class FakeConvertAmountUseCase {
  public readonly calls: FakeConvertInput[] = [];

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);

    if (input.from === input.to) {
      return Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
    }
    if (input.from === 'COP' && input.to === 'USD') {
      const result = Math.round((input.amount / 4000) * 100) / 100;
      return Promise.resolve({ ...input, result, rateUsed: 1 / 4000 });
    }
    throw new Error(
      `unsupported conversion in fake: ${input.from}->${input.to}`,
    );
  }
}

describe('GetSalesTotalsUseCase', () => {
  function makeUseCase() {
    const repo = new InMemorySaleRepository();
    const fakeConvert = new FakeConvertAmountUseCase();
    const uc = new GetSalesTotalsUseCase(
      repo,
      fakeConvert as unknown as ConvertAmountUseCase,
    );
    return { repo, fakeConvert, uc };
  }

  it('converts each sale by its own paidAt date and sums the results', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    repo.seedSale({
      id: 's-cop',
      currency: 'COP',
      total: 400000,
      paidAt: new Date('2026-03-05T12:00:00.000Z'),
    });
    repo.seedSale({
      id: 's-usd',
      currency: 'USD',
      total: 30,
      paidAt: new Date('2026-03-10T08:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'USD',
    });

    // 400000 COP / 4000 = 100 USD, plus 30 USD passthrough = 130.
    expect(result.totalConverted).toBe(130);
    expect(result.count).toBe(2);
    expect(result.currency).toBe('USD');

    // Original (unconverted) totals grouped by the sale's OWN currency.
    expect(result.byCurrency).toEqual({ COP: 400000, USD: 30 });

    // Each sale is converted using ITS OWN paidAt date — not today's date.
    expect(fakeConvert.calls).toEqual([
      { amount: 400000, from: 'COP', to: 'USD', date: '2026-03-05' },
      { amount: 30, from: 'USD', to: 'USD', date: '2026-03-10' },
    ]);
  });

  it('excludes a voided sale from the totals', async () => {
    const { repo, uc } = makeUseCase();
    const voidUc = new VoidSaleUseCase(repo);
    repo.seedSale({
      id: 's1',
      currency: 'USD',
      total: 100,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedSale({
      id: 's2',
      currency: 'USD',
      total: 50,
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    await voidUc.execute('s1');

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'USD',
    });

    expect(result.count).toBe(1);
    expect(result.totalConverted).toBe(50);
    expect(result.byCurrency).toEqual({ USD: 50 });
  });

  it('returns zeroed totals for an empty range', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({
      id: 's1',
      currency: 'USD',
      total: 100,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2027-01-01T00:00:00.000Z'),
      to: new Date('2027-02-01T00:00:00.000Z'),
      currency: 'USD',
    });

    expect(result.totalConverted).toBe(0);
    expect(result.count).toBe(0);
    expect(result.byCurrency).toEqual({});
  });

  it('uppercase-normalizes the target currency', async () => {
    const { repo, uc } = makeUseCase();
    repo.seedSale({
      id: 's1',
      currency: 'USD',
      total: 10,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'usd',
    });

    expect(result.currency).toBe('USD');
  });
});
