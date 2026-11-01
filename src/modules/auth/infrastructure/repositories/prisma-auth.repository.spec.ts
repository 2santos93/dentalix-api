import { Prisma } from '@prisma/client';
import { PLATFORM_DEFAULT_MAJORITY_AGE } from '../../../patients/domain/responsible-parties/majority-age';
import { PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS } from '../../../prescriptions/domain/prescription-settings';
import { PrismaAuthRepository } from './prisma-auth.repository';

describe('PrismaAuthRepository — refresh-token denylist', () => {
  it('revokeToken upserts the jti and does NOT purge on the request path (DX-085: scheduled job)', async () => {
    const revokedToken = {
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
    };
    const prisma = { revokedToken } as never;
    const repo = new PrismaAuthRepository(prisma, { platformMinYears: 15 });
    const exp = new Date('2030-01-01T00:00:00Z');

    await repo.revokeToken('jti-1', exp);

    expect(revokedToken.upsert).toHaveBeenCalledWith({
      where: { jti: 'jti-1' },
      update: {},
      create: { jti: 'jti-1', expiresAt: exp },
    });
    // DX-085: la purga de vencidos es una tarea programada
    // (auth.purge-expired-tokens), no una escritura más en cada logout.
    expect(revokedToken.deleteMany).not.toHaveBeenCalled();
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
    const repo = new PrismaAuthRepository(prisma, { platformMinYears: 15 });
    const exp = new Date('2030-01-01T00:00:00Z');

    // INSERT (no upsert): la PK de `jti` es la que serializa dos refresh
    // concurrentes con el mismo token — solo uno gana.
    expect(await repo.consumeRefreshToken('jti-1', exp)).toBe(true);
    expect(await repo.consumeRefreshToken('jti-1', exp)).toBe(false);
    expect(revokedToken.create).toHaveBeenCalledWith({
      data: { jti: 'jti-1', expiresAt: exp },
    });
    expect(revokedToken.deleteMany).not.toHaveBeenCalled();
  });

  it('consumeRefreshToken rethrows errors that are not a duplicate jti', async () => {
    const boom = new Error('connection lost');
    const revokedToken = {
      create: jest.fn().mockRejectedValue(boom),
      deleteMany: jest.fn(),
    };
    const repo = new PrismaAuthRepository({ revokedToken } as never, {
      platformMinYears: 15,
    });

    await expect(
      repo.consumeRefreshToken('jti-1', new Date('2030-01-01T00:00:00Z')),
    ).rejects.toBe(boom);
  });
});

describe('PrismaAuthRepository — createClinicWithOwner', () => {
  it('writes the platform clinic settings explicitly, not by the DB defaults (DX-328, DX-324)', async () => {
    // Se corta tras crear la clínica: aquí solo importa qué datos recibe
    // `tenant.create`, que la BD no distingue de sus defaults.
    const stop = new Error('stop after tenant.create');
    const tx = {
      tenant: { create: jest.fn().mockResolvedValue({ id: 't-1' }) },
      user: { create: jest.fn().mockRejectedValue(stop) },
    };
    const prisma = {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const repo = new PrismaAuthRepository(prisma as never, {
      platformMinYears: 20,
    });

    await expect(
      repo.createClinicWithOwner({
        clinicName: 'Clínica',
        subdomain: 'clinica',
        email: 'owner@clinica.test',
        passwordHash: 'hash',
        fullName: 'Owner',
        emailVerifiedAt: new Date('2030-01-01T00:00:00Z'),
        location: {
          country: 'JP',
          currency: 'JPY',
          timeZone: 'Asia/Tokyo',
          locale: 'ja-JP',
          hourCycle: 'h23',
        },
        request: null,
      }),
    ).rejects.toBe(stop);

    expect(tx.tenant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        majorityAge: PLATFORM_DEFAULT_MAJORITY_AGE,
        clinicalRecordRetentionYears: 20,
        prescriptionPrintQuantityInWords:
          PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.printQuantityInWords,
        prescriptionRequireClinicalRecordNumber:
          PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.requireClinicalRecordNumber,
        prescriptionValidityDays:
          PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS.validityDays,
      }) as unknown,
      select: { id: true },
    });
  });
});
