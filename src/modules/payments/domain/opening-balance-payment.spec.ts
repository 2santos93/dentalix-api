import { regionalFormat } from '../../../shared/format/regional-format';
import { openingBalanceOverpaidMessage } from './opening-balance-payment';

describe('openingBalanceOverpaidMessage (G1-B)', () => {
  it('pending amount in the given format, closing the sentence once', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'USD',
        regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
      ),
    ).toBe('El abono supera lo pendiente del saldo migrado: quedan $1,234.50.');
  });

  it('a currency symbol that ends in a period is not followed by a second one', () => {
    const fmt = regionalFormat({ locale: 'ar-EG', hourCycle: 'h12' });
    const money = fmt.money(1234.5, 'EGP');
    expect(money.endsWith('.')).toBe(true);
    expect(openingBalanceOverpaidMessage(1234.5, 'EGP', fmt)).toBe(
      `El abono supera lo pendiente del saldo migrado: quedan ${money}`,
    );
  });
});
