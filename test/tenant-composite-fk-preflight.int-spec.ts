import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

// La comprobación previa de 20261015130000_tenant_composite_fks se ejecuta aquí
// TAL CUAL está en la migración (se extrae del .sql, no se copia), contra la
// base de test ya migrada. Para tener una fila cruzada hay que quitar antes la
// FK compuesta; todo pasa dentro de una transacción que acaba en ROLLBACK, así
// que la base queda como estaba.
const MIGRATION = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261015130000_tenant_composite_fks/migration.sql',
  ),
  'utf8',
);
const ROW_SECURITY_OFF = 'SET LOCAL row_security = off;';
const PREFLIGHT = /^DO \$\$[\s\S]*?^END \$\$;$/m.exec(MIGRATION)?.[0] ?? '';

// Owner (DIRECT_URL): el rol con el que corren las migraciones.
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Rol de la app (DATABASE_URL): sin BYPASSRLS, sujeto a la RLS FORCE.
const app = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['preflight-a', 'preflight-b'];

class Rollback extends Error {}

describe('Comprobación previa de las FK compuestas (SEC-004, int)', () => {
  let tenantA: string;
  let patientB: string;

  beforeAll(async () => {
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    patientB = (
      await owner.patient.create({
        data: { tenantId: b.id, firstName: 'Ana', lastName: 'B' },
      })
    ).id;
  });

  afterAll(async () => {
    const tenants = await owner.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    });
    const ids = tenants.map((t) => t.id);
    await owner.clinicalEntry.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.patient.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('la migración apaga row_security y bloquea las tablas ANTES de la comprobación', () => {
    expect(PREFLIGHT).toContain('RAISE EXCEPTION');
    const rowSecurityAt = MIGRATION.indexOf(ROW_SECURITY_OFF);
    const firstLockAt = MIGRATION.search(/^LOCK TABLE /m);
    const preflightAt = MIGRATION.indexOf(PREFLIGHT);
    expect(rowSecurityAt).toBeGreaterThanOrEqual(0);
    expect(firstLockAt).toBeGreaterThan(rowSecurityAt);
    expect(preflightAt).toBeGreaterThan(firstLockAt);
    // Ninguna sentencia SQL antes de SET LOCAL (solo comentarios).
    const before = MIGRATION.slice(0, rowSecurityAt)
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    expect(before).toEqual([]);
  });

  it('con datos coherentes, la comprobación pasa', async () => {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
      await tx.$executeRawUnsafe(PREFLIGHT);
    });
  });

  it('con una fila cruzada, aborta con RAISE y el desglose por FK', async () => {
    const cross = owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
      await tx.$executeRawUnsafe(
        'ALTER TABLE "clinical_entries" DROP CONSTRAINT "clinical_entries_tenantId_patientId_fkey"',
      );
      await tx.clinicalEntry.create({
        data: {
          tenantId: tenantA,
          patientId: patientB,
          entryDate: new Date(),
          notes: 'cruzada',
          performedById: patientB,
        },
      });
      await tx.$executeRawUnsafe(PREFLIGHT);
      throw new Rollback('la comprobación debía fallar');
    });

    await expect(cross).rejects.toThrow(
      /SEC-004[\s\S]*clinical_entries\.patientId: 1/,
    );
    // ROLLBACK: la FK sigue y la fila cruzada no quedó.
    const fk = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
       WHERE conname = 'clinical_entries_tenantId_patientId_fkey'`;
    expect(Number(fk[0].n)).toBe(1);
    expect(
      await owner.clinicalEntry.count({ where: { patientId: patientB } }),
    ).toBe(0);
  });

  it('un rol sujeto a RLS no puede contar de menos en silencio: row_security=off lo hace fallar', async () => {
    const asApp = app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
      await tx.$executeRawUnsafe(PREFLIGHT);
    });
    await expect(asApp).rejects.toThrow(/row-level security/);
  });
});
