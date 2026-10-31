import { PaymentMethodGate } from '../payment-method-gate';
import { PAID_AT_IN_FUTURE_MESSAGE } from '../../domain/paid-at-window';
import type { PaymentMethodRepository } from '../../../payment-methods/domain/ports/payment-method-repository.port';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import { RecordOpeningBalancePaymentUseCase } from './record-opening-balance-payment.use-case';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';

const whitelist: CurrencyWhitelist = {
  has: (code) => Promise.resolve(['COP', 'USD'].includes(code)),
};

function setup() {
  const repo = new InMemoryPaymentRepository();
  repo.openingBalances.set('ob-1', {
    id: 'ob-1',
    patientId: 'pat-1',
    currency: 'COP',
    amount: 150000,
  });
  const uc = new RecordOpeningBalancePaymentUseCase(
    repo,
    whitelist,
    new PaymentMethodGate(
      {
        findById: () => Promise.resolve(null),
        findByLegacyMethod: () => Promise.resolve(null),
      } as unknown as PaymentMethodRepository,
      repo,
    ),
    () => new Date('2026-10-31T15:00:00.000Z'),
  );
  return { repo, uc };
}

describe('RecordOpeningBalancePaymentUseCase (DX-262, revisión C1)', () => {
  it('DX-054: fecha a más de 24 h en el futuro → 400 en español y no se registra', async () => {
    const { repo, uc } = setup();
    await expect(
      uc.execute('ob-1', {
        amount: 1000,
        currency: 'COP',
        paidAt: '2026-11-05',
      }),
    ).rejects.toThrow(new BadRequestException(PAID_AT_IN_FUTURE_MESSAGE));
    expect(repo.lastCreateInput).toBeNull();
  });

  it('registra el abono contra el saldo migrado, sin plan y con el paciente del saldo', async () => {
    const { repo, uc } = setup();
    const payment = await uc.execute(
      'ob-1',
      { amount: 50000, currency: 'cop', paidAt: '2026-10-20', method: 'CASH' },
      'u-recep',
    );
    expect(payment).toMatchObject({
      treatmentPlanId: null,
      openingBalanceId: 'ob-1',
      patientId: 'pat-1',
      amount: 50000,
      currency: 'COP',
    });
    expect(repo.lastCreateInput).toMatchObject({
      treatmentPlanId: null,
      openingBalanceId: 'ob-1',
      createdById: 'u-recep',
    });
  });

  it('no deja abonar más que lo pendiente (400 en español), contando los abonos vivos', async () => {
    const { uc } = setup();
    await uc.execute('ob-1', {
      amount: 100000,
      currency: 'COP',
      paidAt: '2026-10-20',
    });
    await expect(
      uc.execute('ob-1', {
        amount: 50000.01,
        currency: 'COP',
        paidAt: '2026-10-20',
      }),
    ).rejects.toThrow(
      // La sede del fake: es-CO/h23.
      /^El abono supera lo pendiente del saldo migrado: quedan \$\s50\.000,00\.$/,
    );
    await uc.execute('ob-1', {
      amount: 50000,
      currency: 'COP',
      paidAt: '2026-10-20',
    });
    await expect(
      uc.execute('ob-1', { amount: 1, currency: 'COP', paidAt: '2026-10-20' }),
    ).rejects.toThrow(
      'Este saldo migrado ya está pagado: no admite más abonos.',
    );
  });

  it('the overpaid 400 uses the balance location format, not the write location', async () => {
    const { repo, uc } = setup();
    // El saldo es de la sede A (en-US, 12 h); se cobra desde otra (de-DE).
    repo.locations.set('loc-a', { locale: 'en-US', hourCycle: 'h12' });
    repo.openingBalances.get('ob-1')!.locationId = 'loc-a';
    // La de escritura (loc-1), con otro formato y sin reloj: no se usa.
    repo.locations.set('loc-1', { locale: 'de-DE', hourCycle: null });
    await expect(
      uc.execute('ob-1', {
        amount: 150001,
        currency: 'COP',
        paidAt: '2026-10-20',
      }),
    ).rejects.toThrow(
      'El abono supera lo pendiente del saldo migrado: quedan COP\u00a0150,000.00.',
    );
  });

  it('the overpaid 400 uses the format of the balance location; without clock, 409 only there', async () => {
    const { repo, uc } = setup();
    repo.locations.set('loc-1', { locale: 'en-US', hourCycle: 'h12' });
    await expect(
      uc.execute('ob-1', {
        amount: 150001,
        currency: 'COP',
        paidAt: '2026-10-20',
      }),
    ).rejects.toThrow(
      'El abono supera lo pendiente del saldo migrado: quedan COP\u00a0150,000.00.',
    );
    // Sin reloj: 409 solo al pintar; un abono válido se registra.
    repo.locations.set('loc-1', { locale: 'en-US', hourCycle: null });
    const err = await uc
      .execute('ob-1', {
        amount: 150001,
        currency: 'COP',
        paidAt: '2026-10-20',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LOCATION_LOCALE_REQUIRED',
    });
    await expect(
      uc.execute('ob-1', {
        amount: 1000,
        currency: 'COP',
        paidAt: '2026-10-20',
      }),
    ).resolves.toMatchObject({ amount: 1000 });
  });

  it('otra moneda que la del saldo: 400; saldo inexistente o retirado: 404', async () => {
    const { uc } = setup();
    await expect(
      uc.execute('ob-1', { amount: 10, currency: 'USD', paidAt: '2026-10-20' }),
    ).rejects.toThrow(
      'El abono al saldo migrado tiene que ir en su moneda (COP).',
    );
    await expect(
      uc.execute('ob-x', { amount: 10, currency: 'COP', paidAt: '2026-10-20' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('idempotencia: la misma petición devuelve el abono original; otro saldo o cuerpo, 422', async () => {
    const { repo, uc } = setup();
    repo.openingBalances.set('ob-2', {
      id: 'ob-2',
      patientId: 'pat-1',
      currency: 'COP',
      amount: 10,
    });
    const key = '7d0b0c6e-6f3a-4b62-9b2e-1c3a4f5e6d7c';
    const body = { amount: 1000, currency: 'COP', paidAt: '2026-10-20' };
    const first = await uc.execute('ob-1', body, 'u', key);
    const again = await uc.execute('ob-1', body, 'u', key);
    expect(again.id).toBe(first.id);
    await expect(uc.execute('ob-2', body, 'u', key)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
