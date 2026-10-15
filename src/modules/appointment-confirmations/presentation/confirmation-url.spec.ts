import { buildConfirmationUrl } from './confirmation-url';

describe('buildConfirmationUrl', () => {
  it('usa el host de la clínica (con puerto) y el protocolo dado', () => {
    expect(buildConfirmationUrl('http', 'demo.localhost:3001', 'abc_-1')).toBe(
      'http://demo.localhost:3001/confirmar/abc_-1',
    );
    expect(buildConfirmationUrl('https', 'sonrisa.dentalix.app', 'tok')).toBe(
      'https://sonrisa.dentalix.app/confirmar/tok',
    );
  });

  it('normaliza el host a minúsculas', () => {
    expect(buildConfirmationUrl('https', 'Sonrisa.Dentalix.App', 't')).toBe(
      'https://sonrisa.dentalix.app/confirmar/t',
    );
  });
});
