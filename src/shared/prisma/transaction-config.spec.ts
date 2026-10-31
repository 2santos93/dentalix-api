import {
  DEFAULT_TENANT_TX_MAX_WAIT_MS,
  DEFAULT_TENANT_TX_TIMEOUT_MS,
  loadTransactionConfig,
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

  it('sin ConfigService (int-specs que crean PrismaService a mano), los recomendados', () => {
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
