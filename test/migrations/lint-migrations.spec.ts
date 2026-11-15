import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOT_TABLES,
  RuleId,
  lintMigration,
  splitStatements,
} from '../../prisma/migration-lint';
import {
  BASELINE_CUTOFF,
  lintRepository,
  migrationDirs,
  readBaseline,
} from '../../prisma/lint-migrations';

// DX-148: `npm run db:lint-migrations` (README, «Migraciones en caliente»).
// Un caso bueno y uno malo por regla, con ficheros de ejemplo.

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures/lint-migrations', name), 'utf8');

const rules = (name: string): RuleId[] =>
  lintMigration(fixture(name)).map((v) => v.rule);

describe('DX-148 · db:lint-migrations', () => {
  describe('una regla, un caso malo y uno bueno', () => {
    it.each<[RuleId, string, string]>([
      [
        'validate-same-file',
        'validate-same-file.bad.sql',
        'validate-same-file.good.sql',
      ],
      ['lock-timeout', 'lock-timeout.bad.sql', 'lock-timeout.good.sql'],
      [
        'hot-table-index',
        'hot-table-index.bad.sql',
        'hot-table-index.good.sql',
      ],
      [
        'hot-table-index',
        'hot-table-index-partitioned.bad.sql',
        'hot-table-index-partitioned.good.sql',
      ],
      [
        'concurrently-alone',
        'concurrently-alone.bad.sql',
        'concurrently-alone.good.sql',
      ],
      ['unbatched-dml', 'unbatched-dml.bad.sql', 'unbatched-dml.good.sql'],
    ])('%s: %s falla y %s pasa', (rule, bad, good) => {
      expect(rules(bad)).toEqual([rule]);
      expect(rules(good)).toEqual([]);
    });

    it('unbatched-dml: con WHERE pero en una sola sentencia junto a DDL también falla', () => {
      const [v] = lintMigration(fixture('unbatched-dml-where.bad.sql'));
      expect(v).toMatchObject({ rule: 'unbatched-dml', line: 4 });
      expect(v.message).toMatch(/por lotes/);
    });

    it('validate-same-file señala cada VALIDATE con la línea de su sentencia', () => {
      expect(lintMigration(fixture('validate-same-file.bad.sql'))).toEqual([
        expect.objectContaining({ rule: 'validate-same-file', line: 7 }),
      ]);
    });
  });

  it('cada tabla caliente del alcance cuenta para hot-table-index', () => {
    expect([...HOT_TABLES].sort()).toEqual(
      [
        'appointments',
        'audit_events',
        'patients',
        'payments',
        'tooth_records',
        'treatment_plan_items',
      ].sort(),
    );
    for (const t of HOT_TABLES) {
      const sql = `SET LOCAL lock_timeout = '5s';\nCREATE INDEX "x" ON public."${t}" ("id");`;
      expect(lintMigration(sql).map((v) => v.rule)).toEqual([
        'hot-table-index',
      ]);
    }
    // Una tabla que no es caliente no exige CONCURRENTLY.
    expect(
      lintMigration(
        `SET LOCAL lock_timeout = '5s';\nCREATE INDEX "x" ON "chairs" ("id");`,
      ),
    ).toEqual([]);
  });

  it('UNIQUE en línea sobre una tabla caliente exige el índice CONCURRENTLY + USING INDEX', () => {
    const inline = `SET LOCAL lock_timeout = '5s';\nALTER TABLE "payments" ADD CONSTRAINT "u" UNIQUE ("tenantId", "id");`;
    const usingIndex = `SET LOCAL lock_timeout = '5s';\nALTER TABLE "payments" ADD CONSTRAINT "u" UNIQUE USING INDEX "payments_u_idx";`;
    expect(lintMigration(inline).map((v) => v.rule)).toEqual([
      'hot-table-index',
    ]);
    expect(lintMigration(usingIndex)).toEqual([]);
  });

  it('una tabla nueva con FK a una existente necesita lock_timeout (SHARE ROW EXCLUSIVE en la referida)', () => {
    const sql = `CREATE TABLE "x" ("id" UUID PRIMARY KEY, "patientId" UUID REFERENCES "patients"("id"));`;
    expect(lintMigration(sql).map((v) => v.rule)).toEqual(['lock-timeout']);
    expect(lintMigration(`SET LOCAL lock_timeout = '5s';\n${sql}`)).toEqual([]);
  });

  it('ignora cadenas, comentarios y cuerpos $$; la excepción en el fichero exige motivo', () => {
    expect(rules('tricky.good.sql')).toEqual([]);
    expect(rules('ignore.good.sql')).toEqual([]);
    const noReason = fixture('ignore.good.sql').replace(
      /ignore unbatched-dml:.*$/m,
      'ignore unbatched-dml:',
    );
    expect(lintMigration(noReason).map((v) => v.rule)).toEqual([
      'unbatched-dml',
    ]);
  });

  it('parte sentencias respetando E-strings y cuerpos con etiqueta', () => {
    const st = splitStatements(
      "SELECT E'a\\';b';\nDO $x$ BEGIN PERFORM 1; END $x$;\nSELECT 2;",
    );
    expect(st.map((s) => s.line)).toEqual([1, 2, 3]);
  });

  it('las migraciones históricas con el patrón malo lo detectan (DX-120 y DX-039)', () => {
    const migration = (name: string): string =>
      readFileSync(
        join(__dirname, '../../prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
    expect(
      lintMigration(
        migration('20261017180000_dx120_dentition_and_record_origin'),
      ).map((v) => v.rule),
    ).toContain('validate-same-file');
    expect(
      lintMigration(
        migration('20261017170000_dx039_clinical_record_retention'),
      ).map((v) => v.rule),
    ).toContain('unbatched-dml');
  });

  describe('lista de excepciones', () => {
    const baseline = readBaseline();

    it('solo lleva migraciones que existen y anteriores al corte de DX-148', () => {
      const dirs = new Set(migrationDirs());
      for (const name of baseline) {
        expect(dirs.has(name)).toBe(true);
        expect(name < BASELINE_CUTOFF).toBe(true);
      }
      expect(
        baseline.has('20261017180000_dx120_dentition_and_record_origin'),
      ).toBe(true);
    });

    it('el repo pasa el lint: toda migración fuera de la lista lo cumple', () => {
      const failures = lintRepository().flatMap(({ file, violations }) =>
        violations.map((v) => `${file}:${v.line} [${v.rule}]`),
      );
      expect(failures).toEqual([]);
    });
  });
});
