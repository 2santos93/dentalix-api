import { loadDomainsConfig } from './domains-config';

describe('loadDomainsConfig (SEC-009)', () => {
  const load = (value: string | undefined) =>
    loadDomainsConfig((key) =>
      key === 'DOMAIN_RECHECK_MAX_FAILURES' ? value : undefined,
    ).recheckMaxFailures;

  it('default 3', () => {
    expect(load(undefined)).toBe(3);
    expect(load('')).toBe(3);
  });

  it('reads DOMAIN_RECHECK_MAX_FAILURES in 1..20', () => {
    expect(load('1')).toBe(1);
    expect(load(' 5 ')).toBe(5);
    expect(load('20')).toBe(20);
  });

  it('falls back to the default outside the range (validateEnv rejects it at boot)', () => {
    expect(load('0')).toBe(3);
    expect(load('21')).toBe(3);
    expect(load('x')).toBe(3);
  });
});
