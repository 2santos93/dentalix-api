import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';

// DX-322: la API no lee ni expone `patients."legacyInsurerName"` (el texto
// libre de aseguradora anterior a DX-153, ya copiado a coberturas); la columna
// sigue en la BD, congelada (migración 20261110130000 la renombró). `raw`
// (DIRECT_URL, owner) siembra y limpia; el repositorio corre por la ruta de
// la app.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx322-insurer-eps';

describe('patient legacy insurer text (frozen column)', () => {
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

  it('the column is kept, renamed, with its data type', async () => {
    const columns = await raw.$queryRaw<
      { data_type: string; is_nullable: string }[]
    >`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'patients'
         AND column_name = 'legacyInsurerName'`;
    expect(columns).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
    const old = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%Eps%'`;
    expect(old).toEqual([{ n: 0 }]);
  });

  it('the Prisma client does not select the legacy insurer text', async () => {
    const row = await raw.patient.findFirstOrThrow({
      where: { id: patientId },
    });
    expect(Object.keys(row)).not.toContain('legacyInsurerName');
  });

  it('a raw row with the legacy insurer text reads back through the repository without the field', async () => {
    await raw.$executeRaw`
      UPDATE patients SET "legacyInsurerName" = 'Texto anterior' WHERE id = ${patientId}::uuid`;

    const p = await tenantContext.run(tenantId, () => repo.findById(patientId));

    expect(p).not.toBeNull();
    expect(p).not.toHaveProperty('legacyInsurerName');
  });
});
