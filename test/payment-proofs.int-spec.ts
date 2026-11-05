import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPaymentRepository } from '../src/modules/payments/infrastructure/repositories/prisma-payment.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-389, capa DB del comprobante del cobro: RLS FORCE de payment_proofs (una
// clínica no ve el objeto de otra), FK compuesta por clínica (un comprobante
// no se cuelga de un abono ajeno), una clave de almacén por fila, como mucho
// un comprobante por abono y append-only para el rol de la app. Las
// escrituras y lecturas van por la ruta de la app (runWithTenant, rol
// dentalix_app); `raw` (DIRECT_URL) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const context = new TenantContextService();
const prisma = new PrismaService(context);
const repo = new PrismaPaymentRepository(prisma, context);
const SUBDOMAINS = ['proof-int-a', 'proof-int-b'];

interface Seeded {
  tenantId: string;
  paymentId: string;
}

const proofData = (tenantId: string, paymentId: string, key: string) => ({
  tenantId,
  paymentId,
  key,
  mime: 'image/png',
  size: 120,
  sha256: 'c'.repeat(64),
  name: 'captura.png',
});

async function purge(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.paymentProof.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function seed(subdomain: string): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Prueba' },
  });
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
  });
  const payment = await raw.payment.create({
    data: {
      tenantId: tenant.id,
      locationId: location.id,
      treatmentPlanId: plan.id,
      patientId: patient.id,
      amount: 50,
      currency: 'USD',
      paidAt: new Date('2026-11-04T16:00:00.000Z'),
    },
  });
  return { tenantId: tenant.id, paymentId: payment.id };
}

describe('payment_proofs en la BD (DX-389)', () => {
  let a: Seeded;
  let b: Seeded;
  const keyA = `payment-proofs/${randomUUID()}/${randomUUID()}-cccccccccccccccc.png`;
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    context.run(tenantId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    a = await seed(SUBDOMAINS[0]);
    b = await seed(SUBDOMAINS[1]);
    await raw.paymentProof.create({
      data: proofData(a.tenantId, a.paymentId, keyA),
    });
  });

  afterAll(async () => {
    await purge();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('la clínica dueña ve el comprobante de su abono y su clave', async () => {
    const found = await inTenant(a.tenantId, () => repo.findProof(a.paymentId));
    expect(found?.attachment.key).toBe(keyA);
    expect(await inTenant(a.tenantId, () => repo.proofKeyInUse(keyA))).toBe(
      true,
    );
  });

  it('otra clínica no ve el objeto: ni por abono ni por clave', async () => {
    expect(
      await inTenant(b.tenantId, () => repo.findProof(a.paymentId)),
    ).toBeNull();
    expect(await inTenant(b.tenantId, () => repo.proofKeyInUse(keyA))).toBe(
      false,
    );
    const rows = await inTenant(b.tenantId, () =>
      prisma.runWithTenant((tx) => tx.paymentProof.findMany()),
    );
    expect(rows).toEqual([]);
  });

  it('RLS FORCE: la app no escribe filas de otra clínica (WITH CHECK)', async () => {
    await expect(
      inTenant(b.tenantId, () =>
        prisma.runWithTenant((tx) =>
          tx.paymentProof.create({
            data: proofData(a.tenantId, a.paymentId, `x/${randomUUID()}.png`),
          }),
        ),
      ),
    ).rejects.toThrow();
  });

  it('la FK compuesta no deja colgar un comprobante de un abono de otra clínica', async () => {
    await expect(
      raw.paymentProof.create({
        data: proofData(b.tenantId, a.paymentId, `x/${randomUUID()}.png`),
      }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('como mucho un comprobante por abono y una fila por clave', async () => {
    await expect(
      raw.paymentProof.create({
        data: proofData(a.tenantId, a.paymentId, `x/${randomUUID()}.png`),
      }),
    ).rejects.toThrow(/unique/i);
    await expect(
      raw.paymentProof.create({
        data: proofData(b.tenantId, b.paymentId, keyA),
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('CHECK: solo JPG, PNG, WebP o PDF de hasta 10 MB y huella hex', async () => {
    const base = proofData(b.tenantId, b.paymentId, `x/${randomUUID()}.bin`);
    await expect(
      raw.paymentProof.create({ data: { ...base, mime: 'image/svg+xml' } }),
    ).rejects.toThrow(/check/i);
    await expect(
      raw.paymentProof.create({
        data: { ...base, size: 10 * 1024 * 1024 + 1 },
      }),
    ).rejects.toThrow(/check/i);
    await expect(
      raw.paymentProof.create({ data: { ...base, sha256: 'zz' } }),
    ).rejects.toThrow(/check/i);
    await raw.paymentProof.create({ data: { ...base, mime: 'image/webp' } });
    await raw.paymentProof.deleteMany({ where: { paymentId: b.paymentId } });
  });

  it('append-only para el rol de la app: ni UPDATE ni DELETE', async () => {
    await expect(
      inTenant(a.tenantId, () =>
        prisma.runWithTenant((tx) =>
          tx.paymentProof.updateMany({
            where: { paymentId: a.paymentId },
            data: { key: 'otra' },
          }),
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      inTenant(a.tenantId, () =>
        prisma.runWithTenant((tx) =>
          tx.$executeRawUnsafe('DELETE FROM "payment_proofs"'),
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
