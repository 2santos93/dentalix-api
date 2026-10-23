import {
  createServer,
  globalAgent,
  type AgentOptions,
  type Server,
} from 'node:http';
import {
  API_HEADERS_TIMEOUT_MS,
  API_KEEP_ALIVE_TIMEOUT_MS,
  applyHttpKeepAlive,
} from './http-keep-alive';

/**
 * DX-284: el proxy `/api/v1` de la web (Next, httpxy) reutiliza conexiones
 * del `http.globalAgent` de Node, que las suelta a los 5 s de inactividad. Con
 * el keep-alive por defecto del servidor (5 s + 1 s de margen de Node), si el
 * bucle de eventos de la web se para más de ~1 s justo cuando vence, reusa
 * una conexión que la API ya cerró: ECONNRESET → 500 «No pudimos cargar…».
 */
describe('applyHttpKeepAlive', () => {
  let server: Server;

  beforeEach(() => {
    server = createServer();
  });

  it('mantiene las conexiones ociosas mucho más que el agente de Node que hace de proxy', () => {
    applyHttpKeepAlive(server);

    // Node 22: keepAlive y 5 s de inactividad en el agente global.
    const { options } = globalAgent as unknown as { options: AgentOptions };
    const clientIdleMs = options.timeout ?? 5_000;
    expect(server.keepAliveTimeout).toBe(API_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(clientIdleMs * 10);
  });

  it('las cabeceras esperan más que el keep-alive y menos que la petición entera', () => {
    applyHttpKeepAlive(server);

    expect(server.headersTimeout).toBe(API_HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });
});
