import { NotFoundException } from '@nestjs/common';
import { VerifyDomainUseCase } from './verify-domain.use-case';
import { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { DnsResolver } from '../../domain/ports/dns-resolver.port';

const pending = {
  id: 'd-1',
  host: 'citas.miclinica.com',
  status: 'PENDING' as const,
  verifyToken: 'dentalix-verify=abc123',
  verifiedAt: null,
  createdAt: new Date(0),
};

function makeRepo(
  overrides: Partial<jest.Mocked<TenantDomainRepository>> = {},
): jest.Mocked<TenantDomainRepository> {
  return {
    create: jest.fn(),
    listByTenant: jest.fn(),
    findByHostForTenant: jest.fn(),
    findById: jest.fn().mockResolvedValue(pending),
    markVerified: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('VerifyDomainUseCase', () => {
  it('marks the domain VERIFIED when a matching TXT record exists', async () => {
    const repo = makeRepo();
    const dns: jest.Mocked<DnsResolver> = {
      resolveTxt: jest
        .fn()
        .mockResolvedValue(['unrelated', 'dentalix-verify=abc123']),
    };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.resolveTxt).toHaveBeenCalledWith(
      '_dentalix-verify.citas.miclinica.com',
    );
    expect(repo.markVerified).toHaveBeenCalledWith('d-1');
  });

  it('stays PENDING when no TXT record matches', async () => {
    const repo = makeRepo();
    const dns: jest.Mocked<DnsResolver> = {
      resolveTxt: jest.fn().mockResolvedValue(['something-else']),
    };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'PENDING',
    });
    expect(repo.markVerified).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-verified domain', async () => {
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue({ ...pending, status: 'VERIFIED' }),
    });
    const dns: jest.Mocked<DnsResolver> = { resolveTxt: jest.fn() };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown/other-tenant domain', async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
    const dns: jest.Mocked<DnsResolver> = { resolveTxt: jest.fn() };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
