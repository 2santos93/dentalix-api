import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-226 (DB-038): la serie de recibos de una sede ("receiptPrefix", DX-136)
// es parte de la numeración legal del recibo de caja. Antes solo se protegía
// el valor ACTUAL (índice único por clínica): una sede podía cambiar su serie
// después de emitir recibos y otra sede tomar la serie libre y seguir su
// contador. Ahora:
//   - una sede con recibos o con contador no cambia su serie (check_violation);
//   - una sede sin recibos sí puede cambiarla;
//   - ninguna sede (alta o cambio) toma una serie que ya tiene recibos o
//     contador en la clínica, aunque la sede que la usó ya no la tenga;
//   - la serie derivada de una sede nueva salta las series ya usadas;
//   - emitir un recibo retiene la fila de la sede hasta el COMMIT: un cambio
//     de serie a la vez espera y, al seguir, ve el recibo y se rechaza.
// Todo corre como dentalix_app con la clínica fijada (como la API); `raw`
// (DIRECT_URL, superusuario) siembra, simula el bypass y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAINS = ['dx226-serie-a', 'dx226-serie-b'];
const CHECK_VIOLATION = /23514/;
const ISSUED = /ya emitió recibos/;
const USED = /ya se usó en recibos/;

interface Clinic {
  tenantId: string;
  mainId: string;
  patientId: string;
  planId: string;
}

let a: Clinic;
let b: Clinic;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario: los triggers dejan la purga administrativa.
  await raw.paymentReceipt.deleteMany({ where });
  await raw.paymentReceiptCounter.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const main = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  return {
    tenantId: tenant.id,
    mainId: main.id,
    patientId: patient.id,
    planId: plan.id,
  };
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

/** Lo que hace issuePaymentReceipt: abono, contador de la serie y recibo. */
async function emit(
  tx: Prisma.TransactionClient,
  clinic: Clinic,
  locationId: string,
): Promise<string> {
  const [{ id: paymentId }] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId",
      "amount", "currency", "paidAt", "updatedAt")
    VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${locationId}::uuid, ${clinic.planId}::uuid,
      ${clinic.patientId}::uuid, 1000, 'COP', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
    RETURNING "id"`;
  const [{ prefix }] = await tx.$queryRaw<{ prefix: string }[]>`
    SELECT "receiptPrefix" AS prefix FROM "locations" WHERE "id" = ${locationId}::uuid`;
  const [{ lastNumber }] = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
    VALUES (${clinic.tenantId}::uuid, ${prefix}, 1)
    ON CONFLICT ("tenantId", "seriesPrefix")
    DO UPDATE SET "lastNumber" = "payment_receipt_counters"."lastNumber" + 1
    RETURNING "lastNumber"`;
  await tx.$executeRaw`
    INSERT INTO "payment_receipts" ("id", "tenantId", "locationId", "paymentId", "seriesPrefix", "number", "snapshot")
    VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, ${locationId}::uuid, ${paymentId}::uuid,
      ${prefix}, ${lastNumber}, '{"version": 1}'::jsonb)`;
  return `${prefix}-${lastNumber}`;
}

function setPrefix(clinic: Clinic, locationId: string, prefix: string | null) {
  return asApp(
    clinic.tenantId,
    (tx) =>
      tx.$executeRaw`UPDATE "locations" SET "receiptPrefix" = ${prefix} WHERE "id" = ${locationId}::uuid`,
  );
}

function newLocation(clinic: Clinic, name: string, prefix?: string) {
  return asApp(clinic.tenantId, (tx) =>
    tx.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: clinic.tenantId,
        name,
        receiptPrefix: prefix,
      }),
      select: { id: true, receiptPrefix: true },
    }),
  );
}

async function prefixOf(locationId: string): Promise<string | null> {
  const row = await raw.location.findUniqueOrThrow({
    where: { id: locationId },
    select: { receiptPrefix: true },
  });
  return row.receiptPrefix;
}

/** Una promesa que se resuelve desde fuera (para ordenar dos transacciones). */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Espera (hasta 10 s) a que un UPDATE de la serie quede bloqueado. */
async function waitForBlockedUpdate(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM pg_catalog.pg_stat_activity
       WHERE datname = pg_catalog.current_database()
         AND wait_event_type = 'Lock'
         AND query LIKE 'UPDATE "locations" SET "receiptPrefix"%'`;
    if (row.n > 0) return;
    if (Date.now() > deadline) {
      throw new Error('el cambio de serie no llegó a esperar al recibo');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('serie de recibos de la sede inmutable (DX-226, int)', () => {
  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([raw.$disconnect(), appRole.$disconnect()]);
  });

  it('una sede sin recibos puede cambiar su serie (y volver a la anterior)', async () => {
    const north = await newLocation(a, 'Sede Norte');
    expect(north.receiptPrefix).toBe('NOR');
    await setPrefix(a, north.id, 'NTE');
    expect(await prefixOf(north.id)).toBe('NTE');
    await setPrefix(a, north.id, 'NOR');
    expect(await prefixOf(north.id)).toBe('NOR');
  });

  it('una sede que ya emitió recibos no cambia su serie: check_violation, también para el superusuario', async () => {
    await asApp(a.tenantId, (tx) => emit(tx, a, a.mainId));
    await expect(setPrefix(a, a.mainId, 'PRX')).rejects.toThrow(
      CHECK_VIOLATION,
    );
    await expect(setPrefix(a, a.mainId, 'PRX')).rejects.toThrow(ISSUED);
    // Tampoco quitársela.
    await expect(setPrefix(a, a.mainId, null)).rejects.toThrow(ISSUED);
    await expect(
      raw.$executeRaw`UPDATE "locations" SET "receiptPrefix" = 'PRX' WHERE "id" = ${a.mainId}::uuid`,
    ).rejects.toThrow(ISSUED);
    expect(await prefixOf(a.mainId)).toBe('PRI');
    // Un UPDATE de otra columna (o con la misma serie) sigue funcionando.
    await asApp(
      a.tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE "locations" SET "receiptPrefix" = 'PRI', "address" = 'Calle 2' WHERE "id" = ${a.mainId}::uuid`,
    );
  });

  it('una sede con contador (sin recibo todavía) tampoco cambia su serie', async () => {
    const west = await newLocation(a, 'Sede Occidente');
    expect(west.receiptPrefix).toBe('OCC');
    await asApp(
      a.tenantId,
      (tx) =>
        tx.$executeRaw`
        INSERT INTO "payment_receipt_counters" ("tenantId", "seriesPrefix", "lastNumber")
        VALUES (${a.tenantId}::uuid, 'OCC', 1)`,
    );
    await expect(setPrefix(a, west.id, 'OCX')).rejects.toThrow(ISSUED);
  });

  describe('una serie usada en recibos no la toma otra sede, aunque la que la usó la haya cambiado', () => {
    beforeAll(async () => {
      // La sede principal ya no tiene la serie PRI (se salta la guarda como
      // superusuario con los triggers desactivados: lo único que podría
      // dejarla así).
      await raw.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`UPDATE "locations" SET "receiptPrefix" = 'PRX' WHERE "id" = ${a.mainId}::uuid`;
      });
    });

    it('cambio de serie de otra sede a la serie usada: check_violation', async () => {
      const south = await newLocation(a, 'Sede Sur');
      await expect(setPrefix(a, south.id, 'PRI')).rejects.toThrow(
        CHECK_VIOLATION,
      );
      await expect(setPrefix(a, south.id, 'PRI')).rejects.toThrow(USED);
      // Ni la serie de solo contador.
      await expect(setPrefix(a, south.id, 'OCC')).rejects.toThrow(USED);
      expect(await prefixOf(south.id)).toBe('SUR');
    });

    it('alta de sede con la serie usada: check_violation', async () => {
      await expect(newLocation(a, 'Sede Copia', 'PRI')).rejects.toThrow(USED);
    });

    it('la serie derivada de una sede nueva salta la usada', async () => {
      const second = await newLocation(a, 'Principal');
      expect(second.receiptPrefix).toBe('PRI2');
    });

    it('otra clínica sí puede usar la misma serie', async () => {
      expect(await prefixOf(b.mainId)).toBe('PRI');
      await asApp(b.tenantId, (tx) => emit(tx, b, b.mainId));
    });
  });

  it('un cambio de serie a la vez que una emisión espera al recibo y, al seguir, se rechaza', async () => {
    const east = await newLocation(a, 'Sede Oriente');
    expect(east.receiptPrefix).toBe('ORI');
    const emitted = gate();
    const release = gate();
    const emission = asApp(
      a.tenantId,
      async (tx) => {
        const number = await emit(tx, a, east.id);
        emitted.open();
        await release.wait;
        return number;
      },
      { timeout: 15_000 },
    );
    // Si la emisión falla, que el test falle en vez de quedarse esperando.
    await Promise.race([emitted.wait, emission]);
    const change = setPrefix(a, east.id, 'ORX');
    change.catch(() => undefined);
    try {
      await waitForBlockedUpdate();
    } finally {
      release.open();
    }
    await expect(emission).resolves.toBe('ORI-1');
    await expect(change).rejects.toThrow(ISSUED);
    expect(await prefixOf(east.id)).toBe('ORI');
  });

  it('un recibo de una serie que ya no es la de la sede se rechaza', async () => {
    // La sede principal tiene ahora PRX (beforeAll de arriba): un recibo con
    // la serie vieja no pasa la guarda del recibo.
    await expect(
      asApp(a.tenantId, async (tx) => {
        const [{ id: paymentId }] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId",
            "amount", "currency", "paidAt", "updatedAt")
          VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${a.mainId}::uuid, ${a.planId}::uuid,
            ${a.patientId}::uuid, 1000, 'COP', now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
          RETURNING "id"`;
        await tx.$executeRaw`
          UPDATE "payment_receipt_counters" SET "lastNumber" = "lastNumber" + 1
           WHERE "tenantId" = ${a.tenantId}::uuid AND "seriesPrefix" = 'PRI'`;
        await tx.$executeRaw`
          INSERT INTO "payment_receipts" ("id", "tenantId", "locationId", "paymentId", "seriesPrefix", "number", "snapshot")
          VALUES (gen_random_uuid(), ${a.tenantId}::uuid, ${a.mainId}::uuid, ${paymentId}::uuid,
            'PRI', 2, '{"version": 1}'::jsonb)`;
      }),
    ).rejects.toThrow(/no es la de la sede/);
  });
});
