import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import {
  DNS_RESOLVER,
  DnsLookupError,
} from '../../domain/ports/dns-resolver.port';
import type { DnsResolver } from '../../domain/ports/dns-resolver.port';
import type { TenantDomainState } from '../../domain/entities/tenant-domain.entity';
import {
  domainState,
  hasVerificationToken,
  isExpired,
  verificationRecordName,
} from '../../domain/rules/tenant-domain-rules';
import { DomainClock } from '../domain-clock';

export const DOMAIN_NOT_FOUND = 'Dominio no encontrado.';
export const DOMAIN_EXPIRED =
  'Este dominio caducó sin verificarse (72 h) o lo verificó otra cuenta. Elimínalo y regístralo de nuevo.';
export const DOMAIN_TAKEN = 'Otra cuenta ya verificó ese dominio.';

/**
 * Comprueba el TXT de un dominio PENDING (sin caducar) o DISABLED de la
 * clínica. Si está, pasa a VERIFIED y empieza a enrutar; los PENDING de otras
 * clínicas con el mismo host quedan invalidados (SEC-009). Sin TXT, o si el
 * DNS no responde, sigue como estaba.
 */
@Injectable()
export class VerifyDomainUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    private readonly clock: DomainClock,
  ) {}

  async execute(input: { id: string }): Promise<{ status: TenantDomainState }> {
    const domain = await this.repo.findById(input.id);
    if (!domain) throw new NotFoundException(DOMAIN_NOT_FOUND);
    if (domain.status === 'VERIFIED') return { status: 'VERIFIED' };
    const now = this.clock.now();
    if (isExpired(domain, now)) throw new GoneException(DOMAIN_EXPIRED);

    let records: string[];
    try {
      records = await this.dns.resolveTxt(verificationRecordName(domain.host));
    } catch (error) {
      if (error instanceof DnsLookupError) {
        return { status: domainState(domain, now) };
      }
      throw error;
    }
    if (!hasVerificationToken(records, domain.verifyToken)) {
      return { status: domainState(domain, now) };
    }

    const result = await this.repo.markVerified(domain.id, now);
    if (result === 'verified') return { status: 'VERIFIED' };
    if (result === 'taken') throw new ConflictException(DOMAIN_TAKEN);
    // Cambió entre la lectura y la escritura: se informa del estado actual.
    const current = await this.repo.findById(domain.id);
    if (!current) throw new NotFoundException(DOMAIN_NOT_FOUND);
    if (isExpired(current, now)) throw new GoneException(DOMAIN_EXPIRED);
    return { status: domainState(current, now) };
  }
}
