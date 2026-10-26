import { BadRequestException } from '@nestjs/common';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { paymentInPlanCurrency } from './payment-in-plan-currency';

const payment = {
  amount: 100,
  currency: 'EUR',
  planCurrency: 'USD',
  paidOn: '2026-10-20',
};

function convertMock(impl: jest.Mock): ConvertAmountUseCase {
  return { execute: impl } as unknown as ConvertAmountUseCase;
}

describe('paymentInPlanCurrency', () => {
  it('same currency returns amount', async () => {
    const execute = jest.fn().mockResolvedValue({ rateUsed: 1 });
    const out = await paymentInPlanCurrency(convertMock(execute), {
      ...payment,
      currency: 'USD',
    });
    expect(execute).toHaveBeenCalledWith({
      amount: 100,
      from: 'USD',
      to: 'USD',
      date: '2026-10-20',
    });
    expect(out).toBe(100);
  });

  it('rounds each payment to 2 decimals and keeps zero', async () => {
    const execute = jest.fn().mockResolvedValue({ rateUsed: 0.3333 });
    expect(
      await paymentInPlanCurrency(convertMock(execute), {
        ...payment,
        amount: 333,
      }),
    ).toBe(110.99);
    expect(
      await paymentInPlanCurrency(convertMock(execute), {
        ...payment,
        amount: 0,
      }),
    ).toBe(0);
  });

  it('converts with paidOn', async () => {
    const execute = jest.fn().mockResolvedValue({ rateUsed: 1.0837 });
    const out = await paymentInPlanCurrency(convertMock(execute), payment);
    expect(execute).toHaveBeenCalledWith({
      amount: 100,
      from: 'EUR',
      to: 'USD',
      date: '2026-10-20',
    });
    expect(out).toBe(108.37);
  });

  it('null on unsupported currency', async () => {
    const execute = jest
      .fn()
      .mockRejectedValue(new BadRequestException('unsupported currency: EUR'));
    expect(
      await paymentInPlanCurrency(convertMock(execute), payment),
    ).toBeNull();
  });

  it('rethrows other errors', async () => {
    const boom = new Error('provider down');
    const execute = jest.fn().mockRejectedValue(boom);
    await expect(
      paymentInPlanCurrency(convertMock(execute), payment),
    ).rejects.toBe(boom);
    const other = new BadRequestException('date must match YYYY-MM-DD');
    await expect(
      paymentInPlanCurrency(
        convertMock(jest.fn().mockRejectedValue(other)),
        payment,
      ),
    ).rejects.toBe(other);
  });
});
