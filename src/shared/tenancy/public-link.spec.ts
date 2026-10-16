import { resolvePublicWebProtocol } from './public-link';

describe('resolvePublicWebProtocol', () => {
  const env =
    (values: Record<string, string>) =>
    (key: string): string | undefined =>
      values[key];

  it('respeta PUBLIC_WEB_PROTOCOL válido', () => {
    expect(
      resolvePublicWebProtocol(
        env({ PUBLIC_WEB_PROTOCOL: 'http', NODE_ENV: 'production' }),
      ),
    ).toBe('http');
  });

  it('sin valor (o uno inválido): https en producción, http en el resto', () => {
    expect(resolvePublicWebProtocol(env({ NODE_ENV: 'production' }))).toBe(
      'https',
    );
    expect(
      resolvePublicWebProtocol(
        env({ PUBLIC_WEB_PROTOCOL: 'ftp', NODE_ENV: 'development' }),
      ),
    ).toBe('http');
  });
});
