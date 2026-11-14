import { config } from 'dotenv';

/**
 * DX-071: guarda de la base de datos de las suites `test:int` y `test:e2e`.
 *
 * Las suites siembran y BORRAN filas de todos los tenants con el rol owner
 * (DIRECT_URL). Si una variable apuntara a la base de desarrollo (`dentalix`)
 * o a cualquier otra que no sea de test, una corrida la vaciaría. Por eso,
 * antes de que nada abra una conexión, se exige que la base de DATABASE_URL y
 * de DIRECT_URL termine en `_test`.
 *
 * Es el único punto común: lo llaman el globalSetup (una vez, en el proceso
 * padre, antes de lanzar ningún fichero) y los setupFiles de e2e e int (en cada
 * fichero, antes de importar el spec). Así cubre también los specs que abren su
 * propio `new PrismaClient(...)`/`pg.Client` a nivel de módulo.
 */

export const TEST_DB_URL_VARS = ['DATABASE_URL', 'DIRECT_URL'] as const;
export const TEST_DB_SUFFIX = '_test';

/** Nombre de la base de una URL de Postgres, o `null` si no se puede leer. */
export function databaseNameOf(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  return name === '' ? null : name;
}

/**
 * Devuelve los problemas encontrados (vacío si todo es de test). Los mensajes
 * nombran la variable y la base, nunca la URL entera: llevaría la contraseña.
 */
export function testDatabaseProblems(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  for (const name of TEST_DB_URL_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} no está definida.`);
      continue;
    }
    const db = databaseNameOf(raw);
    if (db === null) {
      problems.push(
        `${name} no es una URL de Postgres válida con base de datos.`,
      );
    } else if (!db.endsWith(TEST_DB_SUFFIX)) {
      problems.push(
        `${name} apunta a la base «${db}», que no termina en «${TEST_DB_SUFFIX}».`,
      );
    }
  }
  return problems;
}

export class TestDatabaseGuardError extends Error {
  constructor(problems: string[]) {
    super(
      [
        'DX-071: suite abortada antes de conectarse a la base de datos.',
        ...problems.map((p) => `  - ${p}`),
        `Las suites int/e2e borran datos: solo corren contra una base cuyo nombre termine en «${TEST_DB_SUFFIX}».`,
        'Revisa `.env.test` (sobrescribe el entorno del proceso).',
      ].join('\n'),
    );
    this.name = 'TestDatabaseGuardError';
  }
}

export function assertTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const problems = testDatabaseProblems(env);
  if (problems.length > 0) throw new TestDatabaseGuardError(problems);
}

/**
 * Carga `.env.test` SOBRESCRIBIENDO el entorno (una DATABASE_URL exportada en
 * la shell no gana a la de test) y aplica la guarda. Sin `.env.test` (p. ej. un
 * job que pasa las variables por el entorno) se comprueba el entorno tal cual.
 */
export function loadTestEnvAndAssertDatabase(path = '.env.test'): void {
  config({ path, override: true, quiet: true });
  assertTestDatabase();
}
