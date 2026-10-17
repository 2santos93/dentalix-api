import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  PublicWebProtocol,
  parseBaseDomains,
  platformLinkHost,
  resolvePublicWebProtocol,
  tenantLinkHost,
} from './public-link';

/**
 * `<protocolo>://<host de plataforma de la clínica>` para los enlaces con un
 * token de la cuenta global (SEC-033, ver `tenantLinkHost`). Solo lee
 * `tenants.subdomain` (tabla global, sin RLS) cuando la petición NO llegó por
 * un host de plataforma (dominio personalizado) o no hay petición (trabajos
 * en segundo plano, DX-026).
 */
@Injectable()
export class TenantLinkBaseService {
  private readonly baseDomains: string[];
  private readonly protocol: PublicWebProtocol;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.baseDomains = parseBaseDomains(
      config.get<string>('TENANT_BASE_DOMAINS'),
    );
    this.protocol = resolvePublicWebProtocol((key) => config.get<string>(key));
  }

  async forTenant(
    tenantId: string,
    requestHost?: string,
  ): Promise<string | null> {
    let host = platformLinkHost(requestHost, this.baseDomains);
    if (!host) {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: tenantId, deletedAt: null },
        select: { subdomain: true },
      });
      host = tenantLinkHost(requestHost, tenant?.subdomain, this.baseDomains);
    }
    return host ? `${this.protocol}://${host}` : null;
  }
}
