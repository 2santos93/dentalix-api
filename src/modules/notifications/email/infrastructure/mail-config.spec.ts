import { loadMailConfig } from './mail-config';

const env =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key];

describe('loadMailConfig', () => {
  it('por defecto: ConsoleMailer, barrido cada 30 s y clave efímera', () => {
    const config = loadMailConfig(env({ NODE_ENV: 'development' }));
    expect(config.transport).toBe('console');
    expect(config.dispatchIntervalMs).toBe(30_000);
    expect(config.retryBaseMs).toBe(60_000);
    expect(config.ephemeralKey).toBe(true);
    expect(config.encryptionKey).toHaveLength(32);
    expect(config.from).toBe('Dentalix <no-reply@dentalix.local>');
  });

  it('en test el barrido está apagado salvo que se pida', () => {
    expect(loadMailConfig(env({ NODE_ENV: 'test' })).dispatchIntervalMs).toBe(
      0,
    );
    expect(
      loadMailConfig(
        env({ NODE_ENV: 'test', MAIL_DISPATCH_INTERVAL_MS: '500' }),
      ).dispatchIntervalMs,
    ).toBe(500);
  });

  it('smtp con su URL, remitente y clave configurada', () => {
    const key = 'ab'.repeat(16) + 'cd'.repeat(16);
    const config = loadMailConfig(
      env({
        MAIL_TRANSPORT: 'SMTP',
        SMTP_URL: 'smtps://u:p@smtp.x.com:465',
        MAIL_FROM: 'Clínica <no-reply@x.com>',
        MAIL_ENCRYPTION_KEY: key,
        MAIL_RETRY_BASE_MS: '10',
      }),
    );
    expect(config.transport).toBe('smtp');
    expect(config.smtpUrl).toBe('smtps://u:p@smtp.x.com:465');
    expect(config.from).toBe('Clínica <no-reply@x.com>');
    expect(config.ephemeralKey).toBe(false);
    expect(config.encryptionKey.toString('hex')).toBe(key);
    expect(config.retryBaseMs).toBe(10);
  });
});
