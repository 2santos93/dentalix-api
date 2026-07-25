import { BadRequestException } from '@nestjs/common';
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Deterministic fake for `ConvertAmountUseCase` -- mirrors
 * sales/get-sales-totals.use-case.spec.ts's FakeConvertAmountUseCase
 * (fixed rates per source currency, same-currency passthrough, records every
 * call).
 *
 * IMP-4a regression: the REAL `ConvertAmountUseCase.rateUsed` is
 * amount-dependent -- `rateUsed = round2(amount * rate) / amount` -- because
 * it's derived from the ALREADY-ROUNDED result of THAT specific amount, not
 * a fixed exchange rate. A fake that returns a constant `rateUsed` can never
 * expose a bug where the use case reuses one payment's `rateUsed` for a
 * different payment's amount, so this fake reproduces the real per-amount
 * rounding behavior instead.
 */
class FakeConvertAmountUseCase {
  public readonly calls: FakeConvertInput[] = [];
  /** Currencies (as `from`) that should make `execute` reject with the same
   * `BadRequestException` shape `ConvertAmountUseCase` throws for an
   * unsupported currency (IMP-4b). */
  public readonly failingFrom = new Set<string>();
  /** Currencies (as `from`) that should make `execute` reject with a
   * generic, non-currency error -- simulates an infra/DB failure that must
   * PROPAGATE rather than be swallowed as a skipped payment. */
  public readonly infraFailingFrom = new Set<string>();
  /** units of `from` currency per 1 USD-equivalent `to`; mirrors
   * `rates[from]` in the real use case. */
  private readonly unitsPerTarget: Record<string, number> = { COP: 4000 };

  /** Test helper: register a fixed rate for a currency pair (units of
   * `from` per 1 unit of `to`), used by the mixed-amount regression test. */
  setRate(from: string, unitsPerTo: number): void {
    this.unitsPerTarget[from] = unitsPerTo;
  }

  execute(input: FakeConvertInput): Promise<{
    amount: number;
    from: string;
    to: string;
    date: string;
    result: number;
    rateUsed: number;
  }> {
    this.calls.push(input);

    if (this.infraFailingFrom.has(input.from)) {
      return Promise.reject(
        new Error(`simulated infra failure converting ${input.from}`),
      );
    }
    if (this.failingFrom.has(input.from)) {
      return Promise.reject(
        new BadRequestException(`unsupported currency: ${input.from}`),
      );
    }
    if (input.from === input.to) {
      return Promise.resolve({ ...input, result: input.amount, rateUsed: 1 });
    }
    const unitsPerTo = this.unitsPerTarget[input.from];
    if (unitsPerTo === undefined) {
      throw new Error(
        `unsupported conversion in fake: ${input.from}->${input.to}`,
      );
    }
    const result = round2(input.amount / unitsPerTo);
    const rateUsed = input.amount !== 0 ? result / input.amount : 1 / unitsPerTo;
    return Promise.resolve({ ...input, result, rateUsed });
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

  // IMP-4a follow-up: each payment is converted FRESH (own amount, own
  // paidAt date) -- NOT memoized/reused from another payment sharing the
  // same date+currency. Reusing a `rateUsed` computed for one amount against
  // a different amount drifts the total (see the regression test below);
  // the only way to see that this use case is a genuinely fresh-per-payment
  // conversion is a distinct convertAmount.execute() call per payment.
  it('converts each payment independently, even when several share the same date and currency', async () => {
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
    // One convertAmount.execute() call PER PAYMENT -- no memoization/reuse
    // across payments sharing a date+currency.
    expect(fakeConvert.calls).toHaveLength(3);
    expect(fakeConvert.calls.map((c) => c.date)).toEqual([
      '2026-03-05',
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  // IMP-4a regression: memoizing `rateUsed` per (date, currency) and
  // reapplying it via `round2(amount * cachedRateUsed)` reproduces the
  // FIRST payment's rounding for every other payment sharing that pair,
  // drifting the total whenever amounts don't divide evenly by the rate.
  // With amounts [1, 2, 5, 7, 100, 333] at a fixed 3-units-per-USD rate,
  // fresh-per-payment conversion sums 0.33+0.67+1.67+2.33+33.33+111 =
  // 149.33, while memoizing the first payment's (amount=1) rateUsed=0.33
  // against the rest sums to 147.84. This test asserts the correct
  // (fresh-per-payment) total and FAILS under the memoized implementation.
  it('sums independently-rounded conversions for mixed amounts sharing a date/currency (no rate memoization drift)', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    fakeConvert.setRate('AAA', 3);
    const amounts = [1, 2, 5, 7, 100, 333];
    amounts.forEach((amount, i) => {
      repo.seedPayment({
        id: `p-${amount}`,
        currency: 'AAA',
        amount,
        paidAt: new Date(`2026-03-05T${String(i).padStart(2, '0')}:00:00.000Z`),
      });
    });

    const result = await uc.execute({
      from: new Date('2026-03-01T00:00:00.000Z'),
      to: new Date('2026-04-01T00:00:00.000Z'),
      currency: 'USD',
    });

    const expectedTotal = round2(
      amounts.reduce((sum, amount) => sum + round2(amount / 3), 0),
    );
    expect(expectedTotal).toBe(149.33);
    expect(result.totalConverted).toBe(149.33);
    expect(result.totalConverted).toBe(expectedTotal);
    expect(fakeConvert.calls).toHaveLength(amounts.length);
  });

  // IMP-4b: one payment with an unsupported currency must not throw and
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

  // IMP-4b narrowed catch: only the specific "unsupported currency"
  // BadRequestException from ConvertAmountUseCase is safe to skip. ANY
  // OTHER error (e.g. an infra/DB failure inside GetRatesForDateUseCase)
  // must PROPAGATE -- silently swallowing it would corrupt totalConverted
  // with no trace that anything went wrong.
  it('propagates a non-currency conversion error instead of silently skipping the payment', async () => {
    const { repo, fakeConvert, uc } = makeUseCase();
    fakeConvert.infraFailingFrom.add('COP');
    repo.seedPayment({
      id: 'p-infra-fail',
      currency: 'COP',
      amount: 400000,
      paidAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    await expect(
      uc.execute({
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-04-01T00:00:00.000Z'),
        currency: 'USD',
      }),
    ).rejects.toThrow('simulated infra failure converting COP');
  });
});
