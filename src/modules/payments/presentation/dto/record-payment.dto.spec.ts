import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecordPaymentDto } from './record-payment.dto';

// Mirrors DashboardQueryDto's currency validation (dashboard-query.dto.ts):
// `@Matches(/^[A-Z]{2,8}$/)` after the uppercase transform, so a client can
// no longer persist a malformed code like "USDD" or "1" on a Payment.
describe('RecordPaymentDto currency validation', () => {
  const base = {
    amount: 100,
    paidAt: '2026-07-01T00:00:00.000Z',
  };

  it.each(['USD', 'COP', 'usd'])(
    'accepts a valid ISO-4217-like currency (%s)',
    async (currency) => {
      const dto = plainToInstance(RecordPaymentDto, { ...base, currency });

      const errors = await validate(dto);

      expect(errors.find((e) => e.property === 'currency')).toBeUndefined();
    },
  );

  // Same regex/leniency as DashboardQueryDto ("2 to 8 uppercase letters"),
  // so a 4-letter-looking code like "USDD" is NOT itself proof of rejection
  // here -- only non-alphabetic or out-of-range-length values are.
  it.each(['1', 'A', ''])(
    'rejects a malformed currency (%s)',
    async (currency) => {
      const dto = plainToInstance(RecordPaymentDto, { ...base, currency });

      const errors = await validate(dto);

      expect(errors.find((e) => e.property === 'currency')).toBeDefined();
    },
  );
});
