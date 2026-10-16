import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FK_UNDER_FORCE_ALLOWLIST,
  findFkUnderForce,
  type MigrationSource,
} from './fk-under-force';

// DX-134: con FORCE y un owner sin SUPERUSER ni BYPASSRLS, `ADD FOREIGN KEY`
// y `VALIDATE CONSTRAINT` validan solo las filas que la RLS deja ver al owner
// (sin `app.current_tenant`, ninguna): aceptan la FK aunque haya filas
// huérfanas. Regla del README («Despliegue: roles de la BD»): añadir o validar
// una FK cuenta como leer filas, NO FORCE en la misma transacción.
// Este lint lee prisma/migrations/*/migration.sql y lo vigila en cada PR.

const m = (name: string, sql: string): MigrationSource => ({ name, sql });

const FORCED_PARENT_CHILD = m(
  '20990101000000_crea',
  `CREATE TABLE "parents" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL);
   CREATE TABLE "children" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL, "parentId" UUID);
   ALTER TABLE "children" ENABLE ROW LEVEL SECURITY;
   ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`,
);

const ADD_FK = `ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "parents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;`;

describe('findFkUnderForce (DX-134)', () => {
  it('avisa si una migración añade una FK a una tabla que ya tenía FORCE', () => {
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_fk', ADD_FK)]),
    ).toEqual([
      {
        migration: '20990102000000_fk',
        table: 'children',
        constraint: 'children_parentId_fkey',
        statement: 'ADD FOREIGN KEY',
      },
    ]);
  });

  it('no avisa si la misma migración quita FORCE antes y lo devuelve después', () => {
    const sql = `SET LOCAL lock_timeout = '5s';
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ${ADD_FK}
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_fk', sql)]),
    ).toEqual([]);
  });

  it('avisa si el NO FORCE llega después de la FK', () => {
    const sql = `${ADD_FK}
      ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;
      ALTER TABLE "children" FORCE ROW LEVEL SECURITY;`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_fk', sql)]),
    ).toHaveLength(1);
  });

  it('no cuenta una tabla creada en la misma migración (está vacía)', () => {
    expect(
      findFkUnderForce([
        m('20990101000000_crea', `${FORCED_PARENT_CHILD.sql}\n${ADD_FK}`),
      ]),
    ).toEqual([]);
  });

  it('no avisa si FORCE se quitó en una migración anterior (pareja unforce/reforce)', () => {
    expect(
      findFkUnderForce([
        FORCED_PARENT_CHILD,
        m(
          '20990101235959_unforce',
          'ALTER TABLE "children" NO FORCE ROW LEVEL SECURITY;',
        ),
        m('20990102000000_fk', ADD_FK),
        m(
          '20990102000001_reforce',
          'ALTER TABLE "children" FORCE ROW LEVEL SECURITY;',
        ),
      ]),
    ).toEqual([]);
  });

  it('NOT VALID no recorre filas; el VALIDATE CONSTRAINT posterior de esa FK sí cuenta', () => {
    const sql = `ALTER TABLE "children" ADD CONSTRAINT "children_parentId_fkey"
        FOREIGN KEY ("parentId") REFERENCES "parents"("id") NOT VALID;
      ALTER TABLE children VALIDATE CONSTRAINT children_parentId_fkey;`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_fk', sql)]),
    ).toEqual([
      {
        migration: '20990102000000_fk',
        table: 'children',
        constraint: 'children_parentId_fkey',
        statement: 'VALIDATE CONSTRAINT',
      },
    ]);
  });

  it('VALIDATE CONSTRAINT de un CHECK no cuenta (el CHECK sí ve las filas ocultas)', () => {
    const sql = `ALTER TABLE "children" ADD CONSTRAINT "children_check" CHECK ("id" IS NOT NULL) NOT VALID;
      ALTER TABLE "children" VALIDATE CONSTRAINT "children_check";`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_check', sql)]),
    ).toEqual([]);
  });

  it('VALIDATE CONSTRAINT de una restricción desconocida cuenta como FK (por prudencia)', () => {
    expect(
      findFkUnderForce([
        FORCED_PARENT_CHILD,
        m(
          '20990102000000_v',
          'ALTER TABLE "children" VALIDATE CONSTRAINT "algo";',
        ),
      ]),
    ).toHaveLength(1);
  });

  it('ignora comentarios y cadenas que mencionan FOREIGN KEY', () => {
    const sql = `-- ALTER TABLE "children" ADD CONSTRAINT x FOREIGN KEY ("parentId") REFERENCES "parents"("id");
      /* ALTER TABLE "children" ADD FOREIGN KEY ("parentId") REFERENCES "parents"("id"); */
      COMMENT ON TABLE "children" IS 'ALTER TABLE children ADD FOREIGN KEY (a) REFERENCES b(c);';
      DO $$ BEGIN RAISE NOTICE 'ALTER TABLE children ADD FOREIGN KEY'; END $$;`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_doc', sql)]),
    ).toEqual([]);
  });

  it('una tabla renombrada conserva su FORCE; una borrada lo pierde', () => {
    const renamed = findFkUnderForce([
      FORCED_PARENT_CHILD,
      m('20990102000000_ren', 'ALTER TABLE "children" RENAME TO "kids";'),
      m(
        '20990103000000_fk',
        'ALTER TABLE "kids" ADD FOREIGN KEY ("parentId") REFERENCES "parents"("id");',
      ),
    ]);
    expect(renamed).toEqual([
      {
        migration: '20990103000000_fk',
        table: 'kids',
        constraint: null,
        statement: 'ADD FOREIGN KEY',
      },
    ]);
    expect(
      findFkUnderForce([
        FORCED_PARENT_CHILD,
        m('20990102000000_drop', 'DROP TABLE "children";'),
        m(
          '20990103000000_crea',
          `CREATE TABLE "children" ("id" UUID PRIMARY KEY, "parentId" UUID);`,
        ),
        m('20990104000000_fk', ADD_FK),
      ]),
    ).toEqual([]);
  });

  it('acepta migraciones que crean tablas con sus FK y después activan FORCE', () => {
    const sql = `CREATE TABLE "jobs" ("id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "parents"("id"));
      ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "parents"("id");
      ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;`;
    expect(
      findFkUnderForce([FORCED_PARENT_CHILD, m('20990102000000_jobs', sql)]),
    ).toEqual([]);
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
          `${v.migration}: ${v.statement} ${v.constraint ?? ''} en "${v.table}" con FORCE. ` +
          'Añade ALTER TABLE … NO FORCE ROW LEVEL SECURITY antes y FORCE después, en la misma migración (README, «Despliegue: roles de la BD»).',
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
