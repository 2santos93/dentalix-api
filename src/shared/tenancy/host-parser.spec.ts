import { parseHost } from './host-parser';

const BASES = ['dentalix.app', 'localhost'];

describe('parseHost', () => {
  it('extracts the subdomain under a base domain', () => {
    expect(parseHost('acme.dentalix.app', BASES)).toEqual({
      kind: 'subdomain',
      subdomain: 'acme',
    });
  });

  it('strips the port and lowercases', () => {
    expect(parseHost('ACME.localhost:3000', BASES)).toEqual({
      kind: 'subdomain',
      subdomain: 'acme',
    });
  });

  it('returns null for the apex base domain (no subdomain)', () => {
    expect(parseHost('dentalix.app', BASES)).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    expect(parseHost('www.dentalix.app', BASES)).toBeNull();
    expect(parseHost('api.dentalix.app', BASES)).toBeNull();
  });

  it('returns null for a multi-label subdomain under a base', () => {
    expect(parseHost('a.b.dentalix.app', BASES)).toBeNull();
  });

  it('treats a non-base host as a custom domain', () => {
    expect(parseHost('citas.miclinica.com', BASES)).toEqual({
      kind: 'custom',
      host: 'citas.miclinica.com',
    });
  });

  it('returns null for empty/undefined host', () => {
    expect(parseHost(undefined, BASES)).toBeNull();
    expect(parseHost('', BASES)).toBeNull();
  });
});
