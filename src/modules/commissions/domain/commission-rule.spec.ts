import {
  COMMISSION_RULE_MESSAGES,
  isValidPercent,
  parseRuleTerms,
  percentFor,
} from './commission-rule';

describe('regla de honorarios (DX-018)', () => {
  const base = {
    basis: 'COLLECTED' as const,
    releaseMode: 'PER_ITEM' as const,
    percent: 35,
  };

  it('% de 0 a 100 con hasta 2 decimales', () => {
    for (const ok of [0, 35, 12.5, 33.33, 100])
      expect(isValidPercent(ok)).toBe(true);
    for (const bad of [-1, 100.01, 12.345, Number.NaN, Infinity, '35']) {
      expect(isValidPercent(bad)).toBe(false);
    }
  });

  it('recorta las categorías y rechaza vacías, repetidas (sin mayúsculas) o con % inválido', () => {
    expect(
      parseRuleTerms({
        ...base,
        categories: [{ category: '  Endodoncia ', percent: 40 }],
      }),
    ).toEqual({
      ok: true,
      terms: {
        ...base,
        categories: [{ category: 'Endodoncia', percent: 40 }],
        deductLabCost: false,
        deductCardFee: false,
      },
    });
    expect(
      parseRuleTerms({ ...base, categories: [{ category: ' ', percent: 1 }] }),
    ).toEqual({
      ok: false,
      message: COMMISSION_RULE_MESSAGES.categoryName,
    });
    expect(
      parseRuleTerms({
        ...base,
        categories: [
          { category: 'Endodoncia', percent: 40 },
          { category: 'ENDODONCIA', percent: 45 },
        ],
      }),
    ).toEqual({
      ok: false,
      message: COMMISSION_RULE_MESSAGES.categoryDuplicated,
    });
    expect(
      parseRuleTerms({
        ...base,
        categories: [{ category: 'Cirugía', percent: 101 }],
      }),
    ).toEqual({ ok: false, message: COMMISSION_RULE_MESSAGES.percent });
    expect(parseRuleTerms({ ...base, percent: 150 })).toEqual({
      ok: false,
      message: COMMISSION_RULE_MESSAGES.percent,
    });
  });

  it('los descuentos sin datos de origen no se pueden activar (400 con el porqué)', () => {
    expect(parseRuleTerms({ ...base, deductLabCost: true })).toEqual({
      ok: false,
      message: COMMISSION_RULE_MESSAGES.labCostUnavailable,
    });
    expect(parseRuleTerms({ ...base, deductCardFee: true })).toEqual({
      ok: false,
      message: COMMISSION_RULE_MESSAGES.cardFeeUnavailable,
    });
    expect(
      parseRuleTerms({ ...base, deductLabCost: false, deductCardFee: false })
        .ok,
    ).toBe(true);
  });

  it('percentFor: el de la categoría si la regla lo tiene; si no, el general', () => {
    const terms = {
      percent: 30,
      categories: [{ category: 'Cirugía', percent: 50 }],
    };
    expect(percentFor(terms, 'cirugía')).toBe(50);
    expect(percentFor(terms, 'Ortodoncia')).toBe(30);
    expect(percentFor(terms, null)).toBe(30);
  });
});
