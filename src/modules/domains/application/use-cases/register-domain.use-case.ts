import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
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
    this.baseDomains = (
      config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost'
    )
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async execute(input: { host: string }): Promise<RegisterDomainResult> {
    const host = input.host.trim().toLowerCase().split(':')[0];
    if (!host || !host.includes('.')) {
      throw new BadRequestException('Invalid domain');
    }
    // Only a valid custom domain may be registered here. Anything else
    // (a managed subdomain, a reserved subdomain, a multi-label host under a
    // base domain, or the apex base domain itself) resolves via other means
    // and would create a dead TenantDomain row that can never verify.
    if (parseHost(host, this.baseDomains)?.kind !== 'custom') {
      throw new BadRequestException(
        'That host cannot be registered as a custom domain',
      );
    }
    if (await this.repo.findByHostForTenant(host)) {
      throw new ConflictException('Domain already registered');
    }
    const verifyToken = `dentalix-verify=${randomBytes(16).toString('hex')}`;
    try {
      const domain = await this.repo.create({ host, verifyToken });
      return {
        domain,
        dns: {
          name: `_dentalix-verify.${host}`,
          type: 'TXT',
          value: verifyToken,
        },
      };
    } catch (error) {
      // TenantDomain.host is globally unique, but findByHostForTenant above
      // only checks the current tenant. Map a cross-tenant duplicate host
      // (and any check-then-create race) to the same 409 instead of letting
      // the Prisma unique violation bubble up as an unhandled 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Domain already registered');
      }
      throw error;
    }
  }
}
