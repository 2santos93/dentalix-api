import {
  loadPlanQuoteComposition,
  planQuoteComposeV4Problems,
} from './plan-quote-composition.config';

const env = (value: string | undefined) => (key: string) =>
  key === 'PLAN_QUOTE_COMPOSE_V4' ? value : undefined;

describe('PLAN_QUOTE_COMPOSE_V4 (DX-502)', () => {
  it('por defecto compone la v4; solo «false» vuelve a la composición anterior', () => {
    expect(loadPlanQuoteComposition(env(undefined))).toBe('current');
    expect(loadPlanQuoteComposition(env(''))).toBe('current');
    expect(loadPlanQuoteComposition(env('true'))).toBe('current');
    expect(loadPlanQuoteComposition(env(' false '))).toBe('legacy');
  });

  it('cualquier otro valor es un problema de configuración', () => {
    expect(planQuoteComposeV4Problems(env('false'))).toEqual([]);
    expect(planQuoteComposeV4Problems(env('no'))).toEqual([
      'PLAN_QUOTE_COMPOSE_V4 debe ser "true" o "false".',
    ]);
  });
});
