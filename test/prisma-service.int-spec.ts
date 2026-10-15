import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// Abre una conexión real: vive en la suite de integración (`npm run test:int`,
// que carga `.env.test`), no en la unitaria, que debe correr sin base de datos.
describe('PrismaService (int)', () => {
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
