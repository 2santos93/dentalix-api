import { Prisma, PrismaClient } from '@prisma/client';
import { resetDatabase } from './support/e2e-fixtures';

// DX-251 (OPS-037): `set_config('app.current_tenant', …, true)` deja la
// variable en '' (no en NULL) el resto de la sesión cuando termina la
// transacción. Con el cast directo `''::uuid` la política de RLS lanzaba 22P02
// en cuanto se evaluaba sobre una fila (así se rompió `migrate deploy` desde
// cero con DX-225 + DX-151). Con NULLIF la política compara con NULL: con la
// variable vacía NO se ve ni se escribe ninguna fila de ninguna clínica —
// exactamente como sin clínica fijada—, y sin error.
//
// `raw` (DIRECT_URL, owner superusuario en local/CI) solo carga filas; las
// comprobaciones corren como la app (DATABASE_URL, dentalix_app, sin bypass).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const app = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

/** Error de Postgres (código SQLSTATE y mensaje) o null si no falla. */
async function pgError(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('RLS con app.current_tenant vacío (DX-251, OPS-037)', () => {
  let tenantId: string;
  let tables: string[];

  beforeAll(async () => {
    await resetDatabase(raw);
    const tenant = await raw.tenant.create({
      data: { name: 'Clínica GUC', subdomain: 'guc-vacia' },
    });
    tenantId = tenant.id;
    await raw.patient.create({
      data: { tenantId, firstName: 'Pía', lastName: 'Vacía' },
    });
    // Toda tabla con una política atada a app.current_tenant que la app puede
    // leer (las de solo escritura, como alguna de auditoría, no cuentan).
    const rows = await app.$queryRaw<{ table: string }[]>`
      SELECT DISTINCT p.tablename::text AS table
        FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND (p.qual LIKE '%app.current_tenant%'
              OR p.with_check LIKE '%app.current_tenant%')
         AND has_table_privilege(format('public.%I', p.tablename), 'SELECT')
       ORDER BY 1`;
    tables = rows.map((r) => r.table);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.$disconnect();
  });

  it('con la variable vacía, toda tabla de clínica devuelve 0 filas y ninguna lanza 22P02', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(50);
    expect(tables).toContain('patients');
    const failures: string[] = [];
    const visible: string[] = [];
    for (const table of tables) {
      try {
        const [{ n }] = await app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', '', true)`;
          return tx.$queryRawUnsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM public."${table}"`,
          );
        });
        if (n !== 0) visible.push(`${table}: ${n}`);
      } catch (err) {
        failures.push(`${table}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(visible).toEqual([]);
  });

  it('con la variable vacía no se puede escribir una fila de clínica: la WITH CHECK la rechaza (no 22P02)', async () => {
    const error = await pgError(() =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', '', true)`;
        await tx.$executeRaw`
          INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt")
          VALUES (gen_random_uuid(), ${tenantId}::uuid, 'Intrusa', 'X', now())`;
      }),
    );
    expect(error).toMatch(/row-level security/);
    expect(error).not.toMatch(/invalid input syntax for type uuid/);
  });

  it('control: con la clínica fijada sí ve su paciente, y un valor que no es uuid sigue fallando', async () => {
    const [{ n }] = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "patients"`;
    });
    expect(n).toBe(1);
    const error = await pgError(() =>
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', 'no-es-uuid', true)`;
        return tx.$queryRaw`SELECT count(*) FROM "patients"`;
      }),
    );
    expect(error).toMatch(/invalid input syntax for type uuid/);
  });
});
