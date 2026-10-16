import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecordPaymentDto } from './record-payment.dto';

// Real ISO-4217 validation (`@IsISO4217CurrencyCode()`, applied AFTER the
// uppercase transform) -- mirrors DashboardQueryDto's currency validation
// (dashboard-query.dto.ts). Unlike the old `@Matches(/^[A-Z]{2,8}$/)`
// format-only regex, this rejects a well-FORMED but non-real code like
// "USDD"/"ZZZZ", not just malformed ones (IMP-1b).
describe('RecordPaymentDto currency validation', () => {
  const base = {
    amount: 100,
    paidAt: '2026-07-01T00:00:00.000Z',
  };

  it.each(['USD', 'COP', 'usd'])(
    'accepts a real ISO-4217 currency, case-insensitively (%s)',
    async (currency) => {
      const dto = plainToInstance(RecordPaymentDto, { ...base, currency });

      const errors = await validate(dto);

      expect(errors.find((e) => e.property === 'currency')).toBeUndefined();
    },
  );

  // "USDD"/"ZZZZ" are well-formed (uppercase letters, in-range length) but
  // NOT real ISO-4217 codes -- the old format-only regex accepted them; the
  // real validator must reject them.
  it.each(['1', 'A', '', 'USDD', 'ZZZZ'])(
    'rejects a non-ISO-4217 currency (%s)',
    async (currency) => {
      const dto = plainToInstance(RecordPaymentDto, { ...base, currency });

      const errors = await validate(dto);

      expect(errors.find((e) => e.property === 'currency')).toBeDefined();
    },
  );
});

// DX-042: un importe que no cabe en `Decimal(14,2)` o con más de 2 decimales
// se rechaza en la DTO (400), en vez de llegar a la base (500 por overflow) o
// redondearse en silencio.
describe('RecordPaymentDto amount bounds', () => {
  const base = { currency: 'USD', paidAt: '2026-07-01T00:00:00.000Z' };

  it.each([0.01, 150000.5, 9_999_999_999.99])('accepts %p', async (amount) => {
    const errors = await validate(
      plainToInstance(RecordPaymentDto, { ...base, amount }),
    );
    expect(errors.find((e) => e.property === 'amount')).toBeUndefined();
  });

  it.each([1_234_567_890_123, 10.005, 0, -1])('rejects %p', async (amount) => {
    const errors = await validate(
      plainToInstance(RecordPaymentDto, { ...base, amount }),
    );
    expect(errors.find((e) => e.property === 'amount')).toBeDefined();
  });
});
