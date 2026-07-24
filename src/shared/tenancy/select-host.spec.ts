import { selectHost } from './select-host';

describe('selectHost', () => {
  it('prefers X-Tenant-Host in non-production', () => {
    const h = selectHost(
      { 'x-tenant-host': 'acme.dentalix.app', host: '127.0.0.1' },
      { isProd: false, trustProxy: false },
    );
    expect(h).toBe('acme.dentalix.app');
  });

  it('ignores X-Tenant-Host in production', () => {
    const h = selectHost(
      { 'x-tenant-host': 'evil.dentalix.app', host: 'acme.dentalix.app' },
      { isProd: true, trustProxy: false },
    );
    expect(h).toBe('acme.dentalix.app');
  });

  it('uses X-Forwarded-Host only when trustProxy is true', () => {
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app', host: 'internal' },
        { isProd: true, trustProxy: true },
      ),
    ).toBe('acme.dentalix.app');
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app', host: 'internal' },
        { isProd: true, trustProxy: false },
      ),
    ).toBe('internal');
  });

  it('takes the first value of a comma-joined X-Forwarded-Host', () => {
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app, proxy1', host: 'internal' },
        { isProd: true, trustProxy: true },
      ),
    ).toBe('acme.dentalix.app');
  });

  it('falls back to the Host header', () => {
    expect(
      selectHost(
        { host: 'acme.localhost' },
        { isProd: false, trustProxy: false },
      ),
    ).toBe('acme.localhost');
  });
});
