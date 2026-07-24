import { NotFoundException } from '@nestjs/common';
import { GetTenantBrandingUseCase } from './get-tenant-branding.use-case';
import { TenantBranding } from '../../domain/entities/tenant-branding.entity';
import { TenantBrandingRepository } from '../../domain/ports/tenant-branding-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

function stubTenantContext(tenantId: string | undefined): TenantContextService {
  return { getTenantId: () => tenantId } as unknown as TenantContextService;
}

describe('GetTenantBrandingUseCase', () => {
  it('returns the mapped branding when the context tenant exists', async () => {
    const branding: TenantBranding = {
      name: 'Sonrisa',
      primaryColor: '#123456',
      logoUrl: 'https://cdn.example.com/logo.png',
    };
    const repo: TenantBrandingRepository = {
      findById: (tenantId: string) => {
        expect(tenantId).toBe('t-1');
        return Promise.resolve(branding);
      },
    };
    const uc = new GetTenantBrandingUseCase(stubTenantContext('t-1'), repo);

    const result = await uc.execute();

    expect(result).toBe(branding);
  });

  it('throws NotFoundException when no tenant is in context (no/unknown host)', async () => {
    const repo: TenantBrandingRepository = {
      findById: () => Promise.reject(new Error('must not be called')),
    };
    const uc = new GetTenantBrandingUseCase(stubTenantContext(undefined), repo);

    await expect(uc.execute()).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the repository finds no such tenant', async () => {
    const repo: TenantBrandingRepository = {
      findById: () => Promise.resolve(null),
    };
    const uc = new GetTenantBrandingUseCase(stubTenantContext('t-ghost'), repo);

    await expect(uc.execute()).rejects.toThrow(NotFoundException);
  });
});
