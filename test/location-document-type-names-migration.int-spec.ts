import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

// DX-524: la migración es expand puro. Cinco columnas TEXT NULL en `locations`
// (todas las sedes, nuevas o antiguas, quedan sin nombre propio), con el mismo
// CHECK que `tenants` (1..60, sin espacios en los extremos). Se comprueba
// contra la BD ya migrada del entorno de test.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const COLUMNS = [
  'docTypeNameNationalId',
  'docTypeNamePassport',
  'docTypeNameResidencePermit',
  'docTypeNameTaxId',
  'docTypeNameOther',
] as const;

const SQL = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261115100000_dx524_location_doc_type_names/migration.sql',
  ),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('migración DX-524: nombre de documento por sede', () => {
  const tenantId = randomUUID();

  beforeAll(async () => {
    await raw.$executeRaw`
      INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
      VALUES (${tenantId}::uuid, 'DX-524', ${`dx524-${tenantId.slice(0, 8)}`}, now())`;
  });

  afterAll(async () => {
    await raw.$executeRaw`DELETE FROM "locations" WHERE "tenantId" = ${tenantId}::uuid`;
    await raw.$executeRaw`DELETE FROM "tenants" WHERE "id" = ${tenantId}::uuid`;
    await raw.$disconnect();
  });

  const insert = (column: string, value: string | null) =>
    raw.$executeRawUnsafe(
      `INSERT INTO "locations" ("id", "tenantId", "name", "countryCode", "updatedAt", "${column}")
       VALUES ($1::uuid, $2::uuid, 'Sede', 'VE', now(), $3)`,
      randomUUID(),
      tenantId,
      value,
    );

  it('las cinco columnas existen, son TEXT y aceptan NULL', async () => {
    const rows = await raw.$queryRaw<
      { column_name: string; data_type: string; is_nullable: string }[]
    >`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'locations' AND column_name LIKE 'docTypeName%'
      ORDER BY column_name`;
    expect(rows.map((r) => r.column_name).sort()).toEqual([...COLUMNS].sort());
    expect(new Set(rows.map((r) => `${r.data_type}/${r.is_nullable}`))).toEqual(
      new Set(['text/YES']),
    );
  });

  it('una sede nueva nace sin ningún nombre propio', async () => {
    await insert('docTypeNameOther', null);
    const rows = await raw.$queryRawUnsafe<Record<string, string | null>[]>(
      `SELECT ${COLUMNS.map((c) => `"${c}"`).join(', ')} FROM "locations" WHERE "tenantId" = $1::uuid`,
      tenantId,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.values(row)).toEqual([null, null, null, null, null]);
    }
  });

  it.each(COLUMNS)(
    '%s: acepta 1..60 y rechaza vacío, espacios en los extremos y 61',
    async (column) => {
      await expect(insert(column, 'Cédula de identidad')).resolves.toBe(1);
      await expect(insert(column, 'a'.repeat(60))).resolves.toBe(1);
      for (const bad of ['', ' x', 'x ', 'a'.repeat(61)]) {
        await expect(insert(column, bad)).rejects.toThrow(/check/i);
      }
    },
  );

  it('es expand puro: solo añade columnas y restricciones, sin DROP ni UPDATE', () => {
    expect(SQL).not.toMatch(
      /\bDROP\b|\bUPDATE\b|\bDELETE\b|\bRENAME\b|SET NOT NULL/i,
    );
    expect(SQL).toMatch(/lock_timeout/);
  });
});
