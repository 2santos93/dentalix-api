import { ConfigService } from '@nestjs/config';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.port';
import {
  OpenExchangeRatesProvider,
  PROVIDER_TIMEOUT_MS,
} from './open-exchange-rates.provider';

function makeProvider(env: Record<string, string> = {}) {
  const config = {
    get: (key: string) =>
      ({
        EXCHANGE_APP_ID: 'app-id',
        EXCHANGE_BASE_URL: 'https://oer.test/api',
        ...env,
      })[key],
  } as unknown as ConfigService;
  return new OpenExchangeRatesProvider(config);
}

describe('OpenExchangeRatesProvider (SEC-054)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('pide el día histórico con base USD y un tiempo máximo de 10 s', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ base: 'USD', rates: { COP: 4000 } })),
    );

    await expect(makeProvider().fetchRates('2026-10-01')).resolves.toEqual({
      base: 'USD',
      rates: { COP: 4000 },
    });

    expect(PROVIDER_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://oer.test/api/historical/2026-10-01.json?app_id=app-id&base=USD',
    );
    expect(init.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('un HTTP distinto de 2xx: «sin tasa» con el estado y SIN el cuerpo', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":true,"description":"secreto del proveedor"}', {
        status: 400,
      }),
    );
    const error = (await makeProvider()
      .fetchRates('2099-01-01')
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ExchangeRateUnavailableError);
    expect(error.message).toContain('400');
    expect(error.message).not.toContain('secreto');
  });

  it('el tiempo agotado (o la red) es «sin tasa», sin el mensaje del error', async () => {
    fetchMock.mockRejectedValue(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
    const error = (await makeProvider()
      .fetchRates('2026-10-01')
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ExchangeRateUnavailableError);
    expect(error.message).toContain('TimeoutError');
    expect(error.message).not.toContain('aborted');
  });

  it('un cuerpo que no es JSON es «sin tasa», no un 500', async () => {
    fetchMock.mockResolvedValue(new Response('<html>caído</html>'));
    await expect(
      makeProvider().fetchRates('2026-10-01'),
    ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
  });

  it('sin EXCHANGE_APP_ID no llama', async () => {
    await expect(
      makeProvider({ EXCHANGE_APP_ID: '' }).fetchRates('2026-10-01'),
    ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
