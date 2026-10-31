import {
  createServer,
  globalAgent,
  type AgentOptions,
  type Server,
} from 'node:http';
import {
  DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  applyHttpServerTimeouts,
  connectionsCheckingIntervalMs,
  httpServerTimeoutProblems,
  loadHttpServerTimeouts,
} from './http-server-timeouts';

const envOf =
  (env: Record<string, string | undefined>) =>
  (key: string): string | undefined =>
    env[key];

describe('loadHttpServerTimeouts (DX-431)', () => {
  it('sin variables: keep-alive 65 s, cabeceras 66 s y petición entera 130 s', () => {
    expect(loadHttpServerTimeouts(envOf({}))).toEqual({
      keepAliveTimeoutMs: 65_000,
      headersTimeoutMs: 66_000,
      requestTimeoutMs: 130_000,
    });
    expect(DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(DEFAULT_HTTP_REQUEST_TIMEOUT_MS).toBe(130_000);
  });

  it('lee los tres valores del entorno', () => {
    expect(
      loadHttpServerTimeouts(
        envOf({
          HTTP_KEEP_ALIVE_TIMEOUT_MS: '75000',
          HTTP_HEADERS_TIMEOUT_MS: '80000',
          HTTP_REQUEST_TIMEOUT_MS: ' 200000 ',
        }),
      ),
    ).toEqual({
      keepAliveTimeoutMs: 75_000,
      headersTimeoutMs: 80_000,
      requestTimeoutMs: 200_000,
    });
  });

  it('sin HTTP_HEADERS_TIMEOUT_MS, las cabeceras esperan 1 s más que el keep-alive configurado', () => {
    expect(
      loadHttpServerTimeouts(envOf({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '90000' }))
        .headersTimeoutMs,
    ).toBe(91_000);
  });
});

describe('httpServerTimeoutProblems (DX-431)', () => {
  it('sin variables no hay problemas, tampoco en producción', () => {
    expect(httpServerTimeoutProblems(envOf({}), false)).toEqual([]);
    expect(httpServerTimeoutProblems(envOf({}), true)).toEqual([]);
  });

  it.each([
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', 'abc'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '999'],
    ['HTTP_KEEP_ALIVE_TIMEOUT_MS', '600001'],
    ['HTTP_HEADERS_TIMEOUT_MS', '-1'],
    ['HTTP_HEADERS_TIMEOUT_MS', '1.5'],
    ['HTTP_REQUEST_TIMEOUT_MS', '0'],
    ['HTTP_REQUEST_TIMEOUT_MS', '3600001'],
    ['HTTP_REQUEST_TIMEOUT_MS', '60s'],
  ])('%s=%s no es un entero dentro de su rango', (key, value) => {
    const problems = httpServerTimeoutProblems(envOf({ [key]: value }), false);
    expect(problems).toEqual([
      expect.stringMatching(new RegExp(`^${key} debe ser un entero entre`)),
    ]);
  });

  it('las cabeceras tienen que esperar MÁS que el keep-alive', () => {
    const problems = httpServerTimeoutProblems(
      envOf({
        HTTP_KEEP_ALIVE_TIMEOUT_MS: '70000',
        HTTP_HEADERS_TIMEOUT_MS: '70000',
      }),
      false,
    );
    expect(problems).toEqual([
      expect.stringContaining(
        'HTTP_HEADERS_TIMEOUT_MS (70000) debe ser mayor que HTTP_KEEP_ALIVE_TIMEOUT_MS (70000)',
      ),
    ]);
  });

  it('la petición entera no puede tener menos plazo que las cabeceras (también con el default derivado)', () => {
    expect(
      httpServerTimeoutProblems(
        envOf({ HTTP_REQUEST_TIMEOUT_MS: '60000' }),
        false,
      ),
    ).toEqual([
      expect.stringContaining(
        'HTTP_REQUEST_TIMEOUT_MS (60000) debe ser mayor o igual que HTTP_HEADERS_TIMEOUT_MS (66000)',
      ),
    ]);
  });

  it('en producción la petición entera tiene que durar más que la subida más larga (UPLOAD_MAX_DURATION_MS)', () => {
    const env = envOf({ HTTP_REQUEST_TIMEOUT_MS: '120000' });
    expect(httpServerTimeoutProblems(env, false)).toEqual([]);
    expect(httpServerTimeoutProblems(env, true)).toEqual([
      expect.stringContaining(
        'HTTP_REQUEST_TIMEOUT_MS (120000) debe ser mayor que UPLOAD_MAX_DURATION_MS (120000)',
      ),
    ]);
    expect(
      httpServerTimeoutProblems(
        envOf({
          HTTP_REQUEST_TIMEOUT_MS: '120000',
          UPLOAD_MAX_DURATION_MS: '60000',
        }),
        true,
      ),
    ).toEqual([]);
  });

  it('un valor inválido no arrastra errores de relación con los demás', () => {
    expect(
      httpServerTimeoutProblems(
        envOf({
          HTTP_KEEP_ALIVE_TIMEOUT_MS: 'x',
          HTTP_REQUEST_TIMEOUT_MS: '1',
        }),
        true,
      ),
    ).toHaveLength(2);
  });
});

describe('connectionsCheckingIntervalMs (DX-431)', () => {
  it('revisa los plazos con una décima parte del menor, entre 100 ms y los 30 s de Node', () => {
    const t = (headersTimeoutMs: number, requestTimeoutMs: number) =>
      connectionsCheckingIntervalMs({
        keepAliveTimeoutMs: 1_000,
        headersTimeoutMs,
        requestTimeoutMs,
      });
    expect(t(66_000, 130_000)).toBe(6_600);
    expect(t(1_500, 2_000)).toBe(150);
    expect(t(500, 500)).toBe(100);
    expect(t(600_000, 3_600_000)).toBe(30_000);
  });
});

/**
 * DX-284: el proxy `/api/v1` de la web (Next, httpxy) reutiliza conexiones
 * del `http.globalAgent` de Node, que las suelta a los 5 s de inactividad. Con
 * el keep-alive por defecto del servidor (5 s + 1 s de margen de Node), si el
 * bucle de eventos de la web se para más de ~1 s justo cuando vence, reusa
 * una conexión que la API ya cerró: ECONNRESET → 500 «No pudimos cargar…».
 */
describe('applyHttpServerTimeouts', () => {
  let server: Server;

  beforeEach(() => {
    server = createServer();
  });

  it('por defecto mantiene las conexiones ociosas mucho más que el agente de Node que hace de proxy', () => {
    applyHttpServerTimeouts(server, loadHttpServerTimeouts(envOf({})));

    // Node 22: keepAlive y 5 s de inactividad en el agente global.
    const { options } = globalAgent as unknown as { options: AgentOptions };
    const clientIdleMs = options.timeout ?? 5_000;
    expect(server.keepAliveTimeout).toBe(DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(clientIdleMs * 10);
  });

  it('las cabeceras esperan más que el keep-alive y menos que la petición entera', () => {
    applyHttpServerTimeouts(server, loadHttpServerTimeouts(envOf({})));

    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });

  it('aplica los tres plazos configurados y la cadencia con la que Node los revisa', () => {
    applyHttpServerTimeouts(server, {
      keepAliveTimeoutMs: 1_000,
      headersTimeoutMs: 1_500,
      requestTimeoutMs: 2_000,
    });

    expect(server.keepAliveTimeout).toBe(1_000);
    expect(server.headersTimeout).toBe(1_500);
    expect(server.requestTimeout).toBe(2_000);
    // Sin esto, Node revisa cada 30 s y un plazo de 2 s cortaría a los 32 s.
    expect(
      (server as Server & { connectionsCheckingInterval: number })
        .connectionsCheckingInterval,
    ).toBe(150);
  });
});
