import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  DataConsentRepository,
  RecordConsentsCommand,
} from '../../domain/ports/data-consent-repository.port';
import type { DataConsentRecord } from '../../domain/entities/data-consent.entity';
import { recordConsentsInTx } from '../record-consents-in-tx';

const WITH_REFS = {
  policyVersion: { select: { id: true, version: true } },
  recordedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.DataProcessingConsentInclude;

type Row = Prisma.DataProcessingConsentGetPayload<{
  include: typeof WITH_REFS;
}>;

function mapToEntity(row: Row): DataConsentRecord {
  return {
    id: row.id,
    patientId: row.patientId,
    scope: row.scope,
    granted: row.granted,
    channel: row.channel,
    policyVersion: row.policyVersion,
    legacyPolicyVersion: row.legacyPolicyVersion,
    recordedAt: row.recordedAt,
    recordedBy: row.recordedBy,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}

@Injectable()
export class PrismaDataConsentRepository implements DataConsentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async listForPatient(patientId: string): Promise<DataConsentRecord[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.dataProcessingConsent.findMany({
        where: { patientId },
        orderBy: { recordedAt: 'desc' },
        include: WITH_REFS,
      }),
    );
    return rows.map(mapToEntity);
  }

  async record(command: RecordConsentsCommand): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant((tx) =>
      recordConsentsInTx(tx, { tenantId, ...command }),
    );
  }
}
