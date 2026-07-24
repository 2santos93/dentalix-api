import { ConfigService } from '@nestjs/config';
import { TenantResolverService } from './tenant-resolver.service';

function makeService(prisma: {
  tenant: { findFirst: jest.Mock };
  tenantDomain: { findFirst: jest.Mock };
}) {
  const config = {
    get: jest.fn().mockReturnValue('dentalix.app,localhost'),
  } as unknown as ConfigService;
  return new TenantResolverService(prisma as never, config);
}

describe('TenantResolverService', () => {
  it('resolves a subdomain to its tenant id', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue({ id: 't-1' }) },
      tenantDomain: { findFirst: jest.fn() },
    };
    const svc = makeService(prisma);
    await expect(svc.resolve('acme.dentalix.app')).resolves.toBe('t-1');
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { subdomain: 'acme', deletedAt: null },
      select: { id: true },
    });
  });

  it('returns null for an unknown subdomain', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue(null) },
      tenantDomain: { findFirst: jest.fn() },
    };
    await expect(
      makeService(prisma).resolve('nope.localhost'),
    ).resolves.toBeNull();
  });

  it('resolves a verified custom domain to its tenant id', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: {
        findFirst: jest.fn().mockResolvedValue({ tenantId: 't-2' }),
      },
    };
    const svc = makeService(prisma);
    await expect(svc.resolve('citas.miclinica.com')).resolves.toBe('t-2');
    expect(prisma.tenantDomain.findFirst).toHaveBeenCalledWith({
      where: {
        host: 'citas.miclinica.com',
        status: 'VERIFIED',
        deletedAt: null,
      },
      select: { tenantId: true },
    });
  });

  it('returns null for a pending (unverified) custom domain', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).resolve('citas.miclinica.com'),
    ).resolves.toBeNull();
  });

  it('returns null for an unparseable host', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: { findFirst: jest.fn() },
    };
    await expect(makeService(prisma).resolve(undefined)).resolves.toBeNull();
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});
