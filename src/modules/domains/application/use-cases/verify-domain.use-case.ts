import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { DNS_RESOLVER } from '../../domain/ports/dns-resolver.port';
import type { DnsResolver } from '../../domain/ports/dns-resolver.port';

@Injectable()
export class VerifyDomainUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {}

  async execute(input: { id: string }): Promise<{ status: 'PENDING' | 'VERIFIED' }> {
    const domain = await this.repo.findById(input.id);
    if (!domain) throw new NotFoundException('Domain not found');
    if (domain.status === 'VERIFIED') return { status: 'VERIFIED' };

    const records = await this.dns.resolveTxt(`_dentalix-verify.${domain.host}`);
    if (records.some((r) => r.includes(domain.verifyToken))) {
      await this.repo.markVerified(domain.id);
      return { status: 'VERIFIED' };
    }
    return { status: 'PENDING' };
  }
}
