import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { TENANT_DOMAIN_REPOSITORY } from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';
import {
  isExpired,
  pendingExpiresAt,
  toDomainRecord,
  verificationRecordName,
} from '../../domain/rules/tenant-domain-rules';
import { parseHost } from '../../../../shared/tenancy/host-parser';
import { DomainClock } from '../domain-clock';

export interface RegisterDomainResult {
  domain: TenantDomainRecord;
  dns: { name: string; type: 'TXT'; value: string };
}

export const DOMAIN_ALREADY_REGISTERED =
  'Ese dominio ya está registrado en tu clínica.';
export const DOMAIN_VERIFIED_ELSEWHERE =
  'Ese dominio ya está verificado por otra cuenta. Si ahora es tuyo, quita su registro TXT de verificación: la re-verificación periódica lo liberará.';

/**
 * Alta de un dominio personalizado en PENDING (SEC-009). Registrarlo no
 * reserva nada: el host solo es único entre los VERIFIED, así que otra clínica
 * puede tenerlo también en PENDING y lo gana la primera que verifica el TXT.
 * Un PENDING caduca a las 72 h (EXPIRED): el de la propia clínica se
 * sustituye al volver a registrarlo.
 */
@Injectable()
export class RegisterDomainUseCase {
  private readonly baseDomains: string[];

  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    config: ConfigService,
    private readonly clock: DomainClock,
  ) {
    this.baseDomains = (
      config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost'
    )
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async execute(input: { host: string }): Promise<RegisterDomainResult> {
    const host = input.host.trim().toLowerCase().split(':')[0];
    if (!host || !host.includes('.')) {
      throw new BadRequestException('Dominio no válido.');
    }
    // Only a valid custom domain may be registered here. Anything else
    // (a managed subdomain, a reserved subdomain, a multi-label host under a
    // base domain, or the apex base domain itself) resolves via other means
    // and would create a dead TenantDomain row that can never verify.
    if (parseHost(host, this.baseDomains)?.kind !== 'custom') {
      throw new BadRequestException(
        'Ese dominio no se puede registrar como dominio personalizado.',
      );
    }
    const now = this.clock.now();
    const existing = await this.repo.findByHostForTenant(host);
    if (existing && !isExpired(existing, now)) {
      throw new ConflictException(DOMAIN_ALREADY_REGISTERED);
    }
    if (await this.repo.isVerifiedByAnotherTenant(host)) {
      throw new ConflictException(DOMAIN_VERIFIED_ELSEWHERE);
    }
    const verifyToken = `dentalix-verify=${randomBytes(16).toString('hex')}`;
    try {
      // Su propio PENDING caducado no le bloquea: se retira y se da de alta
      // uno nuevo (token y plazo nuevos), en una sola transacción.
      const row = await this.repo.create({
        host,
        verifyToken,
        expiresAt: pendingExpiresAt(now),
        replacing: existing ? { id: existing.id, deletedAt: now } : undefined,
      });
      return {
        domain: toDomainRecord(row, now),
        dns: {
          name: verificationRecordName(host),
          type: 'TXT',
          value: verifyToken,
        },
      };
    } catch (error) {
      // tenant_domains_tenant_host_key: dos altas del mismo host a la vez en
      // esta clínica. Un 409, no un 500.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(DOMAIN_ALREADY_REGISTERED);
      }
      throw error;
    }
  }
}
