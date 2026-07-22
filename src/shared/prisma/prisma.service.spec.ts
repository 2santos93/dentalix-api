import 'dotenv/config';
import { PrismaService } from './prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';

describe('PrismaService', () => {
  const prisma = new PrismaService(new TenantContextService());

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('connects to the database', async () => {
    await prisma.onModuleInit();
    const result =
      await prisma.$queryRawUnsafe<{ ok: number }[]>('SELECT 1 as ok');
    expect(result[0].ok).toBe(1);
  });
});
