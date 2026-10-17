import { Inject, Injectable } from '@nestjs/common';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';
import { toDomainRecord } from '../../domain/rules/tenant-domain-rules';
import { DomainClock } from '../domain-clock';

@Injectable()
export class ListDomainsUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    private readonly clock: DomainClock,
  ) {}

  async execute(): Promise<TenantDomainRecord[]> {
    const now = this.clock.now();
    const rows = await this.repo.listByTenant();
    return rows.map((row) => toDomainRecord(row, now));
  }
}
