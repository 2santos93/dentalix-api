import { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import { GetRatesForDateUseCase } from '../../exchange/application/use-cases/get-rates-for-date.use-case';
import {
  makeManualRates,
  makeSettings,
} from '../../exchange/application/__fixtures__/in-memory-exchange-settings';
import type { ExchangeRateRepository } from '../../exchange/domain/ports/exchange-rate-repository.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { paymentInPlanCurrency } from './payment-in-plan-currency';
import { GetPaymentsTotalsUseCase } from './use-cases/get-payments-totals.use-case';
import { InMemoryPaymentRepository } from './use-cases/__fixtures__/in-memory-payment.repository';

// DX-374: con la fuente MANUAL, una moneda sin tasa del día no rompe a los
// consumidores de la conversión (saldo, recibo, imputación, totales del
// dashboard): el abono cuenta como «sin tasa», sin 500 y sin llamar al
// proveedor. Conversión REAL (ConvertAmount + GetRatesForDate); solo la caché,
// el proveedor y las tablas de la clínica van en memoria.
const TENANT = '44444444-4444-4444-8444-444444444444';
const DAY = '2026-10-29';

function setup() {
  const tenantContext = new TenantContextService();
  const fetchRates = jest.fn();
  const cache: ExchangeRateRepository = {
    findByDate: () => Promise.reject(new Error('no debe leer la caché')),
    upsertMany: () => Promise.reject(new Error('no debe escribir la caché')),
  };
  const convert = new ConvertAmountUseCase(
    new GetRatesForDateUseCase(
      cache,
      { fetchRates },
      makeSettings({ [TENANT]: 'MANUAL' }, tenantContext),
      makeManualRates({ [TENANT]: { [DAY]: { COP: 4000 } } }, tenantContext),
      tenantContext,
    ),
  );
  return { convert, fetchRates, tenantContext };
}

describe('tasa manual sin registrar en los consumidores (DX-374)', () => {
  it('el abono en una moneda sin tasa manual del día queda «sin tasa» (null)', async () => {
    const { convert, fetchRates, tenantContext } = setup();
    const amount = await tenantContext.run(TENANT, () =>
      paymentInPlanCurrency(convert, {
        amount: 50,
        currency: 'EUR',
        planCurrency: 'USD',
        paidOn: DAY,
      }),
    );
    expect(amount).toBeNull();
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('con la tasa manual del día el abono se convierte con ella', async () => {
    const { convert, tenantContext } = setup();
    const amount = await tenantContext.run(TENANT, () =>
      paymentInPlanCurrency(convert, {
        amount: 400000,
        currency: 'COP',
        planCurrency: 'USD',
        paidOn: DAY,
      }),
    );
    expect(amount).toBe(100);
  });

  it('los totales del período saltan el abono sin tasa y suman el resto', async () => {
    const { convert, fetchRates, tenantContext } = setup();
    const repo = new InMemoryPaymentRepository('UTC');
    repo.seedPayment({
      id: 'p-cop',
      currency: 'COP',
      amount: 400000,
      paidAt: new Date(`${DAY}T15:00:00.000Z`),
    });
    repo.seedPayment({
      id: 'p-eur',
      currency: 'EUR',
      amount: 90,
      paidAt: new Date(`${DAY}T16:00:00.000Z`),
    });
    const totals = new GetPaymentsTotalsUseCase(repo, convert);

    const result = await tenantContext.run(TENANT, () =>
      totals.execute({ from: DAY, to: DAY, currency: 'USD' }),
    );

    expect(result.totalConverted).toBe(100);
    expect(result.count).toBe(2);
    expect(result.byCurrency).toEqual({ COP: 400000, EUR: 90 });
    expect(fetchRates).not.toHaveBeenCalled();
  });
});
