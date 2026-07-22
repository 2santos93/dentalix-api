import 'dotenv/config';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const prisma = new PrismaService();

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
