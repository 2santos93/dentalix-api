import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';
import { parseHost } from '../../../../shared/tenancy/host-parser';

export interface RegisterDomainResult {
  domain: TenantDomainRecord;
  dns: { name: string; type: 'TXT'; value: string };
}

@Injectable()
export class RegisterDomainUseCase {
  private readonly baseDomains: string[];

  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    config: ConfigService,
  ) {
    this.baseDomains = (config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async execute(input: { host: string }): Promise<RegisterDomainResult> {
    const host = input.host.trim().toLowerCase().split(':')[0];
    if (!host || !host.includes('.')) {
      throw new BadRequestException('Invalid domain');
    }
    // A host under a managed base domain is a subdomain, not a custom domain.
    if (parseHost(host, this.baseDomains)?.kind === 'subdomain') {
      throw new BadRequestException(
        'That host is a managed subdomain, not a custom domain',
      );
    }
    if (await this.repo.findByHostForTenant(host)) {
      throw new ConflictException('Domain already registered');
    }
    const verifyToken = `dentalix-verify=${randomBytes(16).toString('hex')}`;
    const domain = await this.repo.create({ host, verifyToken });
    return {
      domain,
      dns: { name: `_dentalix-verify.${host}`, type: 'TXT', value: verifyToken },
    };
  }
}
