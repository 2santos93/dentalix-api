import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FK_UNDER_FORCE_ALLOWLIST,
  findFkUnderForce,
  type MigrationSource,
} from './fk-under-force';

// DX-134: con FORCE y un owner sin SUPERUSER ni BYPASSRLS, `ADD FOREIGN KEY`
// y `VALIDATE CONSTRAINT` validan con la RLS del owner (sin
// `app.current_tenant`, no ve ninguna fila de clínica):
//   - FORCE en la tabla HIJA: acepta la FK aunque haya filas huérfanas;
//   - FORCE en la REFERENCIADA: la FK falla con datos válidos (en producción,
//     no en la CI, que migra con las tablas vacías).
// Regla del README («Despliegue: roles de la BD»): NO FORCE en las dos (si lo
// tienen) en la misma migración, FORCE al final. Este lint lee
// prisma/migrations/*/migration.sql y lo vigila en cada PR.

const m = (name: string, sql: string): MigrationSource => ({ name, sql });

const FORCED_CHILD = m(
  '20990101000000_crea',
  `CREATE TABLE "parents" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL);
   CREATE TABLE "children" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "parentId" UUID);
   ALTER TABLE "children" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`,
);

const FORCED_BOTH = m(
  '20990101000000_crea',
  `${FORCED_CHILD.sql}
   ALTER TABLE "parents" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "parents" FORCE ROW LEVEL SECURITY;`,
);

const ADD_FK = `ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;

const child = (
  migration: string,
  statement: 'ADD FOREIGN KEY' | 'VALIDATE CONSTRAINT' = 'ADD FOREIGN KEY',
  constraint: string | null = 'children_parentId_fkey',
) => ({ migration, table: 'children', side: 'hija', constraint, statement });

const lint = (...ms: MigrationSource[]) => findFkUnderForce(ms);

describe('findFkUnderForce (DX-134)', () => {
  it('avisa si una migración añade una FK a una tabla hija que ya tenía FORCE', () => {
    expect(lint(FORCED_CHILD, m('20990102000000_fk', ADD_FK))).toEqual([
      child('20990102000000_fk'),
    ]);
  });

  it('avisa también si la REFERENCIADA tiene FORCE (fallaría con datos válidos)', () => {
    expect(lint(FORCED_BOTH, m('20990102000000_fk', ADD_FK))).toEqual([
      child('20990102000000_fk'),
      {
        migration: '20990102000000_fk',
        table: 'parents',
        side: 'referenciada',
        constraint: 'children_parentId_fkey',
        statement: 'ADD FOREIGN KEY',
      },
    ]);
  });

  it('no avisa si la misma migración quita FORCE a las dos antes y lo devuelve después', () => {
    const sql = `SET LOCAL lock_timeout = '5s';
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "parents" NO FORCE ROW LEVEL SECURITY;
      ${ADD_FK}
      ALTER TABLE "parents" FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;
    expect(lint(FORCED_BOTH, m('20990102000000_fk', sql))).toEqual([]);
  });

  it('NO FORCE solo en la hija no basta si la referenciada tiene FORCE', () => {
    const sql = `ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ${ADD_FK}
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;
    expect(lint(FORCED_BOTH, m('20990102000000_fk', sql))).toEqual([
      expect.objectContaining({ table: 'parents', side: 'referenciada' }),
    ]);
  });

  it('avisa si el NO FORCE llega después de la FK', () => {
    const sql = `${ADD_FK}
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;
    expect(lint(FORCED_CHILD, m('20990102000000_fk', sql))).toHaveLength(1);
  });

  it('avisa si el FORCE va en el mismo ALTER que la FK (ALTER TABLE lo aplica antes de validar)', () => {
    const sql = `ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
        FOREIGN KEY ("parentId") REFERENCES "parents"("id"), FORCE ROW LEVEL SECURITY;`;
    expect(lint(FORCED_CHILD, m('20990102000000_fk', sql))).toEqual([
      child('20990102000000_fk'),
    ]);
  });

  it('no cuenta una tabla hija creada en la misma migración (está vacía)', () => {
    expect(
      lint(m('20990101000000_crea', `${FORCED_BOTH.sql}\n${ADD_FK}`)),
    ).toEqual([]);
  });

  it('CREATE TABLE IF NOT EXISTS sobre una tabla existente no la da por nueva', () => {
    const sql = `CREATE TABLE IF NOT EXISTS "children" ("id" UUID PRIMARY KEY);
      ${ADD_FK}`;
    expect(lint(FORCED_CHILD, m('20990102000000_fk', sql))).toEqual([
      child('20990102000000_fk'),
    ]);
  });

  it('no avisa si FORCE se quitó en una migración anterior (pareja unforce/reforce)', () => {
    expect(
      lint(
        FORCED_CHILD,
        m(
          '20990101235959_unforce',
          'ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;',
        ),
        m('20990102000000_fk', ADD_FK),
        m(
          '20990102000001_reforce',
          'ALTER TABLE "children" FORCE ROW LEVEL SECURITY;',
        ),
      ),
    ).toEqual([]);
  });

  it('NOT VALID no recorre filas; el VALIDATE CONSTRAINT posterior de esa FK sí cuenta', () => {
    const sql = `ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
        FOREIGN KEY ("parentId") REFERENCES "parents"("id") NOT VALID;
      ALTER TABLE children VALIDATE CONSTRAINT children_parentId_fkey;`;
    expect(lint(FORCED_BOTH, m('20990102000000_fk', sql))).toEqual([
      child('20990102000000_fk', 'VALIDATE CONSTRAINT'),
      expect.objectContaining({
        table: 'parents',
        side: 'referenciada',
        statement: 'VALIDATE CONSTRAINT',
      }),
    ]);
  });

  it('NOT VALID cuenta por subcomando: otra FK del mismo ALTER sin NOT VALID sí avisa', () => {
    const sql = `ALTER TABLE "children"
        ADD CONSTRAINT "a_check" CHECK ("id" IS NOT NULL) NOT VALID,
        ADD CONSTRAINT "children_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "parents"("id");`;
    expect(lint(FORCED_CHILD, m('20990102000000_fk', sql))).toEqual([
      child('20990102000000_fk'),
    ]);
  });

  it('VALIDATE CONSTRAINT de un CHECK no cuenta (el CHECK sí ve las filas ocultas)', () => {
    const sql = `ALTER TABLE "children" ADD CONSTRAINT "children_check" CHECK ("id" IS NOT NULL) NOT VALID;
      ALTER TABLE "children" VALIDATE CONSTRAINT "children_check";`;
    expect(lint(FORCED_CHILD, m('20990102000000_check', sql))).toEqual([]);
  });

  it('VALIDATE CONSTRAINT de una restricción desconocida cuenta como FK (por prudencia)', () => {
    expect(
      lint(
        FORCED_CHILD,
        m(
          '20990102000000_v',
          'ALTER TABLE "children" VALIDATE CONSTRAINT "algo";',
        ),
      ),
    ).toHaveLength(1);
  });

  it('ADD COLUMN … DEFAULT … REFERENCES cuenta (todas las filas reciben el valor); sin DEFAULT no', () => {
    const withDefault = `ALTER TABLE "children" ADD COLUMN "otherId" UUID NOT NULL
        DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES "parents"("id");`;
    expect(lint(FORCED_CHILD, m('20990102000000_col', withDefault))).toEqual([
      child('20990102000000_col', 'ADD FOREIGN KEY', null),
    ]);
    expect(
      lint(
        FORCED_CHILD,
        m(
          '20990102000000_col',
          'ALTER TABLE "children" ADD COLUMN "otherId" UUID REFERENCES "parents"("id");',
        ),
      ),
    ).toEqual([]);
  });

  it('ignora comentarios y cadenas que mencionan FOREIGN KEY', () => {
    const sql = `-- ALTER TABLE "children" ADD CONSTRAINT x FOREIGN KEY ("parentId") REFERENCES "parents"("id");
      /* ALTER TABLE "children" ADD FOREIGN KEY ("parentId") REFERENCES "parents"("id"); /* anidado */ ; */
      COMMENT ON TABLE "children" IS 'ALTER TABLE children ADD FOREIGN KEY (a) REFERENCES b(c);';
      COMMENT ON TABLE "parents" IS E'it\\'s; ALTER TABLE children ADD FOREIGN KEY (a) REFERENCES b(c)';
      DO $$ BEGIN RAISE NOTICE 'ALTER TABLE children ADD FOREIGN KEY'; END $$;`;
    expect(lint(FORCED_CHILD, m('20990102000000_doc', sql))).toEqual([]);
  });

  it('un $$ dentro de un comentario o un -- dentro de una cadena no se comen la FK real', () => {
    const dollarInComment = `-- el cuerpo $$ va abajo
      ${ADD_FK}
      CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;`;
    expect(
      lint(FORCED_CHILD, m('20990102000000_a', dollarInComment)),
    ).toHaveLength(1);
    const dashesInString = `COMMENT ON TABLE "parents" IS 'a--b';
      ${ADD_FK}`;
    expect(
      lint(FORCED_CHILD, m('20990102000000_b', dashesInString)),
    ).toHaveLength(1);
  });

  it('una tabla renombrada conserva su FORCE; una borrada lo pierde', () => {
    expect(
      lint(
        FORCED_CHILD,
        m('20990102000000_ren', 'ALTER TABLE "children" RENAME TO "kids";'),
        m(
          '20990103000000_fk',
          'ALTER TABLE "kids" ADD FOREIGN KEY ("parentId") REFERENCES "parents"("id");',
        ),
      ),
    ).toEqual([
      {
        migration: '20990103000000_fk',
        table: 'kids',
        side: 'hija',
        constraint: null,
        statement: 'ADD FOREIGN KEY',
      },
    ]);
    expect(
      lint(
        FORCED_CHILD,
        m('20990102000000_drop', 'DROP TABLE "children";'),
        m(
          '20990103000000_crea',
          `CREATE TABLE "children" ("id" UUID PRIMARY KEY, "parentId" UUID);`,
        ),
        m('20990104000000_fk', ADD_FK),
      ),
    ).toEqual([]);
  });

  it('acepta migraciones que crean tablas con sus FK y después activan FORCE', () => {
    const sql = `CREATE TABLE "jobs" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "parents"("id"));
      ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "parents"("id");
      ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;`;
    expect(lint(FORCED_BOTH, m('20990102000000_jobs', sql))).toEqual([]);
  });
});

describe('prisma/migrations: FK sobre tablas con FORCE (DX-134)', () => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const migrations: MigrationSource[] = readdirSync(dir, {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8'),
    }));
  const found = findFkUnderForce(migrations);

  it('ninguna migración nueva añade ni valida una FK bajo FORCE sin NO FORCE en la misma migración', () => {
    const fresh = found
      .filter((v) => !FK_UNDER_FORCE_ALLOWLIST.has(v.migration))
      .map(
        (v) =>
          `${v.migration}: ${v.statement} ${v.constraint ?? ''} con FORCE en la tabla ${v.side} "${v.table}". ` +
          'Añade ALTER TABLE … NO FORCE ROW LEVEL SECURITY a la hija y a la referenciada antes y FORCE después, en la misma migración (README, «Despliegue: roles de la BD»).',
      );
    expect(fresh).toEqual([]);
  });

  it('cada migración de la allowlist sigue existiendo y sigue cayendo en la regla (la lista no se pudre)', () => {
    const flagged = new Set(found.map((v) => v.migration));
    expect(
      [...FK_UNDER_FORCE_ALLOWLIST.keys()].filter((name) => !flagged.has(name)),
    ).toEqual([]);
  });

  it('lee todas las migraciones', () => {
    expect(migrations.length).toBeGreaterThan(90);
  });
});
