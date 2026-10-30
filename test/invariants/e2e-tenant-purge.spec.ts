import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { purgeTenants, type SqlRunner } from '../support/tenant-purge';
import { readSpecs, type SpecSource } from './bare-delete-many';

// DX-396 (TST-045): en los e2e la clínica se crea por la API (registro), que
// siembra filas propias (p. ej. los medios de pago de DX-377). Una limpieza a
// mano que borra `tenants` tras una lista de tablas se rompe con cada tabla
// nueva («Test suite failed to run» por la FK). Los e2e borran clínicas con
// `purgeTenants` / `purgeTenantsBySubdomain` (test/support/tenant-purge.ts,
// tablas leídas del catálogo) o vacían la base con `resetDatabase(raw)`.

const REPO_ROOT = join(__dirname, '..', '..');

const HAND_TENANT_DELETE =
  /\.tenant\s*\.\s*delete(?:Many)?\s*\(|DELETE\s+FROM\s+"?tenants"?(?![\w"])/i;

interface Finding {
  path: string;
  line: number;
  text: string;
}

function findHandTenantDeletes(specs: SpecSource[]): Finding[] {
  return specs
    .filter((s) => s.path.endsWith('.e2e-spec.ts'))
    .flatMap((s) =>
      s.source
        .split('\n')
        .flatMap((text, i) =>
          HAND_TENANT_DELETE.test(text)
            ? [{ path: s.path, line: i + 1, text: text.trim() }]
            : [],
        ),
    );
}

describe('DX-396: los e2e no borran clínicas a mano', () => {
  it('detecta raw.tenant.deleteMany, raw.tenant.delete y DELETE FROM tenants', () => {
    const found = findHandTenantDeletes([
      {
        path: 'test/nuevo.e2e-spec.ts',
        source: [
          "await raw.tenant.deleteMany({ where: { subdomain: 'x' } });",
          'await raw.tenant.delete({ where: { id } });',
          'await raw.$executeRaw`DELETE FROM "tenants" WHERE id = ${id}`;',
          'await raw.tenantDomain.deleteMany({ where: { host } });',
          'await raw.$executeRaw`DELETE FROM tenants_extra WHERE 1 = 0`;',
        ].join('\n'),
      },
      {
        path: 'test/nuevo.int-spec.ts',
        source: "await raw.tenant.deleteMany({ where: { subdomain: 'x' } });",
      },
    ]);
    expect(found.map((f) => f.line)).toEqual([1, 2, 3]);
  });

  it('ningún e2e del repo borra tenants fuera de test/support/', () => {
    expect(findHandTenantDeletes(readSpecs(REPO_ROOT))).toEqual([]);
  });
});

describe('DX-396: purgeTenants solo borra en una base de test', () => {
  function fakeDb(dbName: string) {
    const executed: string[] = [];
    const db: SqlRunner = {
      $queryRawUnsafe: (sql: string) => {
        if (/current_database\(\)/.test(sql)) {
          return Promise.resolve([{ db: dbName }]);
        }
        // Catálogo vacío: sin tablas de clínica, FKs ni triggers.
        return Promise.resolve([]);
      },
      $executeRawUnsafe: (sql: string) => {
        executed.push(sql);
        return Promise.resolve(0);
      },
    } as unknown as SqlRunner;
    return { db, executed };
  }

  it.each(['dentalix', 'dentalix_dev', 'dentalix_test_x-y', 'test_dentalix'])(
    'se niega en "%s" sin ejecutar ningún DELETE',
    async (name) => {
      const { db, executed } = fakeDb(name);
      await expect(purgeTenants(db, [randomUUID()])).rejects.toThrow(
        /no es una base de test/,
      );
      expect(executed).toEqual([]);
    },
  );

  it.each(['dentalix_test', 'dentalix_lead_test', 'dentalix_test_owner'])(
    'borra en "%s"',
    async (name) => {
      const { db, executed } = fakeDb(name);
      await purgeTenants(db, [randomUUID()]);
      expect(executed).toEqual([
        'DELETE FROM tenants WHERE id = ANY($1::uuid[])',
      ]);
    },
  );
});
