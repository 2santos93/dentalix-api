import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PrivacyPolicyRepository,
  PublishPolicyInput,
} from '../../domain/ports/privacy-policy-repository.port';
import type { PrivacyPolicyVersion } from '../../domain/entities/privacy-policy.entity';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import { privacyPolicyPublishedAuditEvent } from '../../domain/privacy-policy-audit';

const WITH_PUBLISHER = {
  publishedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.PrivacyPolicyVersionInclude;

type Row = Prisma.PrivacyPolicyVersionGetPayload<{
  include: typeof WITH_PUBLISHER;
}>;

function mapToEntity(row: Row): PrivacyPolicyVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    policyText: row.policyText,
    generalText: row.generalText,
    sensitiveHealthText: row.sensitiveHealthText,
    marketingText: row.marketingText,
    contentHash: row.contentHash,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  };
}

@Injectable()
export class PrismaPrivacyPolicyRepository implements PrivacyPolicyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Mismo criterio que PrismaPatientRepository: el tenant del INSERT sale del contexto. */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async list(): Promise<PrivacyPolicyVersion[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.privacyPolicyVersion.findMany({
        // Tenant explícito además de la RLS (defensa en profundidad).
        where: { tenantId },
        orderBy: { version: 'desc' },
        include: WITH_PUBLISHER,
      }),
    );
    return rows.map(mapToEntity);
  }

  async publish(
    input: PublishPolicyInput,
    audit: AuditRequestContext,
  ): Promise<PrivacyPolicyVersion> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant(async (tx) => {
      // Dos publicaciones a la vez calculan el mismo número: el UNIQUE
      // (tenantId, version) rechaza la segunda (409 vía PrismaExceptionFilter).
      const latest = await tx.privacyPolicyVersion.findFirst({
        where: { tenantId },
        orderBy: { version: 'desc' },
        select: {
          version: true,
          contentHash: true,
          policyText: true,
          generalText: true,
          sensitiveHealthText: true,
          marketingText: true,
        },
      });
      const created = await tx.privacyPolicyVersion.create({
        data: {
          tenantId,
          version: (latest?.version ?? 0) + 1,
          policyText: input.policyText,
          generalText: input.generalText,
          sensitiveHealthText: input.sensitiveHealthText,
          marketingText: input.marketingText,
          contentHash: input.contentHash,
          publishedById: input.publishedById,
        },
        include: WITH_PUBLISHER,
      });
      await writeAuditEvent(
        tx,
        privacyPolicyPublishedAuditEvent(audit, created.id, latest, created),
      );
      return created;
    });
    return mapToEntity(row);
  }
}
