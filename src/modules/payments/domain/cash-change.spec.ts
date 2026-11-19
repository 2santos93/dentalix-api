import { convertWithQuote } from '../../exchange/domain/exchange-rate-quote';
import { toCents } from '../../../shared/money/money';
import {
  centsText,
  changeExceedsMessage,
  changeRateText,
  changeRemainderMessage,
  settleCashChange,
} from './cash-change';

/*
 * DX-570: el cuadre del vuelto, en céntimos de la moneda del abono.
 * Ejemplos de la clínica piloto: cobros en USD con vuelto en VES.
 */
describe('settleCashChange (DX-570)', () => {
  const base = {
    tenderedCents: 5_000,
    collectedCents: 4_500,
    remainderToCredit: false,
    hasAdjustments: false,
  };

  it('vuelto = recibido − cobrado exacto: sin resto', () => {
    expect(settleCashChange({ ...base, changeEquivalentCents: [500] })).toEqual(
      { kind: 'ok', remainderCents: 0 },
    );
  });

  it('el vuelto repartido en varias líneas suma lo debido', () => {
    expect(
      settleCashChange({ ...base, changeEquivalentCents: [200, 300] }),
    ).toEqual({ kind: 'ok', remainderCents: 0 });
  });

  it('recibido = cobrado sin vuelto: nada que devolver', () => {
    expect(
      settleCashChange({
        ...base,
        tenderedCents: 4_500,
        changeEquivalentCents: [],
      }),
    ).toEqual({ kind: 'ok', remainderCents: 0 });
  });

  it('vuelto mayor que lo debido, aunque sea por un céntimo: rechazado', () => {
    expect(settleCashChange({ ...base, changeEquivalentCents: [501] })).toEqual(
      { kind: 'change-exceeds', changeCents: 501, dueCents: 500 },
    );
  });

  it('recibido menor que lo cobrado: rechazado', () => {
    expect(
      settleCashChange({
        ...base,
        tenderedCents: 4_499,
        changeEquivalentCents: [],
      }),
    ).toEqual({ kind: 'tendered-below-collected' });
  });

  it('diferencia sin devolver: hay que confirmarla', () => {
    expect(settleCashChange({ ...base, changeEquivalentCents: [300] })).toEqual(
      { kind: 'remainder-unconfirmed', remainderCents: 200 },
    );
  });

  it('diferencia confirmada: va al abono (saldo a favor)', () => {
    expect(
      settleCashChange({
        ...base,
        changeEquivalentCents: [300],
        remainderToCredit: true,
      }),
    ).toEqual({ kind: 'ok', remainderCents: 200 });
  });

  it('con ajustes por medio de pago no se admite resto, ni confirmado', () => {
    expect(
      settleCashChange({
        ...base,
        changeEquivalentCents: [],
        remainderToCredit: true,
        hasAdjustments: true,
      }),
    ).toEqual({ kind: 'remainder-with-adjustments', remainderCents: 500 });
  });

  it('con ajustes y el vuelto completo: vale', () => {
    // 45 USD + 3 % (1,35) = 46,35 cobrados; recibe 50; vuelve 3,65.
    expect(
      settleCashChange({
        ...base,
        collectedCents: 4_635,
        changeEquivalentCents: [365],
        hasAdjustments: true,
      }),
    ).toEqual({ kind: 'ok', remainderCents: 0 });
  });
});

describe('equivalente de una línea en otra moneda (DX-340: al céntimo, al final)', () => {
  const quote = (fromPerBase: number) => ({
    from: 'VES',
    to: 'USD',
    fromPerBase,
    toPerBase: 1,
  });

  it('5 USD en bolívares a 36,5: 182,50 VES equivalen a 5,00 USD', () => {
    expect(convertWithQuote(182.5, quote(36.5))).toBe(5);
  });

  it('con una tasa de 4 decimales, lo redondeado a la baja no supera lo debido', () => {
    // 5 USD × 36,4321 = 182,1605 → se entrega 182,16 VES.
    const equivalent = convertWithQuote(182.16, quote(36.4321));
    expect(toCents(equivalent)).toBe(500);
    expect(
      settleCashChange({
        tenderedCents: 5_000,
        collectedCents: 4_500,
        changeEquivalentCents: [toCents(equivalent)],
        remainderToCredit: false,
        hasAdjustments: false,
      }).kind,
    ).toBe('ok');
  });

  it('redondear el vuelto hacia arriba en la otra moneda puede pasarse: se rechaza', () => {
    // 0,01 USD a 1 000 VES/USD = 10 VES; 10,01 VES ya equivale a 0,01 USD,
    // pero 15,01 VES son 0,02 USD > 0,01 debido.
    const equivalent = convertWithQuote(15.01, quote(1000));
    expect(
      settleCashChange({
        tenderedCents: 4_501,
        collectedCents: 4_500,
        changeEquivalentCents: [toCents(equivalent)],
        remainderToCredit: false,
        hasAdjustments: false,
      }).kind,
    ).toBe('change-exceeds');
  });

  it('suma en céntimos enteros: 0,1 + 0,2 de vuelto es 0,3 exacto', () => {
    expect(
      settleCashChange({
        tenderedCents: 1_030,
        collectedCents: 1_000,
        changeEquivalentCents: [toCents(0.1), toCents(0.2)],
        remainderToCredit: false,
        hasAdjustments: false,
      }),
    ).toEqual({ kind: 'ok', remainderCents: 0 });
  });
});

describe('textos del vuelto', () => {
  it('importes con 2 decimales y la moneda', () => {
    expect(centsText(500)).toBe('5.00');
    expect(changeExceedsMessage('6.00', '5.00', 'USD')).toBe(
      'El vuelto (6.00 USD) supera lo recibido menos lo cobrado (5.00 USD).',
    );
    expect(changeRemainderMessage('2.00', 'USD')).toContain(
      'Quedan 2.00 USD sin devolver',
    );
  });

  it('la tasa se lee en la moneda más fuerte: 1 USD = 36,5 VES', () => {
    const fmt = (v: number) => v.toString();
    expect(
      changeRateText({ fromPerBase: 36.5, toPerBase: 1 }, 'VES', 'USD', fmt),
    ).toBe('1 USD = 36.5 VES');
    // Abono en VES con vuelto en USD: la misma lectura.
    expect(
      changeRateText({ fromPerBase: 1, toPerBase: 36.5 }, 'USD', 'VES', fmt),
    ).toBe('1 USD = 36.5 VES');
  });
});
