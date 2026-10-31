import {
  E2E_PRODUCTION_TIMEOUTS,
  restoreProductionTimeoutsEnv,
} from './support/with-production-timeouts-env';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SkipThrottle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import {
  STATEMENT_TIMEOUT_MESSAGE,
  TRANSACTION_TIMEOUT_MESSAGE,
} from '../src/shared/prisma/prisma-exception.filter';

// DX-431 (OPS-011, OPS-012): con plazos de producción bajos
// (support/with-production-timeouts-env.ts), la app montada como main.ts
// (configureApp) corta a un cliente lento con 408, y una transacción que pasa
// de TENANT_TX_TIMEOUT_MS sale como 503 tipado en español, sin 500 genérico y
// sin dejar el pool tomado.

const REQUEST_TIMEOUT_MS = Number(
  E2E_PRODUCTION_TIMEOUTS.HTTP_REQUEST_TIMEOUT_MS,
);
const HEADERS_TIMEOUT_MS = Number(
  E2E_PRODUCTION_TIMEOUTS.HTTP_HEADERS_TIMEOUT_MS,
);
const TX_TIMEOUT_MS = Number(E2E_PRODUCTION_TIMEOUTS.TENANT_TX_TIMEOUT_MS);
/** Holgura para el reloj de Node (revisa cada décima parte del plazo). */
const SLACK_MS = 1_500;

@SkipThrottle()
@Controller('test-tx-timeout')
class TransactionTimeoutController {
  constructor(private readonly prisma: PrismaService) {}

  /** Una transacción que tarda el triple que TENANT_TX_TIMEOUT_MS. */
  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await this.prisma.runWithTenant(randomUUID(), async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_sleep(${(3 * TX_TIMEOUT_MS) / 1000})`,
      );
    });
    return { done: true };
  }

  /** La misma, con su propio `timeout` (los lotes de DX-107): no la corta. */
  @Get('slow-with-own-timeout')
  async slowWithOwnTimeout(): Promise<{ done: true }> {
    await this.prisma.runWithTenant(
      randomUUID(),
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_sleep(${(2 * TX_TIMEOUT_MS) / 1000})`,
        );
      },
      { timeout: 10 * TX_TIMEOUT_MS },
    );
    return { done: true };
  }

  /**
   * El `statement_timeout` de `dentalix_app` (15 s en producción) bajado a
   * 100 ms SOLO en esta transacción: Postgres cancela la sentencia (57014).
   */
  @Get('slow-statement')
  async slowStatement(): Promise<{ done: true }> {
    await this.prisma.runWithTenant(randomUUID(), async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '100ms'`);
      await tx.$executeRawUnsafe('SELECT pg_sleep(1)');
    });
    return { done: true };
  }

  @Get('fast')
  async fast(): Promise<{ done: true }> {
    await this.prisma.runWithTenant(randomUUID(), async (tx) => {
      await tx.$executeRawUnsafe('SELECT 1');
    });
    return { done: true };
  }
}

interface RawReply {
  /** Lo que respondió el servidor (vacío si cerró sin responder). */
  raw: string;
  elapsedMs: number;
}

/**
 * Cliente HTTP lento a mano: escribe `chunk` y no manda nada más hasta que el
 * servidor responda y cierre. Sin sleeps: se espera al servidor.
 */
function slowClient(port: number, chunk: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let raw = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(chunk));
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => (raw += data));
    socket.on('error', reject);
    socket.on('close', () => resolve({ raw, elapsedMs: Date.now() - started }));
  });
}

describe('Límites de producción: timeouts HTTP y de transacción (DX-431, e2e)', () => {
  let app: INestApplication<App>;
  let port: number;

  beforeAll(async () => {
    app = await createE2eApp({ controllers: [TransactionTimeoutController] });
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    restoreProductionTimeoutsEnv();
  });

  describe('HTTP_REQUEST_TIMEOUT_MS y HTTP_HEADERS_TIMEOUT_MS', () => {
    it('main.ts y los e2e aplican al servidor los plazos del entorno', () => {
      const server = app.getHttpServer() as Server;
      expect(server.keepAliveTimeout).toBe(1_000);
      expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    });

    it('un cuerpo que no termina de llegar se corta con 408 al vencer HTTP_REQUEST_TIMEOUT_MS', async () => {
      const reply = await slowClient(
        port,
        [
          'POST /api/v1/auth/login HTTP/1.1',
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          'Content-Length: 200',
          '',
          '{"email":"lento@',
        ].join('\r\n'),
      );

      expect(reply.raw).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
      expect(reply.elapsedMs).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
      expect(reply.elapsedMs).toBeLessThan(REQUEST_TIMEOUT_MS + SLACK_MS);
    });

    it('unas cabeceras que no terminan se cortan con 408 al vencer HTTP_HEADERS_TIMEOUT_MS', async () => {
      const reply = await slowClient(
        port,
        'GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\n',
      );

      expect(reply.raw).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
      expect(reply.elapsedMs).toBeGreaterThanOrEqual(HEADERS_TIMEOUT_MS);
      expect(reply.elapsedMs).toBeLessThan(REQUEST_TIMEOUT_MS);
    });

    it('una petición normal no se ve afectada', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    });

    it('un valor inválido impide arrancar la app con un mensaje claro', async () => {
      const previous = process.env.HTTP_REQUEST_TIMEOUT_MS;
      process.env.HTTP_REQUEST_TIMEOUT_MS = '30s';
      try {
        let compile: Promise<unknown> = Promise.resolve();
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { AppModule } = require('../src/app.module') as {
            AppModule: new () => unknown;
          };
          compile = Test.createTestingModule({
            imports: [AppModule],
          }).compile();
        });
        await expect(compile).rejects.toThrow(
          /la API no arranca:[\s\S]*- HTTP_REQUEST_TIMEOUT_MS debe ser un entero entre 1000 y 3600000/,
        );
      } finally {
        process.env.HTTP_REQUEST_TIMEOUT_MS = previous;
      }
    });
  });

  describe('TENANT_TX_TIMEOUT_MS', () => {
    it('una transacción que lo excede aborta con 503 TRANSACTION_TIMEOUT en español, no con un 500', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-tx-timeout/slow')
        .expect(503)
        .expect('Retry-After', '5');

      expect(res.body).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'TRANSACTION_TIMEOUT',
        message: TRANSACTION_TIMEOUT_MESSAGE,
        requestId: expect.any(String) as unknown,
      });
      expect(TRANSACTION_TIMEOUT_MESSAGE).toBe(
        'La operación tardó demasiado y se canceló sin guardar cambios. Vuelve a intentarlo en unos segundos.',
      );
    });

    it('una sentencia cortada por statement_timeout (57014) responde 503 STATEMENT_TIMEOUT, no un 500', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-tx-timeout/slow-statement')
        .expect(503)
        .expect('Retry-After', '5');

      expect(res.body).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'STATEMENT_TIMEOUT',
        message: STATEMENT_TIMEOUT_MESSAGE,
        requestId: expect.any(String) as unknown,
      });
    });

    it('una transacción dentro del plazo responde 200, y el pool sigue libre tras el corte', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/test-tx-timeout/fast')
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .expect(200);
    });

    it('un `timeout` propio de la llamada (lotes acotados, DX-107) sigue mandando sobre el del entorno', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/test-tx-timeout/slow-with-own-timeout')
        .expect(200, { done: true });
    });
  });
});
