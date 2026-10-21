import { INestApplication } from '@nestjs/common';
import { Agent, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';

export interface ListeningApp {
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  close: () => Promise<void>;
}

/**
 * DX-252 (TST-029): `request(app.getHttpServer())` con el servidor sin
 * escuchar hace que supertest abra (y cierre) un servidor efímero POR
 * PETICIÓN; con varias en paralelo y la máquina cargada eso acaba en
 * `read ECONNRESET`. Aquí la app escucha UNA vez en un puerto efímero
 * (`listen(0)`, solo 127.0.0.1) y todas las peticiones pasan por un agente
 * HTTP sin keep-alive (sin carreras con el `keepAliveTimeout` del servidor)
 * con `maxSockets` acotado: las de más esperan turno en el agente en vez de
 * abrir conexiones sin límite.
 */
export async function listenOnEphemeralPort(
  app: INestApplication<App>,
  maxSockets = 5,
): Promise<ListeningApp> {
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;
  const base = request(`http://127.0.0.1:${port}`);
  const agent = new Agent({ keepAlive: false, maxSockets });
  return {
    get: (path) => base.get(path).agent(agent),
    post: (path) => base.post(path).agent(agent),
    close: async () => {
      agent.destroy();
      await app.close();
    },
  };
}

/**
 * `Promise.all` que no deja peticiones en vuelo: espera a TODAS antes de
 * propagar el primer error. Con `Promise.all`, un rechazo temprano termina el
 * test mientras las demás siguen escribiendo en la BD y el test siguiente
 * hereda ese estado.
 */
export async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
