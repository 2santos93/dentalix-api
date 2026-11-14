import { regionalFormat } from '../../../shared/format/regional-format';
import { openingBalanceOverpaidMessage } from './opening-balance-payment';

describe('openingBalanceOverpaidMessage (G1-B, DX-354)', () => {
  it('pending amount in the given format, with the ISO code and closing the sentence once', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'USD',
        regionalFormat({ locale: 'en-US', hourCycle: 'h12' }),
        null,
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
      null,
    );
    expect(message).not.toContain('$');
  });

  it('en de-DE / EUR: «1.234,50 EUR»', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'EUR',
        regionalFormat({ locale: 'de-DE', hourCycle: 'h23' }),
        null,
      ),
    ).toBe(
      'El abono supera lo pendiente del saldo migrado: quedan 1.234,50\u00a0EUR.',
    );
  });

  it('una moneda con código, también en un locale árabe, cierra la frase una sola vez', () => {
    const fmt = regionalFormat({ locale: 'ar-EG', hourCycle: 'h12' });
    const message = openingBalanceOverpaidMessage(1234.5, 'EGP', fmt, null);
    expect(message.endsWith('EGP.')).toBe(true);
    expect(message.endsWith('..')).toBe(false);
  });

  it('DX-517-bis: con el texto propio de la moneda, el texto en el sitio del código y un solo punto', () => {
    expect(
      openingBalanceOverpaidMessage(
        1234.5,
        'VES',
        regionalFormat({ locale: 'es-VE', hourCycle: 'h23' }),
        { VES: 'Bs.' },
      ),
    ).toBe(
      'El abono supera lo pendiente del saldo migrado: quedan Bs.\u00a01.234,50.',
    );
  });
});
