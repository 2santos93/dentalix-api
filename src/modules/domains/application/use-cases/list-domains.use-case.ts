import { Inject, Injectable } from '@nestjs/common';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';

@Injectable()
export class ListDomainsUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
  ) {}

  execute(): Promise<TenantDomainRecord[]> {
    return this.repo.listByTenant();
  }
}
