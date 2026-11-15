/**
 * DX-148: `npm run db:lint-migrations`. Pasa las reglas de
 * prisma/migration-lint.ts por cada migración de prisma/migrations que NO esté
 * en prisma/lint-migrations.baseline (las que ya estaban en main cuando entró
 * el lint; aplicadas, no se pueden editar sin cambiar su checksum).
 *
 *   npm run db:lint-migrations                 lint (sale con 1 si hay fallos)
 *   npm run db:lint-migrations -- --write-baseline [ref]
 *                                              regenera la lista con las
 *                                              migraciones de `ref` (por
 *                                              defecto origin/main) anteriores
 *                                              al corte de DX-148
 *   npm run db:lint-migrations -- fichero.sql  lint de ficheros sueltos
 *
 * La lista solo admite migraciones anteriores a BASELINE_CUTOFF (lo comprueba
 * test/migrations/lint-migrations.spec.ts): una migración nueva no se puede
 * "excusar" añadiéndola; si de verdad necesita saltarse una regla, lo dice en
 * su propio fichero con motivo (`-- lint-migrations: ignore <regla>: <motivo>`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintMigration } from './migration-lint';

export const MIGRATIONS_DIR = join(__dirname, 'migrations');
export const BASELINE_FILE = join(__dirname, 'lint-migrations.baseline');
/** Primera migración que pasa el lint: la de DX-148. */
export const BASELINE_CUTOFF = '20261224100000';

export function readBaseline(file = BASELINE_FILE): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
}

export function migrationDirs(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && existsSync(join(dir, d.name, 'migration.sql')),
    )
    .map((d) => d.name)
    .sort();
}

export interface FileReport {
  file: string;
  violations: ReturnType<typeof lintMigration>;
}

export function lintRepository(
  dir = MIGRATIONS_DIR,
  baseline = readBaseline(),
): FileReport[] {
  return migrationDirs(dir)
    .filter((name) => !baseline.has(name))
    .map((name) => {
      const file = join(dir, name, 'migration.sql');
      return { file, violations: lintMigration(readFileSync(file, 'utf8')) };
    });
}

function writeBaseline(ref: string): number {
  const listing = execFileSync(
    'git',
    ['ls-tree', '-d', '--name-only', `${ref}:prisma/migrations`],
    { encoding: 'utf8', cwd: join(__dirname, '..') },
  );
  const names = listing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d{14}_/.test(l) && l < BASELINE_CUTOFF)
    .sort();
  writeFileSync(
    BASELINE_FILE,
    [
      '# DX-148: migraciones ya aplicadas en main antes del lint; no se analizan.',
      `# Generado con: npm run db:lint-migrations -- --write-baseline ${ref}`,
      '# NO añadas migraciones nuevas aquí (README, «Migraciones en caliente»).',
      ...names,
      '',
    ].join('\n'),
  );
  console.log(`${names.length} migraciones en ${BASELINE_FILE}`);
  return 0;
}

function main(argv: string[]): number {
  if (argv[0] === '--write-baseline')
    return writeBaseline(argv[1] ?? 'origin/main');
  const reports =
    argv.length > 0
      ? argv.map((file) => ({
          file,
          violations: lintMigration(readFileSync(file, 'utf8')),
        }))
      : lintRepository();
  let failures = 0;
  for (const { file, violations } of reports) {
    for (const v of violations) {
      failures += 1;
      console.error(`${file}:${v.line}: [${v.rule}] ${v.message}`);
    }
  }
  if (failures > 0) {
    console.error(
      `\n${failures} fallo(s) en ${reports.length} migración(es). Guía: README, «Migraciones en caliente».`,
    );
    return 1;
  }
  console.log(
    `db:lint-migrations: ${reports.length} migración(es) nuevas sin fallos.`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
