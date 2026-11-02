import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-527: el trigger de cartera de `patients` (patient_ledgers_refresh) no
// calcula la cartera de quien no tiene fila en `patient_ledgers`. Deshacer un
// lote de 10.000 recién importados (ninguno con plan ni saldo) la calculaba
// 10.000 veces para no escribir ninguna, y ese coste dependía de las
// estadísticas del momento (16–23 s en el primer intento del e2e de la web,
// 0,8 s al reintentar).
//
// No mide tiempo (sería una flake más): cuenta, dentro de la propia
// transacción, cuántos recorridos hicieron las tablas que lee el cálculo de
// la cartera (`pg_stat_get_xact_numscans`). Es un hecho del plan, no de la
// máquina. La ruta es la de la app (runWithTenant, rol dentalix_app, RLS);
// `raw` (DIRECT_URL, owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'ledgers-refresh-skip';
const LEDGERLESS = 300;
/** Tablas que solo lee `patient_ledgers_compute()` (no el resto del refresco). */
const COMPUTE_ONLY_TABLES = [
  'appointments',
  'payments',
  'payment_plans',
  'installments',
  'patient_credit_entries',
  'treatment_plan_items',
  'treatment_plan_acceptances',
];

let tenantId: string;
let ledgerless: string[];
let withPlan: string;

async function purge(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.patientLedger.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

/** Recorridos (secuenciales + por índice) de cada tabla en la transacción en curso. */
async function scans(
  tx: Prisma.TransactionClient,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of COMPUTE_ONLY_TABLES) {
    const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT pg_stat_get_xact_numscans('public.${table}'::regclass)::int AS n`,
    );
    out[table] = n;
  }
  return out;
}

const retire = (tx: Prisma.TransactionClient, ids: string[]) =>
  tx.$executeRaw`
    UPDATE "patients"
       SET "deletedAt" = timezone('UTC', now()), "updatedAt" = timezone('UTC', now())
     WHERE "tenantId" = ${tenantId}::uuid AND "id" = ANY(${ids}::uuid[])`;

describe('DX-527: el refresco de cartera no calcula la de quien no tiene fila (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    const tenant = await raw.tenant.create({
      data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
    });
    tenantId = tenant.id;
    const mk = (i: number) => ({
      tenantId,
      documentType: 'NATIONAL_ID' as const,
      docNumber: `5270${String(i).padStart(5, '0')}`,
      firstName: `Paciente${i}`,
      lastName: 'Sin cartera',
    });
    await raw.patient.createMany({
      data: Array.from({ length: LEDGERLESS + 1 }, (_, i) => mk(i)),
    });
    const patients = await raw.patient.findMany({
      where: { tenantId },
      orderBy: { docNumber: 'asc' },
      select: { id: true },
    });
    withPlan = patients[0].id;
    ledgerless = patients.slice(1).map((p) => p.id);
    // Un plan crea la fila de cartera de ese paciente (trigger de planes).
    await raw.treatmentPlan.create({
      data: { tenantId, patientId: withPlan, currency: 'USD' },
    });
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('precondición: solo el paciente con plan tiene fila de cartera', async () => {
    const rows = await raw.patientLedger.findMany({ where: { tenantId } });
    expect(rows.map((r) => r.patientId)).toEqual([withPlan]);
  });

  it('retirar 300 pacientes sin fila de cartera no recorre ninguna tabla del cálculo', async () => {
    const seen = await tenantContext.run(tenantId, () =>
      prisma.runWithTenant(async (tx) => {
        const before = await scans(tx);
        const updated = await retire(tx, ledgerless);
        expect(updated).toBe(LEDGERLESS);
        const after = await scans(tx);
        return COMPUTE_ONLY_TABLES.map(
          (t) => [t, after[t] - before[t]] as const,
        );
      }),
    );
    expect(seen).toEqual(COMPUTE_ONLY_TABLES.map((t) => [t, 0]));
  });

  it('sigue refrescando la cartera de quien sí tiene fila (y el contador mide de verdad)', async () => {
    const [before] = await raw.patientLedger.findMany({
      where: { tenantId, patientId: withPlan },
    });
    await new Promise((r) => setTimeout(r, 15));
    const seen = await tenantContext.run(tenantId, () =>
      prisma.runWithTenant(async (tx) => {
        const base = await scans(tx);
        await retire(tx, [withPlan]);
        const after = await scans(tx);
        return COMPUTE_ONLY_TABLES.reduce(
          (sum, t) => sum + (after[t] - base[t]),
          0,
        );
      }),
    );
    expect(seen).toBeGreaterThan(0);
    const [after] = await raw.patientLedger.findMany({
      where: { tenantId, patientId: withPlan },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
    expect(after.owing).toBe(false);
  });
});
