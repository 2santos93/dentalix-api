import { Prisma, PrismaClient } from '@prisma/client';
import { purgeTenants } from './support/tenant-purge';
import {
  gate,
  settle,
  transactionId,
  waitForTransactionWaiters,
} from './support/postgres-concurrency';

// DX-484: código del paciente. Lo asigna el trigger `patients_code_assign`
// desde el contador de su clínica (`patient_code_counters`) en la misma
// transacción del alta; `patients_code_immutable` impide cambiarlo, y el
// índice único (tenantId, patientCode) es la red de seguridad.
//
// Las altas van como dentalix_app con la clínica fijada (como la API), con un
// pool de 8 conexiones para que las concurrentes corran de verdad a la vez.
// `raw` (DIRECT_URL, superusuario) solo siembra, lee y limpia.
function withPool(url: string | undefined, size: number): string {
  const u = new URL(url ?? '');
  u.searchParams.set('connection_limit', String(size));
  return u.toString();
}

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: withPool(process.env.DATABASE_URL, 8) } },
});

const SUBDOMAINS = ['dx484-int-a', 'dx484-int-b', 'dx484-int-c'];
const SUBDOMAIN_GONE = 'dx484-int-gone';

let tenantA: string;
let tenantB: string;
let tenantC: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: [...SUBDOMAINS, SUBDOMAIN_GONE] } },
    select: { id: true },
  });
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
}

/** Corre `fn` como dentalix_app con la clínica fijada (como la API). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }, options);
}

function insertPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  lastName: string,
  extra: { patientCode?: number } = {},
) {
  return tx.patient.create({
    data: { tenantId, firstName: 'José', lastName, ...extra },
    select: { id: true, patientCode: true },
  });
}

function createPatient(tenantId: string, lastName: string) {
  return asApp(tenantId, (tx) => insertPatient(tx, tenantId, lastName));
}

async function codesOf(tenantId: string): Promise<number[]> {
  const rows = await raw.patient.findMany({
    where: { tenantId },
    select: { patientCode: true },
    orderBy: { patientCode: 'asc' },
  });
  return rows.map((r) => r.patientCode);
}

describe('DX-484 · código del paciente por clínica (int)', () => {
  beforeAll(async () => {
    await cleanup();
    [tenantA, tenantB, tenantC] = await Promise.all(
      SUBDOMAINS.map(async (subdomain, i) => {
        const t = await raw.tenant.create({
          data: { name: `Clínica DX-484 ${'ABC'[i]}`, subdomain },
          select: { id: true },
        });
        return t.id;
      }),
    );
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), appRole.$disconnect()]);
  });

  it('two patients of one clinic get consecutive, distinct codes starting at 1', async () => {
    const first = await createPatient(tenantA, 'Pérez');
    const second = await createPatient(tenantA, 'Núñez');
    expect(first.patientCode).toBe(1);
    expect(second.patientCode).toBe(2);
    const counter = await raw.patientCodeCounter.findUniqueOrThrow({
      where: { tenantId: tenantA },
    });
    expect(counter.lastNumber).toBe(2);
  });

  it('another clinic starts its own sequence', async () => {
    const other = await createPatient(tenantB, 'Rodríguez');
    expect(other.patientCode).toBe(1);
    expect(await codesOf(tenantA)).toEqual([1, 2]);
  });

  it('a code written on insert is ignored: the trigger always assigns it', async () => {
    const forced = await asApp(tenantA, (tx) =>
      insertPatient(tx, tenantA, 'Forzado', { patientCode: 1 }),
    );
    expect(forced.patientCode).toBe(3);
    // También con SQL directo y como superusuario.
    const [viaSql] = await raw.$queryRaw<{ patientCode: number }[]>`
      INSERT INTO "patients" ("id","tenantId","firstName","lastName","patientCode","updatedAt")
      VALUES (gen_random_uuid(), ${tenantA}::uuid, 'Ana', 'Directa', 999, now())
      RETURNING "patientCode"`;
    expect(viaSql.patientCode).toBe(4);
  });

  it('the code cannot be changed, not even by the owner', async () => {
    const { id } = await createPatient(tenantA, 'Inmutable');
    await expect(
      asApp(tenantA, (tx) =>
        tx.patient.update({ where: { id }, data: { patientCode: 4242 } }),
      ),
    ).rejects.toThrow(/El código del paciente no se puede cambiar/);
    await expect(
      raw.$executeRaw`UPDATE "patients" SET "patientCode" = 0 WHERE "id" = ${id}::uuid`,
    ).rejects.toThrow(/El código del paciente no se puede cambiar/);
    // Escribir el mismo valor no es un cambio; editar otra columna, tampoco.
    const same = await raw.patient.findUniqueOrThrow({ where: { id } });
    await asApp(tenantA, (tx) =>
      tx.patient.update({
        where: { id },
        data: { patientCode: same.patientCode, firstName: 'Josefina' },
      }),
    );
    const after = await raw.patient.findUniqueOrThrow({ where: { id } });
    expect(after.patientCode).toBe(same.patientCode);
    expect(after.firstName).toBe('Josefina');
  });

  it('archiving keeps the code and a new patient never reuses it', async () => {
    const { id, patientCode } = await createPatient(tenantB, 'Archivado');
    await asApp(tenantB, (tx) =>
      tx.patient.update({ where: { id }, data: { deletedAt: new Date() } }),
    );
    const next = await createPatient(tenantB, 'Siguiente');
    expect(next.patientCode).toBe(patientCode + 1);
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id } })).patientCode,
    ).toBe(patientCode);
  });

  it('a rolled-back insert gives its number back (no gaps)', async () => {
    const before = await codesOf(tenantB);
    await expect(
      asApp(tenantB, async (tx) => {
        await insertPatient(tx, tenantB, 'Deshecho');
        throw new Error('se deshace el alta');
      }),
    ).rejects.toThrow('se deshace el alta');
    const next = await createPatient(tenantB, 'Tras deshacer');
    expect(next.patientCode).toBe(Math.max(...before) + 1);
  });

  it('the database rejects a repeated code in a clinic (unique index) and a code ≤ 0 (CHECK)', async () => {
    const constraints = await raw.$queryRaw<{ name: string; def: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
       WHERE conrelid = 'public.patients'::regclass
         AND conname = 'patients_patient_code_check' AND convalidated`;
    expect(constraints).toEqual([
      {
        name: 'patients_patient_code_check',
        def: 'CHECK ((("patientCode" IS NOT NULL) AND ("patientCode" > 0)))',
      },
    ]);
    const [index] = await raw.$queryRaw<{ def: string; valid: boolean }[]>`
      SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
        FROM pg_index i
       WHERE i.indexrelid = 'public.patients_tenant_patient_code_key'::regclass`;
    expect(index).toEqual({
      def: 'CREATE UNIQUE INDEX patients_tenant_patient_code_key ON public.patients USING btree ("tenantId", "patientCode")',
      valid: true,
    });
    const [column] = await raw.$queryRaw<{ nullable: string }[]>`
      SELECT is_nullable AS nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'patients'
         AND column_name = 'patientCode'`;
    expect(column.nullable).toBe('NO');
  });

  it('the app role cannot delete a counter, and only sees its own clinic', async () => {
    await expect(
      asApp(
        tenantA,
        (tx) =>
          tx.$executeRaw`DELETE FROM "patient_code_counters" WHERE "tenantId" = ${tenantA}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    const visible = await asApp(tenantA, (tx) =>
      tx.patientCodeCounter.findMany({ select: { tenantId: true } }),
    );
    expect(visible).toEqual([{ tenantId: tenantA }]);
    // Sin clínica fijada no ve ningún contador.
    expect(await appRole.patientCodeCounter.count()).toBe(0);
  });

  it('deleting a clinic after its patients also deletes its counter (cleanups and closures)', async () => {
    const gone = await raw.tenant.create({
      data: { name: 'Clínica DX-484 de baja', subdomain: SUBDOMAIN_GONE },
      select: { id: true },
    });
    await createPatient(gone.id, 'Temporal');
    await raw.patient.deleteMany({ where: { tenantId: gone.id } });
    await raw.tenant.delete({ where: { id: gone.id } });
    expect(
      await raw.patientCodeCounter.count({ where: { tenantId: gone.id } }),
    ).toBe(0);
  });

  it('six inserts at the same time in one clinic get six distinct consecutive codes', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createPatient(tenantC, `Paralelo ${i}`),
      ),
    );
    const codes = created.map((p) => p.patientCode).sort((x, y) => x - y);
    expect(codes).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await codesOf(tenantC)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('an insert waits for an uncommitted one of the same clinic and takes the next number', async () => {
    const inserted = gate<string>();
    const release = gate();
    const first = settle(
      asApp(
        tenantC,
        async (tx) => {
          const p = await insertPatient(tx, tenantC, 'Primero');
          inserted.open(await transactionId(tx));
          await release.wait;
          return p;
        },
        { timeout: 15_000 },
      ),
    );
    const xid = await inserted.wait;
    const second = settle(createPatient(tenantC, 'Segundo'));
    const third = settle(createPatient(tenantC, 'Tercero'));
    try {
      // Las dos esperan la fila del contador que tiene la primera (pg_locks).
      await waitForTransactionWaiters(raw, xid, 2);
    } finally {
      release.open();
    }
    const results = await Promise.all([first, second, third]);
    const codes = results.map((r) => {
      if (r.status !== 'fulfilled') throw r.reason;
      return r.value.patientCode;
    });
    expect(codes[0]).toBe(7);
    expect(codes.slice(1).sort((x, y) => x - y)).toEqual([8, 9]);
    const all = await codesOf(tenantC);
    expect(new Set(all).size).toBe(all.length);
  });
});
