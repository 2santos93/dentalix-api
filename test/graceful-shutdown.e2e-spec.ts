import { Controller, Get, INestApplication } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { Agent, get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { waitFor } from './support/wait-for';
import {
  installGracefulShutdown,
  type ShutdownProcess,
} from '../src/config/graceful-shutdown';
import { PrismaService } from '../src/shared/prisma/prisma.service';

// DX-083 (OPS-004, OPS-022): con SIGTERM la readiness da 503 ANTES de cerrar
// nada, la petición en vuelo (con su transacción de tenant abierta) termina
// en 200, el servidor HTTP se cierra antes de `$disconnect` y el proceso
// sale con código 0.

/** Transacción de tenant que tarda: `pg_sleep` dentro de `runWithTenant`. */
const SLOW_MS = 1500;
let slowStarted: () => void = () => undefined;

@SkipThrottle()
@Controller('test-shutdown')
class SlowTransactionController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await this.prisma.runWithTenant(randomUUID(), async (tx) => {
      slowStarted();
      await tx.$executeRawUnsafe(`SELECT pg_sleep(${SLOW_MS / 1000})`);
    });
    return { done: true };
  }
}

interface Reply {
  status: number;
  body: string;
}

/** GET con keep-alive (como el proxy de la web) para ver que no frena el cierre. */
function get(port: number, path: string, agent: Agent): Promise<Reply> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('Apagado ordenado con SIGTERM (DX-083, e2e)', () => {
  let app: INestApplication<App>;
  let port: number;
  const agent = new Agent({ keepAlive: true });
  const exit = jest.fn<void, [number]>();
  const listeners = new Map<string, () => void>();
  const proc: ShutdownProcess = {
    once: (signal, listener) => listeners.set(signal, listener),
    exit,
  };

  beforeAll(async () => {
    app = await createE2eApp({ controllers: [SlowTransactionController] });
    port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
  });

  afterAll(() => agent.destroy());

  it('readiness 503 al momento, la transacción en vuelo acaba en 200 y el HTTP cierra antes que Prisma', async () => {
    const server = app.getHttpServer() as Server;
    const prisma = app.get(PrismaService);
    const events: string[] = [];
    server.once('close', () => events.push('http.closed'));
    const disconnect = prisma.$disconnect.bind(prisma);
    jest.spyOn(prisma, '$disconnect').mockImplementation(async () => {
      events.push(`prisma.disconnect(listening=${server.listening})`);
      await disconnect();
    });

    const { shutdown } = installGracefulShutdown(
      app,
      { drainMs: 400, timeoutMs: 10_000 },
      proc,
    );
    expect([...listeners.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

    await expect(get(port, '/api/v1/health/ready', agent)).resolves.toEqual({
      status: 200,
      body: JSON.stringify({ status: 'ok', database: 'up' }),
    });

    const started = new Promise<void>((resolve) => (slowStarted = resolve));
    const inFlight = get(port, '/api/v1/test-shutdown/slow', agent);
    await started;

    // La señal, como la mandaría el orquestador.
    listeners.get('SIGTERM')?.();
    const done = shutdown('SIGTERM');

    // Durante el drenado la API sigue atendiendo, pero la readiness da 503.
    const ready = await get(port, '/api/v1/health/ready', new Agent());
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'draining' });
    const live = await get(port, '/api/v1/health', new Agent());
    expect(live.status).toBe(200);

    await expect(inFlight).resolves.toEqual({
      status: 200,
      body: JSON.stringify({ done: true }),
    });
    await done;

    expect(exit).toHaveBeenCalledWith(0);
    expect(events).toEqual([
      'http.closed',
      'prisma.disconnect(listening=false)',
    ]);
    // Nadie más entra: el puerto ya no escucha.
    await waitFor(() => !server.listening, 'el servidor deja de escuchar');
    await expect(
      get(port, '/api/v1/health', new Agent()),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
