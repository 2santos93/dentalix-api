import { BadRequestException, Logger } from '@nestjs/common';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { ExchangeRateUnavailableError } from '../../exchange/domain/ports/exchange-rate-provider.port';
import { PaymentBaseRetries } from './payment-base-retries';
import { InMemoryPaymentBaseRetryRepository } from './__fixtures__/in-memory-payment-base-retry.repository';
import { InMemoryPlanAllocationRepository } from './__fixtures__/in-memory-plan-allocation.repository';
import type { FrozenExchangeRate } from '../domain/payment-exchange-rate';
import { PaymentRateBackupAudit } from './payment-rate-backup-audit';

const MIN = 60_000;

/**
 * Cotiza con las tasas por 1 USD del mapa; una moneda sin tasa lanza `fail`
 * (por defecto «sin tasa» del proveedor). Cuenta las cotizaciones.
 */
function quoting(
  rates: Record<string, number>,
  fail: () => Error = () =>
    new BadRequestException('unsupported currency: VES'),
  backup?: { manualSince: string },
) {
  const quotes: string[] = [];
  const memoizedWith: unknown[] = [];
  const convert = {
    memoized: (options?: unknown) => {
      memoizedWith.push(options);
      return convert;
    },
    execute: (input: { amount: number; from: string; to: string }) => {
      if (input.from === input.to) return Promise.resolve({ rateUsed: 1 });
      const from = input.from === 'USD' ? 1 : rates[input.from];
      const to = input.to === 'USD' ? 1 : rates[input.to];
      if (from === undefined || to === undefined) return Promise.reject(fail());
      return Promise.resolve({ rateUsed: to / from });
    },
    quote: (input: { from: string; to: string; date: string }) => {
      quotes.push(`${input.from}:${input.date}`);
      const perBase = (c: string) => (c === 'USD' ? 1 : rates[c]);
      if (
        perBase(input.from) === undefined ||
        perBase(input.to) === undefined
      ) {
        return Promise.reject(fail());
      }
      return Promise.resolve({
        ...input,
        source: backup ? 'MANUAL' : 'AUTOMATIC',
        fromPerBase: perBase(input.from),
        toPerBase: perBase(input.to),
        ...(backup ? { backup } : {}),
      });
    },
  };
  return {
    convert: convert as unknown as ConvertAmountUseCase,
    quotes,
    memoizedWith,
  };
}

function setup(
  rates: Record<string, number> = {},
  fail?: () => Error,
  backup?: { manualSince: string },
) {
  const retries = new InMemoryPaymentBaseRetryRepository();
  const allocations = new InMemoryPlanAllocationRepository();
  const { convert, quotes, memoizedWith } = quoting(rates, fail, backup);
  const backupUses: { paymentId: string; rate: FrozenExchangeRate }[] = [];
  const audit = {
    backupRateUsed: (paymentId: string, rate: FrozenExchangeRate) => {
      backupUses.push({ paymentId, rate });
      return Promise.resolve();
    },
  } as unknown as PaymentRateBackupAudit;
  const service = new PaymentBaseRetries(retries, allocations, convert, audit);
  return { retries, allocations, service, quotes, memoizedWith, backupUses };
}

/** Un abono en VES (sin tasa) a un plan en USD, «sin tasa» (DX-375). */
const stuck = (paymentId: string) => ({
  paymentId,
  amount: 400,
  currency: 'VES',
  targetCurrency: 'USD',
  planCurrency: 'USD',
  exchangeRateCurrency: 'USD',
});

describe('PaymentBaseRetries (DX-380, OPS-045)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('congela la tasa, crea la base con ella y cierra el reintento', async () => {
    const { retries, allocations, service } = setup({ COP: 4000 });
    retries.add({
      paymentId: 'cop',
      amount: 200_000,
      currency: 'COP',
      targetCurrency: 'USD',
      planCurrency: 'USD',
      exchangeRateCurrency: 'USD',
    });

    await expect(service.retryDue(50)).resolves.toEqual({
      resolved: 1,
      withoutRate: 0,
      failed: 0,
    });
    expect(allocations.frozen.get('cop')?.rate).toMatchObject({
      fromPerBase: 4000,
      toPerBase: 1,
    });
    expect(allocations.bases.get('cop')).toEqual({
      amount: 50,
      currency: 'USD',
      rateDate: '2026-10-30',
    });
    expect(retries.rows.has('cop')).toBe(false);
  });

  // DX-402: el reintento lee con la tasa de respaldo (la manual de un día
  // anterior a «manual desde») y deja en la auditoría que la usó.
  it('el reintento pide la lectura con tasa de respaldo', async () => {
    const { retries, service, memoizedWith } = setup({ COP: 4000 });
    retries.add(stuck('ves'));
    await service.retryDue(50);
    expect(memoizedWith).toEqual([{ manualBackup: true }]);
  });

  it('congelar con la tasa de respaldo queda en la auditoría, con el día y desde cuándo rige la manual', async () => {
    const { retries, allocations, service, backupUses } = setup(
      { COP: 4000 },
      undefined,
      { manualSince: '2026-10-30' },
    );
    retries.add({
      paymentId: 'usd-28',
      amount: 50,
      currency: 'USD',
      paidOn: '2026-10-28',
      targetCurrency: 'COP',
      planCurrency: 'COP',
      exchangeRateCurrency: 'COP',
    });

    await expect(service.retryDue(50)).resolves.toMatchObject({ resolved: 1 });
    expect(allocations.frozen.get('usd-28')?.rate).toMatchObject({
      source: 'MANUAL',
      date: '2026-10-28',
      toPerBase: 4000,
    });
    expect(backupUses).toEqual([
      {
        paymentId: 'usd-28',
        rate: expect.objectContaining({
          date: '2026-10-28',
          backup: { manualSince: '2026-10-30' },
        }) as unknown,
      },
    ]);
  });

  it('una tasa que no es de respaldo no deja ese evento', async () => {
    const { retries, service, backupUses } = setup({ COP: 4000 });
    retries.add({
      paymentId: 'cop',
      amount: 200_000,
      currency: 'COP',
      targetCurrency: 'USD',
      planCurrency: 'USD',
      exchangeRateCurrency: 'USD',
    });
    await service.retryDue(50);
    expect(backupUses).toEqual([]);
  });

  it('si el abono ya tenía la tasa congelada (otra pasada), no se audita el respaldo', async () => {
    const { retries, allocations, service, backupUses } = setup(
      { COP: 4000 },
      undefined,
      { manualSince: '2026-10-30' },
    );
    retries.add({
      paymentId: 'ya',
      amount: 50,
      currency: 'USD',
      paidOn: '2026-10-28',
      targetCurrency: 'COP',
      planCurrency: 'COP',
      exchangeRateCurrency: 'COP',
    });
    // Otra pasada lo congeló entre la lectura y la escritura (DX-375).
    allocations.frozen.set('ya', {
      targetCurrency: 'COP',
      rate: {
        currency: 'COP',
        fromPerBase: 1,
        toPerBase: 3900,
        source: 'AUTOMATIC',
        date: '2026-10-28',
      },
    });
    await service.retryDue(50);
    expect(backupUses).toEqual([]);
    expect(allocations.frozen.get('ya')?.rate?.toPerBase).toBe(3900);
  });

  it('un abono sin tasa se aplaza con el backoff 1 → 5 → 30 min, no cada minuto', async () => {
    const { retries, service, quotes } = setup();
    retries.add(stuck('ves'));

    // 40 pasadas, una por minuto: solo se intenta en 0, 1, 6 y 36 min.
    const attemptedAt: number[] = [];
    for (let minute = 0; minute < 40; minute += 1) {
      const before = quotes.length;
      await service.retryDue(50);
      if (quotes.length > before) attemptedAt.push(minute);
      retries.advance(MIN);
    }

    expect(attemptedAt).toEqual([0, 1, 6, 36]);
    expect(retries.rows.get('ves')).toMatchObject({
      lastReason: 'NO_RATE',
      candidate: { attempts: 4 },
    });
    // Tras el cuarto fallo, 2 h.
    expect(retries.rows.get('ves')?.nextAttemptAt).toEqual(
      new Date(
        new Date('2026-10-30T12:00:00Z').getTime() + 36 * MIN + 120 * MIN,
      ),
    );
  });

  it('con 60 atascados más nuevos, el resoluble más antiguo recibe su base en la primera pasada', async () => {
    const { retries, allocations, service } = setup({ COP: 4000 });
    retries.add(
      {
        paymentId: 'old-cop',
        amount: 4000,
        currency: 'COP',
        targetCurrency: 'USD',
        planCurrency: 'USD',
        exchangeRateCurrency: 'USD',
      },
      new Date(retries.now.getTime() - 60 * MIN),
    );
    for (let i = 0; i < 60; i += 1) {
      retries.add(
        stuck(`ves-${String(i).padStart(2, '0')}`),
        new Date(retries.now.getTime() - (59 - i) * MIN),
      );
    }

    await expect(service.retryDue(50)).resolves.toEqual({
      resolved: 1,
      withoutRate: 49,
      failed: 0,
    });
    expect(allocations.bases.get('old-cop')?.amount).toBe(1);
  });

  it('la selección va por nextAttemptAt: un aplazado no entra antes de su hora y deja sitio a los demás', async () => {
    const { retries, service, quotes } = setup({ COP: 4000 });
    retries.add(stuck('later'), new Date(retries.now.getTime() + 5 * MIN));
    retries.add(stuck('first'), new Date(retries.now.getTime() - 2 * MIN));
    retries.add(stuck('second'), new Date(retries.now.getTime() - MIN));

    await service.retryDue(1);
    await service.retryDue(1);

    expect(quotes).toEqual(['VES:2026-10-30', 'VES:2026-10-30']);
    expect(retries.rows.get('first')?.candidate.attempts).toBe(1);
    expect(retries.rows.get('second')?.candidate.attempts).toBe(1);
    expect(retries.rows.get('later')?.candidate.attempts).toBe(0);
  });

  it('el proveedor que se corta por tiempo cuenta como «sin tasa» (no como error)', async () => {
    const { retries, service } = setup(
      {},
      () =>
        new ExchangeRateUnavailableError(
          'Failed to reach Open Exchange Rates for date 2026-10-30: TimeoutError',
        ),
    );
    retries.add(stuck('ves'));

    await expect(service.retryDue(50)).resolves.toEqual({
      resolved: 0,
      withoutRate: 1,
      failed: 0,
    });
    expect(retries.rows.get('ves')).toMatchObject({
      lastReason: 'NO_RATE',
      nextAttemptAt: new Date(retries.now.getTime() + MIN),
    });
  });

  it('cualquier otro fallo es ERROR, con el mismo backoff, y el aviso solo lleva ids', async () => {
    const { retries, service } = setup({}, () => new TypeError('ana@x.co'));
    retries.add(stuck('ves'));

    await expect(service.retryDue(50)).resolves.toEqual({
      resolved: 0,
      withoutRate: 0,
      failed: 1,
    });
    expect(retries.rows.get('ves')).toMatchObject({
      lastReason: 'ERROR',
      candidate: { attempts: 1 },
    });
    expect(warn).toHaveBeenCalledWith({
      event: 'payments.allocation_retry_failed',
      paymentId: 'ves',
      attempts: 1,
      error: 'TypeError',
    });
  });

  it('un abono anulado (o de un plan retirado) cierra su reintento sin convertir', async () => {
    const { retries, service, quotes } = setup();
    retries.add({ ...stuck('voided'), live: false });

    await expect(service.retryDue(50)).resolves.toEqual({
      resolved: 1,
      withoutRate: 0,
      failed: 0,
    });
    expect(quotes).toEqual([]);
    expect(retries.rows.size).toBe(0);
  });

  it('un abono a un saldo migrado solo congela su tasa (no lleva base)', async () => {
    const { retries, allocations, service } = setup({ COP: 4000 });
    retries.add({
      paymentId: 'opening',
      currency: 'COP',
      targetCurrency: 'USD',
      planCurrency: null,
      exchangeRateCurrency: 'USD',
    });

    await service.retryDue(50);

    expect(allocations.frozen.get('opening')?.rate).not.toBeNull();
    expect(allocations.bases.has('opening')).toBe(false);
    expect(retries.rows.size).toBe(0);
  });

  it('un abono con tasa congelada y sin base solo crea la base, sin cotizar', async () => {
    const { retries, allocations, service, quotes } = setup();
    retries.add({
      paymentId: 'frozen',
      amount: 8000,
      currency: 'COP',
      targetCurrency: 'USD',
      planCurrency: 'USD',
      exchangeRateCurrency: 'USD',
      frozenRate: {
        currency: 'USD',
        fromPerBase: 4000,
        toPerBase: 1,
        source: 'MANUAL',
        date: '2026-10-30',
      },
    });

    await service.retryDue(50);

    expect(quotes).toEqual([]);
    expect(allocations.bases.get('frozen')?.amount).toBe(2);
    expect(retries.rows.size).toBe(0);
  });

  it('wake adelanta los aplazados y el siguiente barrido los intenta ya', async () => {
    const { retries, service, quotes } = setup();
    retries.add(stuck('ves'));
    await service.retryDue(50);
    retries.advance(30_000);
    await service.retryDue(50);
    expect(quotes).toHaveLength(1);

    await expect(service.wake()).resolves.toBe(1);
    await service.retryDue(50);

    expect(quotes).toHaveLength(2);
  });

  it('el aviso al ADMIN cuenta los pendientes de más de 24 h y desde cuándo', async () => {
    const { retries, service } = setup();
    const since = new Date(retries.now.getTime() - 30 * 60 * MIN);
    retries.add(stuck('old'), since);
    retries.add(stuck('recent'), new Date(retries.now.getTime() - 60 * MIN));
    retries.add({ ...stuck('voided'), live: false }, since);

    await expect(service.backlog()).resolves.toEqual({
      count: 1,
      oldestSince: since,
    });
  });
});
