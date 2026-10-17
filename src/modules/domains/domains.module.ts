import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JobsModule } from '../jobs/jobs.module';
import { DomainsController } from './presentation/domains.controller';
import { RegisterDomainUseCase } from './application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from './application/use-cases/list-domains.use-case';
import { VerifyDomainUseCase } from './application/use-cases/verify-domain.use-case';
import { DeleteDomainUseCase } from './application/use-cases/delete-domain.use-case';
import { DomainClock } from './application/domain-clock';
import {
  DomainRecheckSweep,
  RecheckDomain,
} from './application/domain-recheck';
import { DomainsJobs } from './application/domains-jobs';
import { TENANT_DOMAIN_REPOSITORY } from './domain/ports/tenant-domain-repository.port';
import { DOMAIN_RECHECK_SOURCE } from './domain/ports/domain-recheck-source.port';
import { DNS_RESOLVER } from './domain/ports/dns-resolver.port';
import { PrismaTenantDomainRepository } from './infrastructure/repositories/prisma-tenant-domain.repository';
import { PrismaDomainRecheckSource } from './infrastructure/repositories/prisma-domain-recheck-source';
import { NodeDnsResolver } from './infrastructure/dns/node-dns-resolver';
import {
  DOMAINS_CONFIG,
  loadDomainsConfig,
  type DomainsConfig,
} from './infrastructure/domains-config';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

/**
 * Dominios personalizados (blanqueo de marca). SEC-009: el host solo es único
 * entre los VERIFIED, los PENDING caducan a las 72 h, el ADMIN puede
 * eliminarlos y una tarea programada (cola de DX-085) re-verifica cada hora
 * los VERIFIED y desactiva los que pierden su TXT.
 */
@Module({
  imports: [JwtModule.register({}), JobsModule],
  controllers: [DomainsController],
  providers: [
    RegisterDomainUseCase,
    ListDomainsUseCase,
    VerifyDomainUseCase,
    DeleteDomainUseCase,
    DomainClock,
    DomainRecheckSweep,
    RecheckDomain,
    DomainsJobs,
    TokenService,
    TenantContextInterceptor,
    {
      provide: TENANT_DOMAIN_REPOSITORY,
      useClass: PrismaTenantDomainRepository,
    },
    { provide: DOMAIN_RECHECK_SOURCE, useClass: PrismaDomainRecheckSource },
    { provide: DNS_RESOLVER, useClass: NodeDnsResolver },
    {
      provide: DOMAINS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DomainsConfig =>
        loadDomainsConfig((key) => config.get<string>(key)),
    },
  ],
})
export class DomainsModule {}
