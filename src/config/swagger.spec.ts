import { swaggerEnabled } from './swagger';

const getter =
  (env: Record<string, string>) =>
  (key: string): string | undefined =>
    env[key];

describe('swaggerEnabled (SEC-019, DX-083)', () => {
  it('fuera de producción, siempre', () => {
    expect(swaggerEnabled(getter({}))).toBe(true);
    expect(swaggerEnabled(getter({ NODE_ENV: 'development' }))).toBe(true);
  });

  it('en producción, solo con SWAGGER_ENABLED="true" exacto', () => {
    expect(swaggerEnabled(getter({ NODE_ENV: 'production' }))).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', '']) {
      expect(
        swaggerEnabled(
          getter({ NODE_ENV: 'production', SWAGGER_ENABLED: value }),
        ),
      ).toBe(false);
    }
    expect(
      swaggerEnabled(
        getter({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
      ),
    ).toBe(true);
  });
});
