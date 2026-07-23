import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DomainsController } from './presentation/domains.controller';
import { RegisterDomainUseCase } from './application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from './application/use-cases/list-domains.use-case';
import { VerifyDomainUseCase } from './application/use-cases/verify-domain.use-case';
import { TENANT_DOMAIN_REPOSITORY } from './domain/ports/tenant-domain-repository.port';
import { DNS_RESOLVER } from './domain/ports/dns-resolver.port';
import { PrismaTenantDomainRepository } from './infrastructure/repositories/prisma-tenant-domain.repository';
import { NodeDnsResolver } from './infrastructure/dns/node-dns-resolver';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  imports: [JwtModule.register({})],
  controllers: [DomainsController],
  providers: [
    RegisterDomainUseCase,
    ListDomainsUseCase,
    VerifyDomainUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: TENANT_DOMAIN_REPOSITORY, useClass: PrismaTenantDomainRepository },
    { provide: DNS_RESOLVER, useClass: NodeDnsResolver },
  ],
})
export class DomainsModule {}
