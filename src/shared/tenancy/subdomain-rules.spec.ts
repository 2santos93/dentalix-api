import {
  normalizeSubdomain,
  SUBDOMAIN_PATTERN,
  subdomainRuleVerdict,
} from './subdomain-rules';

describe('subdomain rules', () => {
  it.each(['sonrisa', 'sonrisa-norte', 'a', '9', 'c1', 'a'.repeat(63), 'ab-c'])(
    'acepta %p',
    (s) => expect(subdomainRuleVerdict(s)).toBe('ok'),
  );

  it.each([
    '',
    '-sonrisa',
    'sonrisa-',
    'Sonrisa',
    'sonrisa.norte',
    'sonrisa_norte',
    'clínica',
    'a'.repeat(64),
    'xn--bcher-kva',
    'ab--c',
    'son risa',
  ])('rechaza el formato de %p', (s) =>
    expect(subdomainRuleVerdict(s)).toBe('invalid'),
  );

  it.each(['www', 'api', 'app', 'admin'])('%p es de la plataforma', (s) =>
    expect(subdomainRuleVerdict(s)).toBe('reserved'),
  );

  it('normaliza como el registro', () => {
    expect(normalizeSubdomain('  Sonrisa-Norte ')).toBe('sonrisa-norte');
  });

  it('la expresión no usa lookbehind (la web la reusa en navegadores antiguos)', () => {
    expect(SUBDOMAIN_PATTERN.source).not.toMatch(/\(\?<[=!]/);
  });
});
