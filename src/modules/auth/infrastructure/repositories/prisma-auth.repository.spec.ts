import { PrismaAuthRepository } from './prisma-auth.repository';

describe('PrismaAuthRepository — refresh-token denylist', () => {
  it('revokeToken upserts the jti and purges expired entries', async () => {
    const revokedToken = {
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
    };
    const prisma = { revokedToken } as never;
    const repo = new PrismaAuthRepository(prisma);
    const exp = new Date('2030-01-01T00:00:00Z');

    await repo.revokeToken('jti-1', exp);

    expect(revokedToken.upsert).toHaveBeenCalledWith({
      where: { jti: 'jti-1' },
      update: {},
      create: { jti: 'jti-1', expiresAt: exp },
    });
    // Limpieza lazy de expirados en el mismo camino: debe filtrar por fecha,
    // no borrar toda la tabla (deleteMany({}) barrería toda la denylist).
    expect(revokedToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) as Date } },
    });
  });

  it('isTokenRevoked returns true only when a row exists', async () => {
    const revokedToken = {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(({ where }: { where: { jti: string } }) =>
        Promise.resolve(where.jti === 'jti-1' ? { jti: 'jti-1' } : null),
      ),
    };
    const prisma = { revokedToken } as never;
    const repo = new PrismaAuthRepository(prisma);

    expect(await repo.isTokenRevoked('jti-1')).toBe(true);
    expect(await repo.isTokenRevoked('missing')).toBe(false);
    expect(revokedToken.findUnique).toHaveBeenCalledWith({
      where: { jti: 'jti-1' },
      select: { jti: true },
    });
  });
});
