import { quoteSource } from '../../treatment-plans/application/use-cases/__fixtures__/in-memory-plan-quote.repository';
import { composeQuoteContent } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  budgetPresentationItems,
  composeBudgetPresentation,
  parseBudgetPresentation,
  requestedSecondCurrencyError,
  SECOND_CURRENCY_SAME_MESSAGE,
  SECOND_CURRENCY_UNKNOWN_MESSAGE,
  secondCurrencyFor,
  type BudgetSecondCurrencySource,
} from './budget-presentation';

const NOW = new Date('2026-11-18T03:30:00.000Z'); // 17 nov, 23:30 en Caracas

function source(overrides: Partial<BudgetSecondCurrencySource> = {}) {
  const stored: { date: string; currencies: readonly string[] }[] = [];
  const port: BudgetSecondCurrencySource = {
    currencyExists: (code) => Promise.resolve(code !== 'XXX'),
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

function sample(currency = 'USD', locationCurrency: string | null = 'VES') {
  const base = quoteSource();
  const quote = {
    ...base,
    plan: { ...base.plan, currency },
    location: {
      ...base.location,
      timeZone: 'America/Caracas',
      currency: locationCurrency,
    },
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

  it('regla: la elegida; si no, la de la sede si es distinta del plan; si no, ninguna', () => {
    expect(
      secondCurrencyFor({
        requested: 'EUR',
        locationCurrency: 'VES',
        planCurrency: 'USD',
      }),
    ).toBe('EUR');
    expect(
      secondCurrencyFor({ locationCurrency: 'VES', planCurrency: 'USD' }),
    ).toBe('VES');
    expect(
      secondCurrencyFor({ locationCurrency: 'USD', planCurrency: 'USD' }),
    ).toBeNull();
    expect(
      secondCurrencyFor({ locationCurrency: null, planCurrency: 'USD' }),
    ).toBeNull();
  });

  it('la elegida: 400 si es la del plan o no está en el catálogo de monedas', async () => {
    const { port } = source();
    expect(await requestedSecondCurrencyError(port, 'USD', 'USD')).toBe(
      SECOND_CURRENCY_SAME_MESSAGE,
    );
    expect(await requestedSecondCurrencyError(port, 'XXX', 'USD')).toBe(
      SECOND_CURRENCY_UNKNOWN_MESSAGE,
    );
    expect(await requestedSecondCurrencyError(port, 'VES', 'USD')).toBeNull();
  });

  it('elegida VES en un plan USD con la sede en USD: bloque VES', async () => {
    const { quote, content } = sample('USD', 'USD');
    const { port } = source();
    const out = await composeBudgetPresentation(
      quote,
      content,
      port,
      NOW,
      'VES',
    );
    expect(out.secondCurrency).toMatchObject({
      currency: 'VES',
      toPerBase: 45,
    });
  });

  it('sin elegir y la sede en la moneda del plan, o sin tasa: sin bloque y sin leer de más', async () => {
    const { quote, content } = sample('USD', 'USD');
    const none = source();
    expect(
      await composeBudgetPresentation(quote, content, none.port, NOW),
    ).not.toHaveProperty('secondCurrency');
    expect(none.stored).toEqual([]);
    const missing = source({ stored: () => Promise.resolve(null) });
    expect(
      await composeBudgetPresentation(quote, content, missing.port, NOW, 'GBP'),
    ).not.toHaveProperty('secondCurrency');
    const noRate = source();
    expect(
      await composeBudgetPresentation(quote, content, noRate.port, NOW, 'GBP'),
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
