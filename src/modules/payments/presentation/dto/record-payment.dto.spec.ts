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

// DX-395: la referencia y el motivo demasiado largos dan 400 en español (el
// mensaje del gate), no el de class-validator en inglés.
describe('RecordPaymentDto referencia y motivo (DX-395)', () => {
  const base = { amount: 10, currency: 'USD', paidAt: '2026-07-01' };
  const messagesOf = async (body: Record<string, unknown>, property: string) =>
    (await validate(plainToInstance(RecordPaymentDto, { ...base, ...body })))
      .filter((e) => e.property === property)
      .flatMap((e) => Object.values(e.constraints ?? {}));

  it('una referencia de 61 caracteres: mensaje en español', async () => {
    expect(
      await messagesOf({ reference: '1'.repeat(61) }, 'reference'),
    ).toEqual(['La referencia admite como mucho 60 caracteres.']);
    expect(
      await messagesOf({ reference: '1'.repeat(60) }, 'reference'),
    ).toEqual([]);
  });

  it('un motivo de 301 caracteres: mensaje en español', async () => {
    expect(
      await messagesOf(
        { duplicateReferenceReason: 'm'.repeat(301) },
        'duplicateReferenceReason',
      ),
    ).toEqual(['El motivo admite como mucho 300 caracteres.']);
  });

  it('una referencia o un motivo que no son texto: mensaje en español', async () => {
    expect(await messagesOf({ reference: 123 }, 'reference')).toContain(
      'La referencia tiene que ser texto.',
    );
    expect(
      await messagesOf(
        { duplicateReferenceReason: 5 },
        'duplicateReferenceReason',
      ),
    ).toContain('El motivo tiene que ser texto.');
  });
});
