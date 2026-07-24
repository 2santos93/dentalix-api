import { BadRequestException } from '@nestjs/common';
import { CreateSaleUseCase } from './create-sale.use-case';
import { InMemorySaleRepository } from './__fixtures__/in-memory-sale.repository';

describe('CreateSaleUseCase', () => {
  function makeUseCase() {
    const repo = new InMemorySaleRepository();
    return { repo, uc: new CreateSaleUseCase(repo) };
  }

  it('computes amount per line and total as the sum of line amounts', async () => {
    const { uc } = makeUseCase();

    const sale = await uc.execute({
      currency: 'usd',
      paidAt: '2026-03-15T00:00:00.000Z',
      lineItems: [
        { description: 'Cleaning', unitPrice: 50, quantity: 2 },
        { description: 'X-ray', unitPrice: 30, quantity: 1 },
      ],
    });

    expect(sale.lineItems).toHaveLength(2);
    expect(sale.lineItems[0].amount).toBe(100);
    expect(sale.lineItems[1].amount).toBe(30);
    expect(sale.total).toBe(130);
  });

  it('uppercase-normalizes the currency', async () => {
    const { uc } = makeUseCase();

    const sale = await uc.execute({
      currency: 'cop',
      paidAt: new Date('2026-03-15T00:00:00.000Z'),
      lineItems: [{ description: 'Filling', unitPrice: 100000, quantity: 1 }],
    });

    expect(sale.currency).toBe('COP');
  });

  it('rounds per-line amount and total to 2 decimals to avoid float drift', async () => {
    const { uc } = makeUseCase();

    // 0.1 * 3 = 0.30000000000000004 in raw floating point.
    const sale = await uc.execute({
      currency: 'USD',
      paidAt: '2026-03-15T00:00:00.000Z',
      lineItems: [
        { description: 'Drift check', unitPrice: 0.1, quantity: 3 },
        { description: 'Another drift check', unitPrice: 0.2, quantity: 1 },
      ],
    });

    expect(sale.lineItems[0].amount).toBe(0.3);
    expect(sale.total).toBe(0.5);
  });

  it('accepts createdById as a separate argument, never from input', async () => {
    const { uc, repo } = makeUseCase();

    const sale = await uc.execute(
      {
        currency: 'USD',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [{ description: 'Cleaning', unitPrice: 50, quantity: 1 }],
      },
      'user-1',
    );

    expect(sale.createdById).toBe('user-1');
    const stored = await repo.findById(sale.id);
    expect(stored?.createdById).toBe('user-1');
  });

  it('rejects an empty lineItems array with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: 'USD',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects quantity < 1 with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: 'USD',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [{ description: 'Bad qty', unitPrice: 10, quantity: 0 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-integer quantity with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: 'USD',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [{ description: 'Bad qty', unitPrice: 10, quantity: 1.5 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative unitPrice with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: 'USD',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [{ description: 'Bad price', unitPrice: -1, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing/blank currency with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: '  ',
        paidAt: '2026-03-15T00:00:00.000Z',
        lineItems: [{ description: 'Cleaning', unitPrice: 10, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an invalid paidAt with 400', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        currency: 'USD',
        paidAt: 'not-a-date',
        lineItems: [{ description: 'Cleaning', unitPrice: 10, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
