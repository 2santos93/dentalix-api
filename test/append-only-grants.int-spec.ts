import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  APP_UPDATE_COLUMNS_ONLY,
  NO_APP_DELETE,
  NO_APP_UPDATE_DELETE,
} from '../prisma/append-only-tables';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-148: en las tablas append-only, dentalix_app no tiene UPDATE ni DELETE
// (o solo no tiene DELETE) y sí INSERT y SELECT. Primero el catálogo de la
// base migrada; después, de verdad, conectado como la app.

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());

const SUBDOMAIN = 'dx148-append-only';
const EMAIL = 'dx148-append-only@x.com';

interface Grants {
  relname: string;
  sel: boolean;
  ins: boolean;
  upd: boolean;
  del: boolean;
  trunc: boolean;
}

async function grants(tables: readonly string[]): Promise<Map<string, Grants>> {
  const rows = await owner.$queryRaw<Grants[]>`
    SELECT c.relname,
           has_table_privilege('dentalix_app', c.oid, 'SELECT') AS sel,
           has_table_privilege('dentalix_app', c.oid, 'INSERT') AS ins,
           has_table_privilege('dentalix_app', c.oid, 'UPDATE') AS upd,
           has_table_privilege('dentalix_app', c.oid, 'DELETE') AS del,
           has_table_privilege('dentalix_app', c.oid, 'TRUNCATE') AS trunc
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = ANY(${[...tables]})`;
  return new Map(rows.map((r) => [r.relname, r]));
}

/** Arrays de los FOREACH del bloque DX-148 de create-app-role.sql. */
function bootstrapLists(): string[][] {
  const sql = readFileSync(
    join(__dirname, '../docker/prod/create-app-role.sql'),
    'utf8',
  );
  const block = sql.slice(sql.indexOf('-- DX-148'));
  return [...block.matchAll(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]/g)]
    .slice(0, 2)
    .map((m) => [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]).sort());
}

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  // Owner superusuario: el trigger le deja borrar (limpieza de tests).
  await owner.privacyPolicyVersion.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  await owner.user.deleteMany({ where: { email: EMAIL } });
}

describe('DX-148 · REVOKE UPDATE, DELETE a dentalix_app en las tablas append-only (int)', () => {
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    tenantId = (
      await owner.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    userId = (
      await owner.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Admin' },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  it('las listas no se solapan y create-app-role.sql repite exactamente las mismas', () => {
    const full: string[] = [...NO_APP_UPDATE_DELETE].sort();
    const del: string[] = [...NO_APP_DELETE].sort();
    expect(full.filter((t) => del.includes(t))).toEqual([]);
    expect(new Set(full).size).toBe(full.length);
    expect(new Set(del).size).toBe(del.length);
    expect(bootstrapLists()).toEqual([full, del]);
  });

  it('sin UPDATE, DELETE ni TRUNCATE; con INSERT y SELECT', async () => {
    const found = await grants(NO_APP_UPDATE_DELETE);
    expect([...found.keys()].sort()).toEqual([...NO_APP_UPDATE_DELETE].sort());
    for (const g of found.values()) {
      expect(g).toEqual({
        relname: g.relname,
        sel: true,
        ins: true,
        upd: false,
        del: false,
        trunc: false,
      });
    }
  });

  it('las particiones de audit_events tampoco dan UPDATE ni DELETE', async () => {
    const parts = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'public.audit_events'::regclass`;
    expect(parts.length).toBeGreaterThan(0);
    for (const g of (await grants(parts.map((p) => p.relname))).values()) {
      expect({ upd: g.upd, del: g.del, trunc: g.trunc }).toEqual({
        upd: false,
        del: false,
        trunc: false,
      });
    }
  });

  it('las que se anulan o se bloquean conservan UPDATE, pero no DELETE', async () => {
    const found = await grants(NO_APP_DELETE);
    expect([...found.keys()].sort()).toEqual([...NO_APP_DELETE].sort());
    for (const g of found.values()) {
      expect(g).toEqual({
        relname: g.relname,
        sel: true,
        ins: true,
        upd: true,
        del: false,
        trunc: false,
      });
    }
  });

  it('prescriptions: sin UPDATE de tabla ni DELETE; UPDATE solo de las columnas de la anulación', async () => {
    const found = await grants(['prescriptions']);
    expect(found.get('prescriptions')).toMatchObject({
      sel: true,
      ins: true,
      upd: false,
      del: false,
      trunc: false,
    });
    const cols = await owner.$queryRaw<{ attname: string }[]>`
      SELECT a.attname FROM pg_attribute a
       WHERE a.attrelid = 'public.prescriptions'::regclass AND a.attnum > 0
         AND NOT a.attisdropped
         AND has_column_privilege('dentalix_app', a.attrelid, a.attnum, 'UPDATE')
       ORDER BY 1`;
    expect(cols.map((c) => c.attname)).toEqual(
      [...APP_UPDATE_COLUMNS_ONLY.prescriptions].sort(),
    );
    // Como la app: la anulación pasa el privilegio; otra columna, no.
    await prisma.runWithTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE "prescriptions" SET "status" = 'VOIDED', "voidedAt" = now(), "voidReason" = 'x' WHERE false`,
    );
    await expect(
      prisma.runWithTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "prescriptions" SET "tenantId" = "tenantId" WHERE false`,
      ),
    ).rejects.toThrow(/permission denied for table prescriptions/);
  });

  it('como dentalix_app: INSERT y SELECT sí; UPDATE y DELETE, permiso denegado', async () => {
    const id = await prisma.runWithTenant(tenantId, async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "privacy_policy_versions"
          ("id", "tenantId", "version", "policyText", "generalText",
           "sensitiveHealthText", "marketingText", "contentHash", "publishedById")
        VALUES (gen_random_uuid(), ${tenantId}::uuid, 1, 'p', 'g', 's', 'm', 'h', ${userId}::uuid)
        RETURNING "id"`;
      return row.id;
    });
    const seen = await prisma.runWithTenant(tenantId, (tx) =>
      tx.privacyPolicyVersion.count({ where: { id } }),
    );
    expect(seen).toBe(1);

    // El privilegio corta antes que el trigger: el error es de permisos, no
    // el mensaje "append-only" del trigger. Y aunque el WHERE no encuentre
    // filas (el trigger no llegaría a correr), el permiso falta igual.
    for (const sql of [
      Prisma.sql`UPDATE "privacy_policy_versions" SET "policyText" = 'x' WHERE "id" = ${id}::uuid`,
      Prisma.sql`UPDATE "privacy_policy_versions" SET "policyText" = 'x' WHERE false`,
      Prisma.sql`DELETE FROM "privacy_policy_versions" WHERE "id" = ${id}::uuid`,
      Prisma.sql`SELECT 1 FROM "privacy_policy_versions" WHERE "id" = ${id}::uuid FOR UPDATE`,
    ]) {
      await expect(
        prisma.runWithTenant(tenantId, (tx) => tx.$executeRaw(sql)),
      ).rejects.toThrow(/permission denied for table privacy_policy_versions/);
    }
    expect(
      await owner.privacyPolicyVersion.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ policyText: 'p' });
  });

  it('como dentalix_app: en una tabla sin DELETE el borrado da permiso denegado', async () => {
    await expect(
      prisma.runWithTenant(
        tenantId,
        (tx) => tx.$executeRaw`DELETE FROM "expenses" WHERE false`,
      ),
    ).rejects.toThrow(/permission denied for table expenses/);
  });
});
