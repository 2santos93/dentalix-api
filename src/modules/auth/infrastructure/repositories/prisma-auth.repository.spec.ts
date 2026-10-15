import { Prisma } from '@prisma/client';
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

  it('consumeRefreshToken inserts the jti once and reports a reuse as false', async () => {
    const revokedToken = {
      create: jest
        .fn()
        .mockResolvedValueOnce({ jti: 'jti-1' })
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const prisma = { revokedToken } as never;
    const repo = new PrismaAuthRepository(prisma);
    const exp = new Date('2030-01-01T00:00:00Z');

    // INSERT (no upsert): la PK de `jti` es la que serializa dos refresh
    // concurrentes con el mismo token — solo uno gana.
    expect(await repo.consumeRefreshToken('jti-1', exp)).toBe(true);
    expect(await repo.consumeRefreshToken('jti-1', exp)).toBe(false);
    expect(revokedToken.create).toHaveBeenCalledWith({
      data: { jti: 'jti-1', expiresAt: exp },
    });
  });

  it('consumeRefreshToken rethrows errors that are not a duplicate jti', async () => {
    const boom = new Error('connection lost');
    const revokedToken = {
      create: jest.fn().mockRejectedValue(boom),
      deleteMany: jest.fn(),
    };
    const repo = new PrismaAuthRepository({ revokedToken } as never);

    await expect(
      repo.consumeRefreshToken('jti-1', new Date('2030-01-01T00:00:00Z')),
    ).rejects.toBe(boom);
  });
});
