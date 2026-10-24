import { Prisma, PrismaClient } from '@prisma/client';

// DX-216: la serie de recibos de la sede ("receiptPrefix", DX-136) la elige
// un trigger BEFORE INSERT mirando las series ya usadas en la clínica. Sin
// orden entre altas simultáneas, dos sedes de la misma clínica podían elegir
// la misma serie y la segunda fallaba con «Unique constraint failed on
// (tenantId, receiptPrefix)» (lo que tumbaba domain-checks.int-spec.ts, que
// crea "Sede A" y "Sede B" a la vez: las dos derivan "SED"). El trigger toma
// ahora un candado consultivo POR CLÍNICA hasta el final de la transacción.
//
// Las altas van como dentalix_app con la clínica fijada (como la API) y con
// un pool de 12 conexiones: las 10 altas corren de verdad a la vez. `raw`
// (DIRECT_URL, superusuario) solo siembra, lee y limpia.
function withPool(url: string | undefined, size: number): string {
  const u = new URL(url ?? '');
  u.searchParams.set('connection_limit', String(size));
  return u.toString();
}

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: withPool(process.env.DATABASE_URL, 12) } },
});

const SUBDOMAINS = ['dx216-int-a', 'dx216-int-b'];

let tenantA: string;
let tenantB: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await raw.location.deleteMany({ where: { tenantId: { in: ids } } });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
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

function createLocation(
  tenantId: string,
  name: string,
  tx?: Prisma.TransactionClient,
) {
  const run = (client: Prisma.TransactionClient) =>
    client.location.create({
      data: { tenantId, name },
      select: { id: true, receiptPrefix: true },
    });
  return tx ? run(tx) : asApp(tenantId, run);
}

async function prefixesOf(tenantId: string): Promise<string[]> {
  const rows = await raw.location.findMany({
    where: { tenantId },
    select: { receiptPrefix: true },
  });
  return rows.map((r) => r.receiptPrefix ?? '');
}

/**
 * Sesiones con el candado consultivo de la clínica (clave doble del trigger)
 * concedido (`granted`) o esperándolo. pg_locks guarda cada int4 de la clave
 * como oid (sin signo).
 */
async function advisoryLocks(
  tenantId: string,
  granted: boolean,
): Promise<number> {
  const [row] = await raw.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM pg_catalog.pg_locks
     WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_catalog.pg_database
                        WHERE datname = pg_catalog.current_database())
       AND objsubid = 2
       AND classid::bigint = (pg_catalog.hashtext('dx_location_receipt_prefix')::bigint & 4294967295)
       AND objid::bigint = (pg_catalog.hashtext(${tenantId})::bigint & 4294967295)
       AND granted = ${granted}`;
  return row.n;
}

/** Espera (hasta 10 s) a que una sesión quede bloqueada en el candado. */
async function waitForAdvisoryWaiter(tenantId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await advisoryLocks(tenantId, false)) === 0) {
    if (Date.now() > deadline) {
      throw new Error('ninguna alta llegó a esperar el candado de la clínica');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Una promesa que se resuelve desde fuera (para ordenar dos transacciones). */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('DX-216 · serie de recibos de la sede ante altas concurrentes (int)', () => {
  beforeAll(async () => {
    await cleanup();
    tenantA = (
      await raw.tenant.create({
        data: { name: 'Clínica DX-216 A', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    tenantB = (
      await raw.tenant.create({
        data: { name: 'Clínica DX-216 B', subdomain: SUBDOMAINS[1] },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), appRole.$disconnect()]);
  });

  it('10 sedes con el mismo nombre creadas a la vez en la misma clínica: todas se crean con series distintas', async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, () => createLocation(tenantA, 'Sede Centro')),
    );
    const prefixes = created.map((l) => l.receiptPrefix);
    // "Sede Centro" no tiene palabras útiles: base "SED" (DX-136).
    expect(new Set(prefixes).size).toBe(10);
    expect([...prefixes].sort()).toEqual(
      [
        'SED',
        'SED2',
        'SED3',
        'SED4',
        'SED5',
        'SED6',
        'SED7',
        'SED8',
        'SED9',
        'SED10',
      ].sort(),
    );
    expect((await prefixesOf(tenantA)).sort()).toEqual([...prefixes].sort());
  });

  it('10 sedes con nombres distintos que chocan en la base ("Sede A", "Sede B"…) a la vez: series distintas', async () => {
    const names = 'ABCDEFGHIJ'.split('').map((l) => `Sede ${l}`);
    const created = await Promise.all(
      names.map((name) => createLocation(tenantA, name)),
    );
    const prefixes = created.map((l) => l.receiptPrefix);
    expect(new Set(prefixes).size).toBe(10);
    // Siguen la serie "SED" que dejó el caso anterior, sin repetir ninguna.
    const all = await prefixesOf(tenantA);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20);
  });

  it('una alta que espera a otra sin confirmar de la misma clínica ve su serie al seguir y toma la siguiente', async () => {
    const inserted = gate();
    const release = gate();
    const first = asApp(
      tenantA,
      async (tx) => {
        const l = await createLocation(tenantA, 'Sede Sur', tx);
        inserted.open();
        await release.wait;
        return l;
      },
      { timeout: 15000 },
    );
    // Si la primera falla, que el test falle en vez de quedarse esperando.
    await Promise.race([inserted.wait, first]);
    const second = createLocation(tenantA, 'Sede Sur');
    // La segunda queda esperando el candado de la clínica (se comprueba en
    // pg_locks, no con una pausa: así la carrera ocurre siempre); se suelta la
    // primera y la segunda sigue con un snapshot nuevo (sin el candado, choca
    // con el índice único).
    // Pase lo que pase, se suelta la primera: sin el candado la segunda
    // esperaría al índice único y el test se colgaría en vez de fallar.
    try {
      await waitForAdvisoryWaiter(tenantA);
    } finally {
      release.open();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a.receiptPrefix).toBe('SUR');
    expect(b.receiptPrefix).toBe('SUR2');
  });

  it('el candado es por clínica: otra clínica crea su sede sin esperar', async () => {
    const inserted = gate();
    const release = gate();
    const holder = asApp(
      tenantA,
      async (tx) => {
        await createLocation(tenantA, 'Sede Oriente', tx);
        inserted.open();
        await release.wait;
      },
      { timeout: 15000 },
    );
    await Promise.race([inserted.wait, holder]);
    try {
      // La primera retiene de verdad el candado de su clínica.
      expect(await advisoryLocks(tenantA, true)).toBe(1);
      // Con lock_timeout corto: si esperara el candado de A, fallaría.
      const other = await asApp(tenantB, async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        return createLocation(tenantB, 'Sede Oriente', tx);
      });
      expect(other.receiptPrefix).toBe('ORI');
    } finally {
      release.open();
      await holder;
    }
  });

  it('una serie explícita que choca con otra de la clínica sigue rechazándose por el índice único', async () => {
    await expect(
      asApp(tenantA, (tx) =>
        tx.location.create({
          data: { tenantId: tenantA, name: 'Sede Copia', receiptPrefix: 'SUR' },
        }),
      ),
    ).rejects.toThrow(/Unique constraint failed/);
  });
});
