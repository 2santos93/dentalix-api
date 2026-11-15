import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { DomainClock } from '../domain-clock';
import { DOMAIN_NOT_FOUND } from './verify-domain.use-case';
import { VerifiedDomainOrigins } from '../../../../shared/security/verified-domain-origins';

/**
 * Elimina (soft delete) un dominio de la clínica, en cualquier estado
 * (SEC-009). Deja de enrutar al momento y libera el host. Uno de otra
 * clínica (o inexistente) es 404.
 */
@Injectable()
export class DeleteDomainUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    private readonly clock: DomainClock,
    private readonly origins: VerifiedDomainOrigins,
  ) {}

  async execute(input: { id: string }): Promise<void> {
    const deleted = await this.repo.softDelete(input.id, this.clock.now());
    if (!deleted) throw new NotFoundException(DOMAIN_NOT_FOUND);
    // SEC-021: deja de valer como origen al momento en este proceso. El
    // borrado no devuelve el host: se vacía la caché (barata de rehacer).
    this.origins.invalidate();
  }
}
