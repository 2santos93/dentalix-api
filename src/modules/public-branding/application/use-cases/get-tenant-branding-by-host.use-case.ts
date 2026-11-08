import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TenantResolverService } from '../../../../shared/tenancy/tenant-resolver.service';
import { TenantBranding } from '../../domain/entities/tenant-branding.entity';
import { TENANT_BRANDING_REPOSITORY } from '../../domain/ports/tenant-branding-repository.port';
import type { TenantBrandingRepository } from '../../domain/ports/tenant-branding-repository.port';
import { normalizeBrandingHost } from '../branding-host';

/**
 * DX-517-ter: la marca PÚBLICA de la clínica de un host que llega como dato
 * (`?host=`), para que el servidor web la pinte en el primer HTML.
 *
 * - El host es un PARÁMETRO: no se leen cabeceras, `req.tenantHost` ni el
 *   contexto de clínica (`TenantContextService`), así que no cambia en nada
 *   en qué cabeceras confía la API. Tampoco fija contexto, sesión ni cookies.
 * - Mismo resolutor que el middleware (`TenantResolverService`): solo
 *   subdominios de `TENANT_BASE_DOMAINS` y dominios propios VERIFIED vivos de
 *   clínicas vivas; sin copia de sus reglas.
 * - Un host inválido da el MISMO 404 que uno desconocido (sin oráculo) y no
 *   llega a la BD.
 * - Un fallo de la BD NO se convierte en 404: sale como 5xx y la web lo trata
 *   como «desconocida» (lo vuelve a intentar el navegador), no como «ninguna».
 */
@Injectable()
export class GetTenantBrandingByHostUseCase {
  constructor(
    private readonly resolver: TenantResolverService,
    @Inject(TENANT_BRANDING_REPOSITORY)
    private readonly repo: TenantBrandingRepository,
  ) {}

  async execute(rawHost: unknown): Promise<TenantBranding> {
    const host = normalizeBrandingHost(rawHost);
    if (!host) throw new NotFoundException('Tenant not found');

    const tenantId = await this.resolver.resolve(host);
    if (!tenantId) throw new NotFoundException('Tenant not found');

    const branding = await this.repo.findById(tenantId);
    if (!branding) throw new NotFoundException('Tenant not found');

    return branding;
  }
}
