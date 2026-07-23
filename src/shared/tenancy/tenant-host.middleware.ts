import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantResolverService } from './tenant-resolver.service';
import { selectHost } from './select-host';
import { TenantHostRequest } from './tenant-host-request';

@Injectable()
export class TenantHostMiddleware implements NestMiddleware {
  private readonly isProd: boolean;
  private readonly trustProxy: boolean;

  constructor(
    private readonly resolver: TenantResolverService,
    config: ConfigService,
  ) {
    this.isProd = config.get<string>('NODE_ENV') === 'production';
    this.trustProxy = config.get<string>('TRUST_PROXY') === 'true';
  }

  async use(
    req: TenantHostRequest,
    _res: unknown,
    next: () => void,
  ): Promise<void> {
    const host = selectHost(req.headers, {
      isProd: this.isProd,
      trustProxy: this.trustProxy,
    });
    let tenantId: string | null = null;
    try {
      tenantId = await this.resolver.resolve(host);
    } catch {
      // Resolution is best-effort: a transient DB error must not 500 every
      // route. Degrade to no tenant; downstream enforcement handles it.
      tenantId = null;
    }
    req.tenantHost = { host, tenantId };
    next();
  }
}
