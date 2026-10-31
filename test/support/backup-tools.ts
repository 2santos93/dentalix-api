import { spawnSync } from 'node:child_process';

/**
 * DX-082: los tests de copia y restauración necesitan `pg_dump`,
 * `pg_restore`, `psql`, `age` y `age-keygen` en el PATH y dos conexiones:
 *
 * - origen (`BACKUP_TEST_SOURCE_URL`, por defecto `DIRECT_URL`): un rol que
 *   pueda volcar con FORCE RLS (superusuario o BYPASSRLS). Solo se LEE.
 * - admin (`BACKUP_TEST_ADMIN_URL`, por defecto el origen): superusuario que
 *   crea y borra las bases temporales `dx082_it_*`.
 *
 * En la CI (`dentalix` es el superusuario del servicio postgres:16) valen los
 * valores por defecto. En local, con el owner sin superusuario, se puede usar
 * el socket como `postgres`, p. ej.:
 *   BACKUP_TEST_SOURCE_URL='postgresql:///dentalix_test?host=/var/run/postgresql'
 * ejecutando la suite como el usuario `postgres` del sistema (README, «Copias
 * de la BD»).
 *
 * Si falta algo la suite se SALTA de forma visible (como los tests de S3 de
 * DX-084); con `REQUIRE_BACKUP_TESTS=1` (la CI) faltar algo es un fallo.
 */
export type BackupTestConfig = { sourceUrl: string; adminUrl: string };

const TOOLS = ['pg_dump', 'pg_restore', 'psql', 'age', 'age-keygen'];

/** La URL sin `?schema=` (de Prisma) y, si se da, apuntando a otra base. */
export function pgUrl(url: string, db?: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  if (db) u.pathname = `/${db}`;
  return u.toString();
}

/** Una consulta con psql; devuelve la salida sin alinear ni cabeceras. */
export function psql(url: string, sql: string): string {
  const r = spawnSync(
    'psql',
    [pgUrl(url), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
    {
      input: sql,
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) {
    throw new Error(`psql falló (${r.status}): ${r.stderr.split('\n')[0]}`);
  }
  return r.stdout.trim();
}

function missingReason(): string | null {
  const missing = TOOLS.filter(
    (t) => spawnSync('bash', ['-c', `command -v ${t}`]).status !== 0,
  );
  if (missing.length > 0) return `faltan ${missing.join(', ')} en el PATH`;
  const source = process.env.BACKUP_TEST_SOURCE_URL ?? process.env.DIRECT_URL;
  if (!source) return 'falta BACKUP_TEST_SOURCE_URL o DIRECT_URL';
  const admin = process.env.BACKUP_TEST_ADMIN_URL ?? source;
  try {
    const canDump = psql(
      source,
      'SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    if (canDump !== 't') {
      return 'el rol de origen no es superusuario ni tiene BYPASSRLS (con FORCE RLS no puede volcar)';
    }
    const isSuper = psql(
      admin,
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    if (isSuper !== 't') return 'el rol admin no es superusuario';
  } catch (err) {
    return `no se pudo conectar: ${(err as Error).message}`;
  }
  return null;
}

export function backupTestConfig(): BackupTestConfig | null {
  const reason = missingReason();
  if (reason === null) {
    const sourceUrl = (process.env.BACKUP_TEST_SOURCE_URL ??
      process.env.DIRECT_URL)!;
    return {
      sourceUrl,
      adminUrl: process.env.BACKUP_TEST_ADMIN_URL ?? sourceUrl,
    };
  }
  if (process.env.REQUIRE_BACKUP_TESTS === '1') {
    throw new Error(
      `REQUIRE_BACKUP_TESTS=1 pero los tests de copias no pueden correr: ${reason}.`,
    );
  }
  console.warn(`[DX-082] SALTADO copias y restauración: ${reason}.`);
  return null;
}

/** `describe` con Postgres y age reales, o un `describe.skip` que dice por qué. */
export function describeWithBackupTools(
  name: string,
  fn: (cfg: BackupTestConfig) => void,
): void {
  const cfg = backupTestConfig();
  if (cfg) {
    describe(name, () => fn(cfg));
    return;
  }
  describe.skip(`${name} [SALTADO: faltan herramientas o roles]`, () => {
    it('necesita pg_dump, age y un superusuario', () => undefined);
  });
}
