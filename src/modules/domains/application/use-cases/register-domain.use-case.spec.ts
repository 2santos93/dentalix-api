import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { RegisterDomainUseCase } from './register-domain.use-case';
import { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';

function makeRepo(
  overrides: Partial<jest.Mocked<TenantDomainRepository>> = {},
): jest.Mocked<TenantDomainRepository> {
  return {
    create: jest.fn(async ({ host, verifyToken }) => ({
      id: 'd-1',
      host,
      status: 'PENDING',
      verifyToken,
      verifiedAt: null,
      createdAt: new Date(0),
    })),
    listByTenant: jest.fn(),
    findByHostForTenant: jest.fn().mockResolvedValue(null),
    findById: jest.fn(),
    markVerified: jest.fn(),
    ...overrides,
  } as jest.Mocked<TenantDomainRepository>;
}

const config = {
  get: jest.fn().mockReturnValue('dentalix.app,localhost'),
} as unknown as ConfigService;

describe('RegisterDomainUseCase', () => {
  it('normalizes the host, creates a PENDING record, and returns DNS instructions', async () => {
    const repo = makeRepo();
    const uc = new RegisterDomainUseCase(repo, config);
    const result = await uc.execute({ host: '  Citas.MiClinica.com  ' });

    expect(repo.create).toHaveBeenCalledWith({
      host: 'citas.miclinica.com',
      verifyToken: expect.any(String),
    });
    expect(result.domain.status).toBe('PENDING');
    expect(result.dns).toEqual({
      name: '_dentalix-verify.citas.miclinica.com',
      type: 'TXT',
      value: result.domain.verifyToken,
    });
  });

  it('rejects a host that is actually a subdomain of a base domain', async () => {
    const uc = new RegisterDomainUseCase(makeRepo(), config);
    await expect(
      uc.execute({ host: 'acme.dentalix.app' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a host that is a reserved subdomain (parseHost returns null)', async () => {
    const uc = new RegisterDomainUseCase(makeRepo(), config);
    await expect(
      uc.execute({ host: 'www.dentalix.app' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a host already registered for this tenant', async () => {
    const repo = makeRepo({
      findByHostForTenant: jest.fn().mockResolvedValue({
        id: 'd-0',
        host: 'citas.miclinica.com',
        status: 'PENDING',
        verifyToken: 'x',
        verifiedAt: null,
        createdAt: new Date(0),
      }),
    });
    const uc = new RegisterDomainUseCase(repo, config);
    await expect(
      uc.execute({ host: 'citas.miclinica.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a Prisma P2002 unique violation on create (cross-tenant duplicate host) to ConflictException', async () => {
    const repo = makeRepo({
      create: jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'x',
        }),
      ),
    });
    const uc = new RegisterDomainUseCase(repo, config);
    await expect(
      uc.execute({ host: 'citas.miclinica.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
