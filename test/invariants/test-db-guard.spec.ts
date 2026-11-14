import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assertTestDatabase,
  databaseNameOf,
  TestDatabaseGuardError,
  testDatabaseProblems,
} from '../support/test-db-guard';

// DX-071: la guarda que impide correr test:int/test:e2e contra una base que no
// sea de test (ver test/support/test-db-guard.ts).

const ok = 'postgres://u:p@h:5/x_test';

function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { DATABASE_URL: ok, DIRECT_URL: ok, ...vars };
}

describe('guarda de la base de test (DX-071)', () => {
  it('deja pasar una base que termina en _test', () => {
    expect(testDatabaseProblems(env({}))).toEqual([]);
    expect(() => assertTestDatabase(env({}))).not.toThrow();
  });

  it('deja pasar una URL con ?schema= y otros parámetros', () => {
    const url =
      'postgresql://dentalix_app:secreto@127.0.0.1:55432/dentalix_dx071_test?schema=public&connection_limit=5';
    expect(databaseNameOf(url)).toBe('dentalix_dx071_test');
    expect(() =>
      assertTestDatabase(env({ DATABASE_URL: url, DIRECT_URL: url })),
    ).not.toThrow();
  });

  it('aborta si DATABASE_URL apunta a la base de desarrollo', () => {
    const run = () =>
      assertTestDatabase(
        env({ DATABASE_URL: 'postgres://u:supersecreta@h:5/dentalix' }),
      );
    expect(run).toThrow(TestDatabaseGuardError);
    expect(run).toThrow(/DATABASE_URL apunta a la base «dentalix»/);
  });

  it('aborta si DIRECT_URL es la equivocada aunque DATABASE_URL esté bien', () => {
    expect(() =>
      assertTestDatabase(
        env({
          DIRECT_URL: 'postgresql://dentalix:pw@h:5/dentalix?schema=public',
        }),
      ),
    ).toThrow(/DIRECT_URL apunta a la base «dentalix»/);
  });

  it('no deja pasar un nombre que solo contiene _test sin terminar en él', () => {
    expect(
      testDatabaseProblems(
        env({ DATABASE_URL: 'postgres://u:p@h:5/x_test_copy' }),
      ),
    ).toHaveLength(1);
  });

  it('aborta si falta la variable, la URL no se puede leer o no trae base', () => {
    expect(testDatabaseProblems(env({ DIRECT_URL: undefined }))).toEqual([
      'DIRECT_URL no está definida.',
    ]);
    expect(
      testDatabaseProblems(env({ DATABASE_URL: 'no es una url' })),
    ).toEqual([
      'DATABASE_URL no es una URL de Postgres válida con base de datos.',
    ]);
    expect(
      testDatabaseProblems(env({ DATABASE_URL: 'postgres://u:p@h:5/' })),
    ).toHaveLength(1);
  });

  it('nombra las dos variables a la vez y nunca la contraseña', () => {
    let message = '';
    try {
      assertTestDatabase({
        DATABASE_URL: 'postgres://app:clave-app@h:5/dentalix',
        DIRECT_URL: 'postgres://owner:clave-owner@h:5/produccion',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL apunta a la base «dentalix»/);
    expect(message).toMatch(/DIRECT_URL apunta a la base «produccion»/);
    expect(message).not.toMatch(/clave-app|clave-owner/);
  });

  it.each(['jest-int.json', 'jest-e2e.json'])(
    '%s pasa por la guarda en el globalSetup y en su setupFile',
    (file) => {
      const cfg = JSON.parse(
        readFileSync(join(__dirname, '..', file), 'utf8'),
      ) as { globalSetup?: string; setupFiles?: string[] };
      expect(cfg.globalSetup).toBe('<rootDir>/test/global-setup-db-guard.ts');
      const setup = cfg.setupFiles?.find((f) => /setup-(int|e2e)\.ts$/.test(f));
      expect(setup).toBeDefined();
      const source = readFileSync(
        join(__dirname, '..', '..', setup!.replace('<rootDir>/', '')),
        'utf8',
      );
      expect(source).toMatch(/^loadTestEnvAndAssertDatabase\(\);$/m);
    },
  );
});
