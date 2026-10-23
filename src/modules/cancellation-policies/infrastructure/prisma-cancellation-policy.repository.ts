import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type {
  CancellationPolicyInput,
  CancellationPolicyVersion,
} from '../domain/cancellation-policy';
import type { CancellationPolicyRepository } from '../domain/ports/cancellation-policy-repository.port';

const VERSION_SELECT = {
  id: true,
  locationId: true,
  version: true,
  noticeHours: true,
  suggestedFee: true,
  currency: true,
  patientText: true,
  receptionCanCharge: true,
  createdAt: true,
  createdById: true,
  createdBy: { select: { fullName: true } },
} as const satisfies Prisma.CancellationPolicyVersionSelect;

type SelectedVersion = Prisma.CancellationPolicyVersionGetPayload<{
  select: typeof VERSION_SELECT;
}>;

function toVersion(row: SelectedVersion): CancellationPolicyVersion {
  return {
    id: row.id,
    locationId: row.locationId,
    version: row.version,
    noticeHours: row.noticeHours,
    suggestedFee:
      row.suggestedFee === null ? null : row.suggestedFee.toNumber(),
    currency: row.currency,
    patientText: row.patientText,
    receptionCanCharge: row.receptionCanCharge,
    createdAt: row.createdAt,
    createdById: row.createdById,
    createdByName: row.createdBy.fullName,
  };
}

@Injectable()
export class PrismaCancellationPolicyRepository implements CancellationPolicyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Mismo motivo que en el resto: un INSERT necesita el tenantId explícito. */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  listVersions(
    locationId: string,
  ): Promise<CancellationPolicyVersion[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const location = await tx.location.findFirst({
        where: { id: locationId, deletedAt: null },
        select: { id: true },
      });
      if (!location) return null;
      const rows = await tx.cancellationPolicyVersion.findMany({
        where: { locationId },
        orderBy: { version: 'desc' },
        select: VERSION_SELECT,
      });
      return rows.map(toVersion);
    });
  }

  createVersion(
    locationId: string,
    input: CancellationPolicyInput,
    createdById: string,
  ): Promise<CancellationPolicyVersion | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // La sede bloqueada serializa dos guardados a la vez de la misma sede:
      // el segundo lee el número que dejó el primero (y el índice único lo
      // respalda). Una sede de otra clínica no se ve (RLS): null → 404.
      const [location] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "locations"
         WHERE "id" = ${locationId}::uuid AND "deletedAt" IS NULL
         FOR UPDATE`;
      if (!location) return null;
      const last = await tx.cancellationPolicyVersion.findFirst({
        where: { locationId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const created = await tx.cancellationPolicyVersion.create({
        data: {
          tenantId,
          locationId,
          version: (last?.version ?? 0) + 1,
          noticeHours: input.noticeHours,
          suggestedFee: input.suggestedFee,
          currency: input.currency,
          patientText: input.patientText,
          receptionCanCharge: input.receptionCanCharge ?? false,
          createdById,
        },
        select: VERSION_SELECT,
      });
      return toVersion(created);
    });
  }

  async currencyExists(code: string): Promise<boolean> {
    // `currencies` es una referencia global (sin RLS, solo lectura para la app).
    const found = await this.prisma.currency.findUnique({
      where: { code },
      select: { code: true },
    });
    return found !== null;
  }
}
