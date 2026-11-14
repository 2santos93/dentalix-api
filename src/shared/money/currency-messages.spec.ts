import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CURRENCY_CODE_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
  currencyListMessage,
  unknownCurrencyNamedMessage,
} from './currency-messages';
import { RecordPaymentDto } from '../../modules/payments/presentation/dto/record-payment.dto';
import { SplitPaymentLineDto } from '../../modules/payments/presentation/dto/record-split-payment.dto';
import { DashboardQueryDto } from '../../modules/dashboard/presentation/dto/dashboard-query.dto';
import { ReceivablesAgingFiltersDto } from '../../modules/receivables/presentation/dto/receivables-aging-query.dto';
import { LocationsComparisonQueryDto } from '../../modules/reports/presentation/dto/locations-comparison.dto';
import { ProductionItemsQueryDto } from '../../modules/reports/presentation/dto/production-by-procedure.dto';
import {
  CashCountInputDto,
  CashFloatInputDto,
  CreateCashAdjustmentDto,
} from '../../modules/cash-sessions/presentation/dto/cash-sessions.dto';
import { PaymentRateBacklogDayQueryDto } from '../../modules/payments/presentation/dto/payment-rate-backlog.dto';
import {
  GetRatesQueryDto,
  RATE_CURRENCIES_MAX,
} from '../../modules/exchange/presentation/dto/get-rates-query.dto';
import { PriceQuoteQueryDto } from '../../modules/treatment-plans/presentation/dto/price-quote.dto';
import {
  CreatePriceListDto,
  UpdatePriceListDto,
} from '../../modules/price-lists/presentation/dto/price-list.dto';
import {
  RefundCreditDto,
  TransferCreditDto,
} from '../../modules/patient-credit/presentation/dto/patient-credit.dto';
import {
  CreateExpenseDto,
  UpdateExpenseDto,
} from '../../modules/expenses/presentation/dto/expense-requests.dto';
import { CreateTreatmentPlanDto } from '../../modules/treatment-plans/presentation/dto/create-treatment-plan.dto';
import { UpdateTreatmentPlanDto } from '../../modules/treatment-plans/presentation/dto/update-treatment-plan.dto';
import { PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE } from '../../modules/price-lists/domain/price-list-rules';
import { CANCELLATION_POLICY_MESSAGES } from '../../modules/cancellation-policies/domain/cancellation-policy';
import { MANUAL_RATE_CURRENCY_MESSAGE } from '../../modules/exchange/domain/exchange-rate-source';
import { REGIONAL_MESSAGES } from '../../modules/locations/domain/regional-settings';
import { parseCurrencyTextEntries } from '../../modules/exchange/domain/clinic-currency-texts';
import { UNKNOWN_CURRENCY_MESSAGE as EQUIPMENT_UNKNOWN } from '../../modules/equipment/domain/equipment-rules';
import { UNKNOWN_CURRENCY_MESSAGE as COLLECTIONS_UNKNOWN } from '../../modules/collections/application/use-cases/collections.use-cases';
import { UNKNOWN_CURRENCY_MESSAGE as EXPENSES_UNKNOWN } from '../../modules/expenses/domain/expense-rules';

type Ctor = new () => object;

/** Los mensajes del campo `field` al validar `value` en `dto`. */
async function messagesOf(
  dto: Ctor,
  field: string,
  value: unknown,
): Promise<string[]> {
  const errors = await validate(plainToInstance(dto, { [field]: value }));
  const error = errors.find((e) => e.property === field);
  return Object.values(error?.constraints ?? {});
}

/**
 * DX-517-bis (3): un 400 de moneda dice lo mismo en toda la API, en español
 * neutro, sin el nombre técnico del campo ni un código o país fijo.
 */
describe('mensajes 400 de moneda (DX-517-bis)', () => {
  it('los textos comunes: español neutro, sin códigos de moneda ni países', () => {
    for (const message of [
      CURRENCY_CODE_MESSAGE,
      UNKNOWN_CURRENCY_MESSAGE,
      currencyListMessage(RATE_CURRENCIES_MAX),
    ]) {
      expect(message).toMatch(/^[A-ZÁÉÍÓÚÑ¿].*\.$/u);
      expect(message).not.toMatch(/\bcurrenc/i);
      // Ningún código de moneda escrito a mano (ISO 4217 sí es el estándar).
      expect(message.replace('ISO 4217', '')).not.toMatch(/\b[A-Z]{3}\b/);
    }
    expect(currencyListMessage(RATE_CURRENCIES_MAX)).toContain(
      String(RATE_CURRENCIES_MAX),
    );
  });

  it.each<[string, Ctor, string, unknown]>([
    ['RecordPaymentDto', RecordPaymentDto, 'currency', 'ZZZZ'],
    ['SplitPaymentLineDto', SplitPaymentLineDto, 'currency', 'ZZZZ'],
    ['DashboardQueryDto', DashboardQueryDto, 'currency', 'ZZZZ'],
    [
      'ReceivablesAgingFiltersDto',
      ReceivablesAgingFiltersDto,
      'currency',
      'us',
    ],
    [
      'LocationsComparisonQueryDto',
      LocationsComparisonQueryDto,
      'currency',
      'us',
    ],
    ['ProductionItemsQueryDto', ProductionItemsQueryDto, 'currency', 'us'],
    ['CashFloatInputDto', CashFloatInputDto, 'currency', 'us'],
    ['CashCountInputDto', CashCountInputDto, 'currency', 'us'],
    ['CreateCashAdjustmentDto', CreateCashAdjustmentDto, 'currency', 'us'],
    [
      'PaymentRateBacklogDayQueryDto',
      PaymentRateBacklogDayQueryDto,
      'currency',
      'us',
    ],
    ['PriceQuoteQueryDto', PriceQuoteQueryDto, 'currency', 'us'],
    ['CreatePriceListDto', CreatePriceListDto, 'currency', 'us'],
    ['UpdatePriceListDto', UpdatePriceListDto, 'currency', 'us'],
    ['TransferCreditDto', TransferCreditDto, 'currency', 'ZZZZ'],
    ['RefundCreditDto', RefundCreditDto, 'currency', 'ZZZZ'],
    ['CreateExpenseDto', CreateExpenseDto, 'currency', 'ZZZZ'],
    ['UpdateExpenseDto', UpdateExpenseDto, 'currency', 'ZZZZ'],
    ['CreateTreatmentPlanDto', CreateTreatmentPlanDto, 'currency', 7],
    ['UpdateTreatmentPlanDto', UpdateTreatmentPlanDto, 'currency', 7],
  ])(
    '%s: un código mal formado da el texto común',
    async (_n, dto, field, value) => {
      const messages = await messagesOf(dto, field, value);
      expect(messages.length).toBeGreaterThan(0);
      expect(new Set(messages)).toEqual(new Set([CURRENCY_CODE_MESSAGE]));
    },
  );

  it('GetRatesQueryDto: una lista mal formada da su texto común', async () => {
    const messages = await messagesOf(GetRatesQueryDto, 'currencies', 'VES,1');
    expect(new Set(messages)).toEqual(
      new Set([currencyListMessage(RATE_CURRENCIES_MAX)]),
    );
  });

  // DX-517-quater: las validaciones de moneda que quedaban sueltas.
  it('cancelación, tasa manual, sede y textos de moneda usan el juego común', () => {
    expect(CANCELLATION_POLICY_MESSAGES.currency).toBe(
      UNKNOWN_CURRENCY_MESSAGE,
    );
    expect(MANUAL_RATE_CURRENCY_MESSAGE).toBe(UNKNOWN_CURRENCY_MESSAGE);
    expect(REGIONAL_MESSAGES.currencyUnknown('ZZZ')).toBe(
      unknownCurrencyNamedMessage('ZZZ'),
    );
    expect(unknownCurrencyNamedMessage('ZZZ')).toBe(
      'La moneda ZZZ no está en la lista de monedas admitidas.',
    );
    expect(
      parseCurrencyTextEntries([{ currency: 'ZZZ', text: 'Z' }], () => false),
    ).toEqual({ ok: false, message: unknownCurrencyNamedMessage('ZZZ') });
  });

  it('una moneda fuera de la lista admitida da el mismo texto en todos los módulos', () => {
    expect(PRICE_LIST_CURRENCY_UNKNOWN_MESSAGE).toBe(UNKNOWN_CURRENCY_MESSAGE);
    expect(EQUIPMENT_UNKNOWN).toBe(UNKNOWN_CURRENCY_MESSAGE);
    expect(COLLECTIONS_UNKNOWN).toBe(UNKNOWN_CURRENCY_MESSAGE);
    expect(EXPENSES_UNKNOWN).toBe(UNKNOWN_CURRENCY_MESSAGE);
  });
});
