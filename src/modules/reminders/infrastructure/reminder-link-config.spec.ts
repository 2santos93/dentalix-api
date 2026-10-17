import { clinicLinkHost, loadReminderLinkConfig } from './reminder-link-config';

const getter =
  (env: Record<string, string | undefined>) =>
  (key: string): string | undefined =>
    env[key];

describe('enlace de confirmación de los recordatorios (DX-026)', () => {
  it('usa PUBLIC_WEB_BASE_HOST y PUBLIC_WEB_PROTOCOL', () => {
    const config = loadReminderLinkConfig(
      getter({
        PUBLIC_WEB_BASE_HOST: 'localhost:3001',
        PUBLIC_WEB_PROTOCOL: 'http',
      }),
    );
    expect(config).toEqual({ protocol: 'http', baseHost: 'localhost:3001' });
    expect(clinicLinkHost(config, 'demo')).toBe('demo.localhost:3001');
  });

  it('sin PUBLIC_WEB_BASE_HOST, el primer TENANT_BASE_DOMAINS y https en producción', () => {
    expect(
      loadReminderLinkConfig(
        getter({
          TENANT_BASE_DOMAINS: 'Dentalix.app, localhost',
          NODE_ENV: 'production',
        }),
      ),
    ).toEqual({ protocol: 'https', baseHost: 'dentalix.app' });
  });

  it('un subdominio que no da un host válido no produce enlace', () => {
    const config = loadReminderLinkConfig(
      getter({ PUBLIC_WEB_BASE_HOST: 'dentalix.app' }),
    );
    expect(clinicLinkHost(config, 'demo@evil.com')).toBeNull();
  });

  it('falla en voz alta con un host base inválido', () => {
    expect(() =>
      loadReminderLinkConfig(getter({ PUBLIC_WEB_BASE_HOST: 'a/b' })),
    ).toThrow('PUBLIC_WEB_BASE_HOST');
  });
});
