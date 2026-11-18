import { quoteSource } from '../../treatment-plans/application/use-cases/__fixtures__/in-memory-plan-quote.repository';
import { composeQuoteContent } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  budgetPresentationItems,
  composeBudgetPresentation,
  parseBudgetPresentation,
  type BudgetSecondCurrencySource,
} from './budget-presentation';

const NOW = new Date('2026-11-18T03:30:00.000Z'); // 17 nov, 23:30 en Caracas

function source(overrides: Partial<BudgetSecondCurrencySource> = {}) {
  const stored: { date: string; currencies: readonly string[] }[] = [];
  const port: BudgetSecondCurrencySource = {
    currencyFor: () => Promise.resolve('VES'),
    stored: (date, currencies) => {
      stored.push({ date, currencies });
      return Promise.resolve({
        source: 'AUTOMATIC',
        rates: { VES: 45, EUR: 0.9 },
        rateDate: date,
      });
    },
    ...overrides,
  };
  return { port, stored };
}

function sample(currency = 'USD') {
  const base = quoteSource();
  const quote = {
    ...base,
    plan: { ...base.plan, currency },
    location: { ...base.location, timeZone: 'America/Caracas' },
  };
  const content = composeQuoteContent(
    quote,
    { issuedOn: '2026-11-17', validUntil: '2026-12-17' },
    {},
  );
  return { quote, content };
}

describe('budget presentation (DX-560)', () => {
  it('usa el día civil de la sede y la tasa del plan y la segunda moneda', async () => {
    const { quote, content } = sample('EUR');
    const { port, stored } = source();
    const out = await composeBudgetPresentation(quote, content, port, NOW);
    expect(stored).toEqual([
      { date: '2026-11-17', currencies: ['EUR', 'VES'] },
    ]);
    expect(out.secondCurrency).toEqual({
      currency: 'VES',
      fromPerBase: 0.9,
      toPerBase: 45,
      source: 'AUTOMATIC',
      date: '2026-11-17',
    });
  });

  it('sin segunda moneda, la misma que la del plan o sin tasa de una de las dos: sin bloque y sin leer de más', async () => {
    const { quote, content } = sample('USD');
    const none = source({ currencyFor: () => Promise.resolve(null) });
    expect(
      await composeBudgetPresentation(quote, content, none.port, NOW),
    ).not.toHaveProperty('secondCurrency');
    expect(none.stored).toEqual([]);
    const same = source({ currencyFor: () => Promise.resolve('USD') });
    expect(
      await composeBudgetPresentation(quote, content, same.port, NOW),
    ).not.toHaveProperty('secondCurrency');
    const missing = source({ currencyFor: () => Promise.resolve('COP') });
    expect(
      await composeBudgetPresentation(quote, content, missing.port, NOW),
    ).not.toHaveProperty('secondCurrency');
  });

  it('sin presentación compuesta, cada ítem lleva el nombre de la foto', () => {
    const { quote, content } = sample();
    const out = budgetPresentationItems(quote, content);
    expect(out.items).toEqual(
      content.items.map((item, index) => ({
        index,
        visit: 1,
        label: item.procedure,
      })),
    );
  });

  describe('parseBudgetPresentation', () => {
    const good = {
      language: 'es',
      items: [{ index: 0, visit: 1, label: 'Limpieza' }],
      visitOrganization: [{ visit: 1, label: null, minDaysAfterPrevious: 0 }],
    };

    it('acepta la forma guardada (con o sin segunda moneda)', () => {
      expect(parseBudgetPresentation(good, 1)).toEqual(good);
      const withSecond = {
        ...good,
        secondCurrency: {
          currency: 'VES',
          fromPerBase: 1,
          toPerBase: 45,
          source: 'MANUAL',
          date: '2026-11-17',
        },
      };
      expect(parseBudgetPresentation(withSecond, 1)).toEqual(withSecond);
    });

    it.each([
      ['null', null],
      ['un array', []],
      ['sin idioma', { ...good, language: 1 }],
      ['un ítem sin texto', { ...good, items: [{ index: 0, visit: 1 }] }],
      ['otro número de ítems', { ...good, items: [] }],
      [
        'índices fuera de orden',
        { ...good, items: [{ index: 1, visit: 1, label: 'x' }] },
      ],
    ])('%s → null (la página cae a la lista de siempre)', (_, value) => {
      expect(parseBudgetPresentation(value, 1)).toBeNull();
    });
  });
});
