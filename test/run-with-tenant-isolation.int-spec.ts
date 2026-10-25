import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// Conexión admin (DIRECT_URL) solo para sembrar/limpiar el tenant.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

async function isolationOf(
  prisma: PrismaService,
  tenantId: string,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<string> {
  const rows = await prisma.runWithTenant(
    tenantId,
    (tx) =>
      tx.$queryRaw<
        { transaction_isolation: string }[]
      >`SHOW transaction_isolation`,
    options,
  );
  return rows[0].transaction_isolation;
}

describe('PrismaService.runWithTenant — isolationLevel (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (
      await raw.tenant.create({
        data: { name: 'Clínica Aislamiento', subdomain: 'isolation-int' },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('sin opciones mantiene el nivel por defecto de Postgres (read committed)', async () => {
    expect(await isolationOf(prisma, tenantId)).toBe('read committed');
  });

  it('con RepeatableRead abre la transacción en repeatable read', async () => {
    expect(
      await isolationOf(prisma, tenantId, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      }),
    ).toBe('repeatable read');
  });

  it('la forma con tenant del contexto también acepta el nivel', async () => {
    const level = await tenantContext.run(tenantId, undefined, () =>
      prisma.runWithTenant(
        async (tx) =>
          (
            await tx.$queryRaw<
              { transaction_isolation: string }[]
            >`SHOW transaction_isolation`
          )[0].transaction_isolation,
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    );
    expect(level).toBe('repeatable read');
  });
});
