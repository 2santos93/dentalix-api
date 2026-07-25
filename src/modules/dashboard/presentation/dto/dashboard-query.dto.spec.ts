import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DashboardQueryDto } from './dashboard-query.dto';

// Real ISO-4217 validation (`@IsISO4217CurrencyCode()`, applied AFTER the
// uppercase transform) -- mirrors RecordPaymentDto's currency validation
// (record-payment.dto.ts). Unlike the old `@Matches(/^[A-Z]{2,8}$/)`
// format-only regex, this rejects a well-FORMED but non-real code like
// "USDD"/"ZZZZ", not just malformed ones (IMP-1b).
describe('DashboardQueryDto currency validation', () => {
  const base = {
    from: '2026-07-01',
    to: '2026-07-31',
  };

  it.each(['USD', 'COP', 'usd'])(
    'accepts a real ISO-4217 currency, case-insensitively (%s)',
    async (currency) => {
      const dto = plainToInstance(DashboardQueryDto, { ...base, currency });

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
      const dto = plainToInstance(DashboardQueryDto, { ...base, currency });

      const errors = await validate(dto);

      expect(errors.find((e) => e.property === 'currency')).toBeDefined();
    },
  );
});
