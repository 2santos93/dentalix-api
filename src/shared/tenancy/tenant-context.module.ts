import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantHostMiddleware } from './tenant-host.middleware';
import { TenantLinkBaseService } from './tenant-link-base.service';

@Global()
@Module({
  providers: [
    TenantContextService,
    TenantResolverService,
    TenantHostMiddleware,
    TenantLinkBaseService,
  ],
  exports: [
    TenantContextService,
    TenantResolverService,
    TenantHostMiddleware,
    TenantLinkBaseService,
  ],
})
export class TenantContextModule {}
