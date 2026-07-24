import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantHostMiddleware } from './tenant-host.middleware';

@Global()
@Module({
  providers: [
    TenantContextService,
    TenantResolverService,
    TenantHostMiddleware,
  ],
  exports: [TenantContextService, TenantResolverService, TenantHostMiddleware],
})
export class TenantContextModule {}
