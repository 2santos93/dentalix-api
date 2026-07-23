import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  providers: [TenantContextService, TenantResolverService],
  exports: [TenantContextService, TenantResolverService],
})
export class TenantContextModule {}
