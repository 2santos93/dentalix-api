import { createServer, type Server, type Socket } from 'node:net';

/**
 * DX-259: un «S3» que acepta la conexión TCP y nunca responde (como un MinIO
 * en pausa o un proveedor degradado). Cuenta los sockets abiertos para
 * comprobar que el cliente los cierra al vencer su plazo. No necesita docker:
 * vale igual en la CI.
 */
export interface HungTcpServer {
  endpoint: string;
  /** Conexiones que siguen abiertas ahora mismo. */
  openSockets(): number;
  /** Conexiones aceptadas desde que arrancó. */
  accepted(): number;
  close(): Promise<void>;
}

/** `port` 0 = uno libre cualquiera. */
export async function startHungTcpServer(port = 0): Promise<HungTcpServer> {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    // Lee y descarta lo que llegue (la petición), sin contestar nunca.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(port, '127.0.0.1', resolve),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('El servidor TCP de prueba no tiene puerto');
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    openSockets: () => sockets.size,
    accepted: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Espera (sondeando) a que `check` sea cierto, o falla al pasar `timeoutMs`. */
export async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`No se cumplió la condición en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return Date.now() - started;
}
