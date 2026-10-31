import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentMethodRepository } from '../src/modules/payment-methods/infrastructure/prisma-payment-method.repository';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-377, capa DB: el catálogo de medios de pago (RLS FORCE, sin DELETE para
// la app), la búsqueda de referencias repetidas que no cruza clínicas, y el
// relleno de la migración sobre una BD desechable con abonos anteriores.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const methods = new PrismaPaymentMethodRepository(prisma, tenantContext);
const ROOT = join(__dirname, '..');
const SUBDOMAINS = ['dx377-int-a', 'dx377-int-b'];

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  planId: string;
}

/**
 * Clínica, sede, paciente y plan; `db` puede ser la BD desechable. En ella
 * (`beforeDx377`) aún no existen las columnas de sede de DX-329, que van
 * después: la sede se crea sin región y se pide solo su id.
 */
async function seedClinic(
  db: PrismaClient,
  subdomain: string,
  beforeDx377 = false,
): Promise<Seeded> {
  // SQL y no `db.tenant.create`: la BD está migrada solo hasta esta migración y
  // el cliente insertaría columnas de tenant posteriores (p. ej. DX-253).
  const [tenant] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
    VALUES (gen_random_uuid(), ${subdomain}, ${subdomain}, now())
    RETURNING "id"`;
  const { defaultPhoneRegion: _region, ...regional } = REGIONAL_BOGOTA_FIXTURE;
  const location = await db.location.create({
    data: beforeDx377
      ? { ...regional, tenantId: tenant.id, name: 'Sede' }
      : locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId: tenant.id,
          name: 'Sede',
        }),
    select: { id: true },
  });
  const patient = await db.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const plan = await db.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    planId: plan.id,
  };
}

/** Un abono por SQL (sirve también antes de las columnas de DX-377). */
async function insertPayment(
  db: PrismaClient,
  c: Seeded,
  method: string | null,
  extra: { paymentMethodId?: string; referenceNormalized?: string } = {},
): Promise<string> {
  const [{ id }] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId",
       "patientId", "amount", "currency", "paidAt", "method", "updatedAt"
       ${extra.paymentMethodId ? ', "paymentMethodId", "reference", "referenceNormalized"' : ''})
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1000,
       'COP', now(), $5::"PaymentMethod", now()
       ${extra.paymentMethodId ? ', $6::uuid, $7, $7' : ''})
     RETURNING "id"`,
    c.tenantId,
    c.locationId,
    c.planId,
    c.patientId,
    method,
    ...(extra.paymentMethodId
      ? [extra.paymentMethodId, extra.referenceNormalized]
      : []),
  );
  return id;
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.payment.deleteMany({ where });
  await raw.clinicPaymentMethod.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('DX-377 · medios de pago contra Postgres (int)', () => {
  let a: Seeded;
  let b: Seeded;
  let mobileA: string;
  let mobileB: string;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(raw, SUBDOMAINS[0]);
    b = await seedClinic(raw, SUBDOMAINS[1]);
    mobileA = (
      await raw.clinicPaymentMethod.create({
        data: { tenantId: a.tenantId, name: 'Pago móvil', kind: 'DIGITAL' },
      })
    ).id;
    mobileB = (
      await raw.clinicPaymentMethod.create({
        data: { tenantId: b.tenantId, name: 'Pago móvil', kind: 'DIGITAL' },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('RLS: cada clínica solo ve sus medios', async () => {
    const seen = await tenantContext.run(a.tenantId, undefined, () =>
      methods.list({ includeInactive: true }),
    );
    expect(seen.map((m) => m.id)).toEqual([mobileA]);
    const other = await tenantContext.run(a.tenantId, undefined, () =>
      methods.findById(mobileB),
    );
    expect(other).toBeNull();
  });

  it('RLS: la app no puede escribir un medio de otra clínica ni borrar medios', async () => {
    await expect(
      tenantContext.run(a.tenantId, undefined, () =>
        prisma.runWithTenant((tx) =>
          tx.clinicPaymentMethod.create({
            data: { tenantId: b.tenantId, name: 'Intruso', kind: 'OTHER' },
          }),
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      tenantContext.run(a.tenantId, undefined, () =>
        prisma.runWithTenant(
          (tx) =>
            tx.$executeRaw`DELETE FROM "payment_methods" WHERE "id" = ${mobileA}::uuid`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('FK compuesta: un abono no puede usar el medio de otra clínica', async () => {
    await expect(
      insertPayment(raw, a, 'TRANSFER', {
        paymentMethodId: mobileB,
        referenceNormalized: 'X1',
      }),
    ).rejects.toThrow(/payments_payment_method_fkey/);
  });

  it('la búsqueda de referencias repetidas no cruza clínicas', async () => {
    await insertPayment(raw, b, 'TRANSFER', {
      paymentMethodId: mobileB,
      referenceNormalized: 'REF777',
    });
    const repo = new PrismaPaymentRepository(prisma, tenantContext);
    const window = {
      referenceNormalized: 'REF777',
      from: new Date(Date.now() - 86_400_000),
      to: new Date(Date.now() + 86_400_000),
    };
    // Desde A, ni con el id del medio de B (RLS) ni con el suyo.
    const fromA = await tenantContext.run(a.tenantId, undefined, async () => [
      ...(await repo.findReferenceMatches({
        ...window,
        paymentMethodId: mobileB,
      })),
      ...(await repo.findReferenceMatches({
        ...window,
        paymentMethodId: mobileA,
      })),
    ]);
    expect(fromA).toEqual([]);
    const fromB = await tenantContext.run(b.tenantId, undefined, () =>
      repo.findReferenceMatches({ ...window, paymentMethodId: mobileB }),
    );
    expect(fromB).toHaveLength(1);
  });

  it('el índice de la búsqueda existe con las columnas pedidas', async () => {
    const [index] = await raw.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE indexname = 'payments_tenant_method_reference_idx'`;
    expect(index.def).toContain(
      '("tenantId", "paymentMethodId", "referenceNormalized", "paidAt")',
    );
  });
});

describe('DX-377 · relleno de la migración (int, BD desechable)', () => {
  const FIRST = '20261103115800_dx377_enums';
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  let a: Seeded;
  let b: Seeded;
  const ids: Record<string, string> = {};

  const urlFor = (name: string): string => {
    const url = new URL(process.env.DIRECT_URL as string);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const deploy = (url: string): void => {
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: 'pipe',
      },
    );
  };

  beforeAll(async () => {
    db = `dx377_backfill_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx377-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    const all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (n) => !n.endsWith('.toml'),
    );
    const copy = (name: string): void =>
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    for (const name of all.filter((n) => n < FIRST)) copy(name);
    deploy(urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    a = await seedClinic(target, 'dx377-old-a', true);
    b = await seedClinic(target, 'dx377-old-b', true);
    ids.cashA = await insertPayment(target, a, 'CASH');
    ids.transferA = await insertPayment(target, a, 'TRANSFER');
    ids.noneA = await insertPayment(target, a, null);
    ids.cardB = await insertPayment(target, b, 'CARD');
    for (const name of all.filter((n) => n >= FIRST)) copy(name);
    deploy(urlFor(db));
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  it('cada clínica recibe los 4 medios iniciales', async () => {
    const rows = await target.clinicPaymentMethod.findMany({
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    });
    for (const t of [a.tenantId, b.tenantId]) {
      expect(
        rows
          .filter((r) => r.tenantId === t)
          .map((r) => [
            r.name,
            r.kind,
            r.legacyMethod,
            r.active,
            r.requiresReference,
          ]),
      ).toEqual([
        ['Efectivo', 'CASH', 'CASH', true, false],
        ['Otro', 'OTHER', 'OTHER', true, false],
        ['Tarjeta', 'CARD', 'CARD', true, false],
        ['Transferencia', 'TRANSFER', 'TRANSFER', true, false],
      ]);
    }
  });

  it('los abonos anteriores conservan su método y se enlazan al medio inicial de SU clínica', async () => {
    const payments = await target.payment.findMany({
      include: { paymentMethod: true },
    });
    const byId = new Map(payments.map((p) => [p.id, p]));
    expect(byId.get(ids.cashA)).toMatchObject({
      method: 'CASH',
      paymentMethod: { tenantId: a.tenantId, legacyMethod: 'CASH' },
    });
    expect(byId.get(ids.transferA)).toMatchObject({
      method: 'TRANSFER',
      paymentMethod: { tenantId: a.tenantId, legacyMethod: 'TRANSFER' },
    });
    expect(byId.get(ids.cardB)).toMatchObject({
      method: 'CARD',
      paymentMethod: { tenantId: b.tenantId, legacyMethod: 'CARD' },
    });
    expect(byId.get(ids.noneA)).toMatchObject({
      method: null,
      paymentMethodId: null,
    });
  });

  it('una réplica anterior (sin las columnas nuevas) sigue pudiendo cobrar', async () => {
    await expect(insertPayment(target, a, 'CARD')).resolves.toEqual(
      expect.any(String),
    );
  });
});
