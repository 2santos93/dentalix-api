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

  it('DX-220: resolver DNS con timeout 3000 ms y 2 intentos por defecto, configurables', () => {
    const env = (vars: Record<string, string>) =>
      loadDomainsConfig((key) => vars[key]);
    expect(env({})).toMatchObject({ dnsTimeoutMs: 3000, dnsTries: 2 });
    expect(
      env({ DNS_RESOLVER_TIMEOUT_MS: '1500', DNS_RESOLVER_TRIES: '3' }),
    ).toMatchObject({ dnsTimeoutMs: 1500, dnsTries: 3 });
    expect(
      env({ DNS_RESOLVER_TIMEOUT_MS: '50', DNS_RESOLVER_TRIES: '9' }),
    ).toMatchObject({ dnsTimeoutMs: 3000, dnsTries: 2 });
  });
});
