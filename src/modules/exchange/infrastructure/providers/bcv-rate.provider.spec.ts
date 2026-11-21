import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import {
  ExchangeRateProviderNotRespondingError,
  ExchangeRateUnavailableError,
} from '../../domain/ports/exchange-rate-provider.port';
import { BcvOfficialRateProvider } from './bcv-rate.provider';
import { getText } from './bcv-http';

// DX-585: un servidor HTTP falso en 127.0.0.1 hace de BCV y de respaldo; los
// tests nunca consultan la red real.
const PAGE = readFileSync(
  join(__dirname, '__fixtures__', 'bcv-home-2026-11-21.html'),
  'utf8',
);
const SECRET_BODY = 'cuerpo-secreto-del-proveedor';

type Route = { status: number; body: string; delayMs?: number };

const USD_FALLBACK = JSON.stringify({
  fuente: 'oficial',
  nombre: 'Oficial',
  compra: null,
  venta: null,
  promedio: 918.7662,
  fechaActualizacion: '2026-11-21T00:00:00-04:00',
});
const EUR_FALLBACK = JSON.stringify([
  {
    fuente: 'oficial',
    promedio: 1011.17949056,
    fechaActualizacion: '2026-11-21T00:00:00-04:00',
  },
  {
    fuente: 'paralelo',
    promedio: 1250,
    fechaActualizacion: '2026-11-21T12:00:00-04:00',
  },
]);

describe('BcvOfficialRateProvider (DX-585)', () => {
  let server: Server;
  let base: string;
  let routes: Record<string, Route>;
  const hits: string[] = [];
  const now = new Date('2026-11-21T19:00:00.000Z');

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const route = routes[req.url ?? ''] ?? { status: 404, body: 'no' };
      const send = () => {
        res.writeHead(route.status, { 'content-type': 'text/plain' });
        res.end(route.body);
      };
      if (route.delayMs) setTimeout(send, route.delayMs);
      else send();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let warn: jest.SpyInstance;
  beforeEach(() => {
    hits.length = 0;
    routes = {
      '/bcv/': { status: 200, body: PAGE },
      '/fb/v1/dolares/oficial': { status: 200, body: USD_FALLBACK },
      '/fb/v1/euros': { status: 200, body: EUR_FALLBACK },
    };
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const provider = (env: Record<string, string> = {}) =>
    new BcvOfficialRateProvider(
      {
        get: (key: string) =>
          ({
            BCV_BASE_URL: `${base}/bcv`,
            BCV_FALLBACK_BASE_URL: `${base}/fb/`,
            ...env,
          })[key],
      } as unknown as ConfigService,
      () => now,
    );

  it('lee la página oficial y no toca el respaldo', async () => {
    await expect(provider().fetchLatest()).resolves.toEqual({
      usdVes: 919.8227,
      eurVes: 1011.17949056,
      valueDate: '2026-11-24',
      fetchedAt: now,
      origin: 'BCV',
    });
    expect(hits).toEqual(['/bcv/']);
  });

  it('si la oficial da 500, usa el respaldo (campo promedio, la «oficial» de la lista de euros)', async () => {
    routes['/bcv/'] = { status: 500, body: SECRET_BODY };
    await expect(provider().fetchLatest()).resolves.toEqual({
      usdVes: 918.7662,
      eurVes: 1011.17949056,
      valueDate: '2026-11-21',
      fetchedAt: now,
      origin: 'FALLBACK',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'exchange.bcv_official_failed' }),
    );
  });

  it('si la oficial cambió de forma, usa el respaldo', async () => {
    routes['/bcv/'] = { status: 200, body: '<html>Mantenimiento</html>' };
    const rate = await provider().fetchLatest();
    expect(rate.origin).toBe('FALLBACK');
    expect(warn).toHaveBeenCalledWith({
      event: 'exchange.bcv_official_failed',
      reason: 'falta el bloque #dolar',
    });
  });

  it('el respaldo con /v1/euros como objeto también vale', async () => {
    routes['/bcv/'] = { status: 503, body: '' };
    routes['/fb/v1/euros'] = {
      status: 200,
      body: JSON.stringify({
        fuente: 'oficial',
        promedio: 1011.5,
        fechaActualizacion: '2026-11-21T00:00:00-04:00',
      }),
    };
    expect((await provider().fetchLatest()).eurVes).toBe(1011.5);
  });

  it('la fecha valor del respaldo es el día de Caracas (no el UTC)', async () => {
    routes['/bcv/'] = { status: 500, body: '' };
    routes['/fb/v1/dolares/oficial'] = {
      status: 200,
      body: JSON.stringify({
        promedio: 918.7662,
        fechaActualizacion: '2026-11-25T02:00:00.000Z',
      }),
    };
    routes['/fb/v1/euros'] = {
      status: 200,
      body: JSON.stringify([
        {
          fuente: 'oficial',
          promedio: 1011.1,
          fechaActualizacion: '2026-11-24T23:30:00-04:00',
        },
      ]),
    };
    expect((await provider().fetchLatest()).valueDate).toBe('2026-11-24');
  });

  it.each([
    [
      'los dos caídos',
      { status: 500, body: SECRET_BODY },
      { status: 502, body: SECRET_BODY },
    ],
    [
      'respaldo sin promedio',
      { status: 404, body: SECRET_BODY },
      { status: 200, body: '{"fuente":"oficial"}' },
    ],
    [
      'respaldo que no es JSON',
      { status: 500, body: '' },
      { status: 200, body: SECRET_BODY },
    ],
  ])(
    '%s → sin tasa (ExchangeRateUnavailableError), nunca inventada ni con el cuerpo',
    async (_, bcv, usd) => {
      routes['/bcv/'] = bcv;
      routes['/fb/v1/dolares/oficial'] = usd;
      const error = await provider()
        .fetchLatest()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExchangeRateUnavailableError);
      expect((error as Error).message).not.toContain(SECRET_BODY);
      expect((error as Error).message).toMatch(/^Sin tasa del BCV/);
    },
  );

  it('USD y EUR del respaldo de días distintos → sin tasa', async () => {
    routes['/bcv/'] = { status: 500, body: '' };
    routes['/fb/v1/euros'] = {
      status: 200,
      body: JSON.stringify([
        {
          fuente: 'oficial',
          promedio: 1011.1,
          fechaActualizacion: '2026-11-18T00:00:00-04:00',
        },
      ]),
    };
    await expect(provider().fetchLatest()).rejects.toThrow(
      /USD y EUR de días distintos/,
    );
  });

  describe('getText', () => {
    it('corta a los N ms (no responde): no contesta, sin cuerpo', async () => {
      routes['/lento'] = { status: 200, body: 'tarde', delayMs: 2_000 };
      const error = await getText(`${base}/lento`, 'Prueba', 50).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExchangeRateProviderNotRespondingError);
      expect((error as Error).message).toBe('Prueba: plazo agotado');
    });

    it('un 4xx es «sin tasa» y el mensaje solo lleva el estado', async () => {
      routes['/x'] = { status: 403, body: SECRET_BODY };
      const error = await getText(`${base}/x`, 'Prueba').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExchangeRateUnavailableError);
      expect(error).not.toBeInstanceOf(ExchangeRateProviderNotRespondingError);
      expect((error as Error).message).toBe('Prueba devolvió 403');
    });

    it('sin conexión: no contesta, con el código y no el mensaje', async () => {
      const error = await getText('http://127.0.0.1:1/', 'Prueba').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExchangeRateProviderNotRespondingError);
      expect((error as Error).message).toBe(
        'Prueba: sin respuesta (ECONNREFUSED)',
      );
    });

    it('rechaza otro protocolo', async () => {
      await expect(getText('file:///etc/passwd', 'Prueba')).rejects.toThrow(
        'Prueba: protocolo no admitido',
      );
    });
  });
});
