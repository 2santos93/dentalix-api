import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';

// DX-322 fase 1: la API deja de leer y exponer `patients."insurerEps"` (el
// texto libre de aseguradora anterior a DX-153), pero la columna sigue en la
// BD para las réplicas anteriores; la fase 2 la borra. `raw` (DIRECT_URL,
// owner) siembra y limpia; el repositorio corre por la ruta de la app.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx322-insurer-eps';

describe('patient insurerEps phase 1', () => {
  let tenantId: string;
  let patientId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    // Restos de una corrida interrumpida.
    const stale = await raw.tenant.findMany({
      where: { subdomain: SUBDOMAIN },
    });
    const staleIds = stale.map((t) => t.id);
    await raw.patient.deleteMany({ where: { tenantId: { in: staleIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: staleIds } } });
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    patientId = (
      await raw.patient.create({
        data: { tenantId, firstName: 'Legada', lastName: 'DX322' },
      })
    ).id;
  });

  afterAll(async () => {
    await raw.patient.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('the column still exists for older replicas', async () => {
    const columns = await raw.$queryRaw<
      { data_type: string; is_nullable: string }[]
    >`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'patients'
         AND column_name = 'insurerEps'`;
    expect(columns).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  it('the Prisma client no longer selects insurerEps', async () => {
    const row = await raw.patient.findFirstOrThrow({
      where: { id: patientId },
    });
    expect(Object.keys(row)).not.toContain('insurerEps');
  });

  it('a raw row with insurerEps reads back through the repository without the field', async () => {
    await raw.$executeRaw`
      UPDATE patients SET "insurerEps" = 'Texto anterior' WHERE id = ${patientId}::uuid`;

    const p = await tenantContext.run(tenantId, () => repo.findById(patientId));

    expect(p).not.toBeNull();
    expect(p).not.toHaveProperty('insurerEps');
  });
});
