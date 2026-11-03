import { regionalFormat } from '../../../shared/format/regional-format';
import { openingBalanceOverpaidMessage } from './opening-balance-payment';

describe('openingBalanceOverpaidMessage (G1-B, DX-354)', () => {
  it('pending amount in the given format, with the ISO code and closing the sentence once', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'USD',
        regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
      ),
    ).toBe(
      'El abono supera lo pendiente del saldo migrado: quedan USD\u00a01,234.50.',
    );
  });

  it('nunca el símbolo «$»: dice USD', () => {
    const message = openingBalanceOverpaidMessage(
      1234.5,
      'USD',
      regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
    );
    expect(message).not.toContain('$');
  });

  it('en de-DE / EUR: «1.234,50 EUR»', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'EUR',
        regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }),
      ),
    ).toBe(
      'El abono supera lo pendiente del saldo migrado: quedan 1.234,50\u00a0EUR.',
    );
  });

  it('una moneda con código, también en un locale árabe, cierra la frase una sola vez', () => {
    const fmt = regionalFormat({ locale: 'ar-EG', hourCycle: 'h12' });
    const message = openingBalanceOverpaidMessage(1234.5, 'EGP', fmt);
    expect(message.endsWith('EGP.')).toBe(true);
    expect(message.endsWith('..')).toBe(false);
  });
});
