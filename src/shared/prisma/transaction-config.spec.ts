import {
  DEFAULT_TENANT_TX_MAX_WAIT_MS,
  DEFAULT_TENANT_TX_TIMEOUT_MS,
  loadTransactionConfig,
  transactionConfigFor,
  transactionConfigProblems,
} from './transaction-config';

const envOf =
  (env: Record<string, string | undefined>) =>
  (key: string): string | undefined =>
    env[key];

describe('loadTransactionConfig (DX-431)', () => {
  it('sin variables: los valores recomendados (5 s de transacción, 2 s esperando conexión)', () => {
    expect(loadTransactionConfig(envOf({}))).toEqual({
      timeoutMs: 5_000,
      maxWaitMs: 2_000,
    });
    expect(DEFAULT_TENANT_TX_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_TENANT_TX_MAX_WAIT_MS).toBe(2_000);
  });

  it('lee TENANT_TX_TIMEOUT_MS y TENANT_TX_MAX_WAIT_MS', () => {
    expect(
      loadTransactionConfig(
        envOf({
          TENANT_TX_TIMEOUT_MS: '8000',
          TENANT_TX_MAX_WAIT_MS: ' 3000 ',
        }),
      ),
    ).toEqual({ timeoutMs: 8_000, maxWaitMs: 3_000 });
  });

  it('sin variables ni nada que leer, los recomendados', () => {
    expect(loadTransactionConfig(() => undefined)).toEqual({
      timeoutMs: DEFAULT_TENANT_TX_TIMEOUT_MS,
      maxWaitMs: DEFAULT_TENANT_TX_MAX_WAIT_MS,
    });
  });
});

describe('transactionConfigProblems (DX-431)', () => {
  const SHUTDOWN_MS = 25_000;

  it('sin variables no hay problemas', () => {
    expect(transactionConfigProblems(envOf({}), SHUTDOWN_MS)).toEqual([]);
  });

  it.each([
    ['TENANT_TX_TIMEOUT_MS', 'abc'],
    ['TENANT_TX_TIMEOUT_MS', '499'],
    ['TENANT_TX_TIMEOUT_MS', '120001'],
    ['TENANT_TX_MAX_WAIT_MS', '99'],
    ['TENANT_TX_MAX_WAIT_MS', '60001'],
    ['TENANT_TX_MAX_WAIT_MS', '2s'],
  ])('%s=%s no es un entero dentro de su rango', (key, value) => {
    expect(
      transactionConfigProblems(envOf({ [key]: value }), SHUTDOWN_MS),
    ).toEqual([
      expect.stringMatching(new RegExp(`^${key} debe ser un entero entre`)),
    ]);
  });

  it('la transacción tiene que caber en el apagado ordenado (SHUTDOWN_TIMEOUT_MS)', () => {
    expect(
      transactionConfigProblems(
        envOf({ TENANT_TX_TIMEOUT_MS: '25000' }),
        SHUTDOWN_MS,
      ),
    ).toEqual([
      expect.stringContaining(
        'TENANT_TX_TIMEOUT_MS (25000) debe ser menor que SHUTDOWN_TIMEOUT_MS (25000)',
      ),
    ]);
    expect(
      transactionConfigProblems(
        envOf({ TENANT_TX_TIMEOUT_MS: '24999' }),
        SHUTDOWN_MS,
      ),
    ).toEqual([]);
  });
});

describe('transactionConfigFor (DX-431): lo que usa PrismaService', () => {
  const KEYS = ['TENANT_TX_TIMEOUT_MS', 'TENANT_TX_MAX_WAIT_MS'] as const;
  const saved = KEYS.map((key) => process.env[key]);

  afterEach(() => {
    KEYS.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    });
  });

  it('con ConfigService, lo lee de él', () => {
    process.env.TENANT_TX_TIMEOUT_MS = '9000';
    const config = {
      get: (key: string) =>
        key === 'TENANT_TX_TIMEOUT_MS' ? '7000' : undefined,
    };
    expect(transactionConfigFor(config)).toEqual({
      timeoutMs: 7_000,
      maxWaitMs: DEFAULT_TENANT_TX_MAX_WAIT_MS,
    });
  });

  it('sin ConfigService (scripts e int-specs que crean PrismaService a mano), lo lee de process.env', () => {
    process.env.TENANT_TX_TIMEOUT_MS = '9000';
    process.env.TENANT_TX_MAX_WAIT_MS = '4000';
    expect(transactionConfigFor(undefined)).toEqual({
      timeoutMs: 9_000,
      maxWaitMs: 4_000,
    });
  });
});
