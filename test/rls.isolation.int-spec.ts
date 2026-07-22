import { PrismaClient, ClinicRole } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para fixtures (seed/cleanup
// entre tests) — usa DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS
// correctamente aplicado, una conexión sin contexto de tenant (DATABASE_URL,
// rol dentalix_app, sin BYPASSRLS) ve 0 filas y NO podría limpiar datos de
// tenants anteriores. La prueba de aislamiento en sí corre exclusivamente por
// `prisma.runWithTenant`, que usa DATABASE_URL (rol restringido, sin bypass).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(); // con runWithTenant, sujeta a RLS de verdad

async function seedTenant(subdomain: string) {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: { email: `${subdomain}@x.com`, passwordHash: 'x', fullName: 'X' },
  });
  await prisma.runWithTenant(tenant.id, (tx) =>
    tx.clinicMembership.create({
      data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.OWNER },
    }),
  );
  return tenant;
}

describe('RLS cross-tenant isolation', () => {
  let tenantA: { id: string };
  let tenantB: { id: string };

  beforeAll(async () => {
    await prisma.onModuleInit();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    tenantA = await seedTenant('clinica-a');
    tenantB = await seedTenant('clinica-b');
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('only returns memberships of the tenant in context', async () => {
    const inA = await prisma.runWithTenant(tenantA.id, (tx) =>
      tx.clinicMembership.findMany(),
    );
    expect(inA).toHaveLength(1);
    expect(inA[0].tenantId).toBe(tenantA.id);
  });

  it('tenant A cannot see tenant B rows', async () => {
    const seesB = await prisma.runWithTenant(tenantA.id, (tx) =>
      tx.clinicMembership.findMany({ where: { tenantId: tenantB.id } }),
    );
    expect(seesB).toHaveLength(0);
  });
});
