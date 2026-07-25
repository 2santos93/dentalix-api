import { GetPaymentsTotalsUseCase } from './get-payments-totals.use-case';
import { VoidPaymentUseCase } from './void-payment.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';

interface FakeConvertInput {
  amount: number;
  from: string;
  to: string;
  date: string;
}

/**
 * Deterministic fake for `ConvertAmountUseCase` -- mirrors
 * sales/get-sales-totals.use-case.spec.ts's FakeConvertAmountUseCase
 * (fixed COP<->USD rate, same-currency passthrough, records every call).
 */
class FakeConvertAmountUseCase {
  public readonly calls: FakeConvertInput[] = [];
  /** Currencies (as `from`) that should make `execute` reject, simulating a
   * stored payment with an unconvertible currency (IMP-4b). */
  public readonly failingFrom = new Set<string>();

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);

    if (this.failingFrom.has(input.from)) {
      return Promise.reject(
        new Error(`unsupported currency in fake: ${input.from}`),
      );
    }
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

describe('GetPaymentsTotalsUseCase', () => {
  function makeUseCase() {
    const repo = new InMemoryPaymentRepository();
    const fakeConvert = new FakeConvertAmountUseCase();
    const uc = new GetPaymentsTotalsUseCase(
      repo,
      fakeConvert as unknown as ConvertAmountUseCase,
    );
    return { repo, fakeConvert, uc };
  }

  it('converts each payment by its own paidAt date and sums the results', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    repo.seedPayment({
      id: 'p-cop',
      currency: 'COP',
      amount: 400000,
      paidAt: new Date('2026-03-05T12:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p-usd',
      currency: 'USD',
      amount: 30,
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
    expect(result.byCurrency).toEqual({ COP: 400000, USD: 30 });

    expect(fakeConvert.calls).toEqual([
      { amount: 400000, from: 'COP', to: 'USD', date: '2026-03-05' },
      { amount: 30, from: 'USD', to: 'USD', date: '2026-03-10' },
    ]);
  });

  it('excludes a voided payment from the totals', async () => {
    const { repo, uc } = makeUseCase();
    const voidUc = new VoidPaymentUseCase(repo);
    repo.seedPayment({
      id: 'p1',
      currency: 'USD',
      amount: 100,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p2',
      currency: 'USD',
      amount: 50,
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    await voidUc.execute('p1');

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
    repo.seedPayment({
      id: 'p1',
      currency: 'USD',
      amount: 100,
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
    repo.seedPayment({
      id: 'p1',
      currency: 'USD',
      amount: 10,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'usd',
    });

    expect(result.currency).toBe('USD');
  });

  // IMP-4a: memoize per (date, source currency) within a single execute()
  // call so N payments sharing a date/currency don't each re-hit the
  // exchange-rate lookup inside convertAmount.execute().
  it('memoizes the conversion lookup per distinct date, converting each payment by its own amount', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    repo.seedPayment({
      id: 'p1',
      currency: 'COP',
      amount: 400000,
      paidAt: new Date('2026-03-05T09:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p2',
      currency: 'COP',
      amount: 200000,
      paidAt: new Date('2026-03-05T18:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p3',
      currency: 'COP',
      amount: 40000,
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'USD',
    });

    // 400000/4000 + 200000/4000 + 40000/4000 = 100 + 50 + 10 = 160.
    expect(result.totalConverted).toBe(160);
    expect(result.count).toBe(3);
    // Only 2 distinct dates were looked up (03-05 once, reused for p1+p2;
    // 03-06 once for p3) even though there are 3 payments.
    expect(fakeConvert.calls).toHaveLength(2);
    expect(fakeConvert.calls.map((c) => c.date)).toEqual([
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  // IMP-4b: one payment with an unconvertible currency must not throw and
  // fail the whole totals computation -- it should be skipped instead.
  it('skips a payment whose currency conversion fails, keeping the rest of the total', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    fakeConvert.failingFrom.add('ZZZ');
    repo.seedPayment({
      id: 'p-good',
      currency: 'USD',
      amount: 100,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });
    repo.seedPayment({
      id: 'p-bad',
      currency: 'ZZZ',
      amount: 999,
      paidAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'USD',
    });

    expect(result.totalConverted).toBe(100);
    // `count` and `byCurrency` are unaffected by conversion failures --
    // they reflect what was actually received, not what could be converted.
    expect(result.count).toBe(2);
    expect(result.byCurrency).toEqual({ USD: 100, ZZZ: 999 });
  });
});
