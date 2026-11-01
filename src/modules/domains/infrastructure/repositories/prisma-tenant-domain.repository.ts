import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  MarkVerifiedResult,
  RecordCheckResult,
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import type { TenantDomainRow } from '../../domain/entities/tenant-domain.entity';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { domainRegisteredAuditEvent } from '../../domain/domain-audit';

const SELECT = {
  id: true,
  host: true,
  status: true,
  verifyToken: true,
  verifiedAt: true,
  expiresAt: true,
  lastCheckedAt: true,
  failedChecks: true,
  disabledAt: true,
  createdAt: true,
} as const;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaTenantDomainRepository implements TenantDomainRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // tenant_domains has NO RLS (it is queried before a tenant is known, for
  // routing). Every management query MUST be scoped by the context tenant.
  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  create(
    input: {
      host: string;
      verifyToken: string;
      expiresAt: Date;
      replacing?: { id: string; deletedAt: Date };
    },
    audit: AuditRequestContext,
  ): Promise<TenantDomainRow> {
    const tenantId = this.tenantId();
    const { replacing } = input;
    // Con el tenant fijado (audit_events tiene RLS forzada): el evento va en
    // la misma transacción que el alta (DX-360).
    return this.prisma.runWithTenant(tenantId, async (tx) => {
      if (replacing) {
        await tx.tenantDomain.updateMany({
          where: { id: replacing.id, tenantId, deletedAt: null },
          data: { deletedAt: replacing.deletedAt },
        });
      }
      const row = await tx.tenantDomain.create({
        data: {
          tenantId,
          host: input.host,
          verifyToken: input.verifyToken,
          expiresAt: input.expiresAt,
        },
        select: SELECT,
      });
      await writeAuditEvent(
        tx,
        domainRegisteredAuditEvent(audit, row, replacing?.id ?? null),
      );
      return row;
    });
  }

  listByTenant(): Promise<TenantDomainRow[]> {
    return this.prisma.tenantDomain.findMany({
      where: { tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  findByHostForTenant(host: string): Promise<TenantDomainRow | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { tenantId: this.tenantId(), host, deletedAt: null },
      select: SELECT,
    });
  }

  findById(id: string): Promise<TenantDomainRow | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
    });
  }

  async isVerifiedByAnotherTenant(host: string): Promise<boolean> {
    // Índice tenant_domains_verified_host_key (mismo predicado).
    const other = await this.prisma.tenantDomain.findFirst({
      where: {
        host,
        status: 'VERIFIED',
        deletedAt: null,
        tenantId: { not: this.tenantId() },
      },
      select: { id: true },
    });
    return other !== null;
  }

  async markVerified(id: string, now: Date): Promise<MarkVerifiedResult> {
    const tenantId = this.tenantId();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const domain = await tx.tenantDomain.findFirst({
          where: { id, tenantId, deletedAt: null },
          select: { host: true },
        });
        if (!domain) return 'unavailable';
        // Las filas vivas de este host, de TODAS las clínicas, bloqueadas en
        // orden fijo: dos verificaciones del mismo host a la vez se ponen en
        // fila. Sin esto, cada una retiene su fila, espera a la otra en el
        // índice único de VERIFIED y la otra la espera al invalidar su
        // PENDING: interbloqueo (40P01) en vez de un ganador y un 'taken'.
        await tx.$queryRaw`
          SELECT "id" FROM "tenant_domains"
           WHERE "host" = ${domain.host} AND "deletedAt" IS NULL
           ORDER BY "id"
           FOR UPDATE`;
        // Con la condición en el WHERE: un PENDING que caducó (o que otra
        // clínica invalidó) entre la lectura del DNS y aquí no se verifica.
        const updated = await tx.tenantDomain.updateMany({
          where: {
            id,
            tenantId,
            deletedAt: null,
            OR: [
              { status: 'DISABLED' },
              { status: 'PENDING', expiresAt: { gt: now } },
            ],
          },
          data: {
            status: 'VERIFIED',
            verifiedAt: now,
            expiresAt: null,
            lastCheckedAt: now,
            failedChecks: 0,
            disabledAt: null,
          },
        });
        if (updated.count === 0) {
          // Si otra clínica lo acaba de verificar (y con ello invalidó este
          // PENDING), se dice así: 'taken', no un genérico 'unavailable'.
          const winner = await tx.tenantDomain.findFirst({
            where: {
              host: domain.host,
              status: 'VERIFIED',
              deletedAt: null,
              tenantId: { not: tenantId },
            },
            select: { id: true },
          });
          return winner ? 'taken' : 'unavailable';
        }
        // El PENDING de las demás clínicas queda invalidado (caducado ya): lo
        // verán EXPIRED en su lista. Escritura entre clínicas a propósito,
        // acotada al host que esta clínica acaba de demostrar que controla.
        await tx.tenantDomain.updateMany({
          where: {
            host: domain.host,
            tenantId: { not: tenantId },
            status: 'PENDING',
            deletedAt: null,
            expiresAt: { gt: now },
          },
          data: { expiresAt: now },
        });
        return 'verified';
      });
    } catch (error) {
      // tenant_domains_verified_host_key: otra clínica lo verificó antes (o
      // a la vez y confirmó primero).
      if (isUniqueViolation(error)) return 'taken';
      throw error;
    }
  }

  async softDelete(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.tenantDomain.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      data: { deletedAt: now },
    });
    return count > 0;
  }

  findForRecheck(id: string, round: Date): Promise<TenantDomainRow | null> {
    return this.prisma.tenantDomain.findFirst({
      where: {
        id,
        tenantId: this.tenantId(),
        status: 'VERIFIED',
        deletedAt: null,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: round } }],
      },
      select: SELECT,
    });
  }

  async recordCheck(input: {
    id: string;
    round: Date;
    expectedFailedChecks: number;
    failedChecks: number;
    disable: boolean;
  }): Promise<RecordCheckResult | null> {
    // Concurrencia optimista: solo si nada cambió desde la lectura (otra
    // entrega del mismo trabajo, el ADMIN que lo borra o lo re-verifica).
    const { count } = await this.prisma.tenantDomain.updateMany({
      where: {
        id: input.id,
        tenantId: this.tenantId(),
        status: 'VERIFIED',
        deletedAt: null,
        failedChecks: input.expectedFailedChecks,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: input.round } }],
      },
      data: {
        lastCheckedAt: input.round,
        failedChecks: input.failedChecks,
        ...(input.disable
          ? { status: 'DISABLED' as const, disabledAt: input.round }
          : {}),
      },
    });
    if (count === 0) return null;
    return {
      status: input.disable ? 'DISABLED' : 'VERIFIED',
      failedChecks: input.failedChecks,
    };
  }
}
