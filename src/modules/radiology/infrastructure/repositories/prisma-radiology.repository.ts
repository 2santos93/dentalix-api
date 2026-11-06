import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { RadiologyRecordRecord } from '../../domain/entities/radiology-record.entity';
import {
  RADIOLOGY_OFFICER_NOT_FOUND_MESSAGE,
  RADIOLOGY_VOIDED_MESSAGE,
} from '../../domain/radiology-rules';
import type {
  CreateRadiologyRepoInput,
  ListRadiologyRepoParams,
  RadiologyDueRepoParams,
  RadiologyRepository,
  UpdateRadiologyRepoInput,
} from '../../domain/ports/radiology-repository.port';

const RECORD_INCLUDE = {
  location: { select: { name: true, timeZone: true } },
  equipment: { select: { name: true } },
  officerMembership: { select: { user: { select: { fullName: true } } } },
} satisfies Prisma.RadiologyRecordInclude;

type RecordRow = Prisma.RadiologyRecordGetPayload<{
  include: typeof RECORD_INCLUDE;
}>;

/** El vencimiento más próximo primero; el id desempata (página estable). */
const ORDER = [
  { expiresOn: 'asc' },
  { id: 'asc' },
] satisfies Prisma.RadiologyRecordOrderByWithRelationInput[];

/** Una columna DATE llega como medianoche UTC: su día civil es el ISO. */
function civil(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function asDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Grupo de renovación: mismo tipo, sede y equipo (o «toda la sede»). */
function groupKey(row: {
  locationId: string;
  kind: string;
  equipmentId: string | null;
}): string {
  return `${row.locationId}|${row.kind}|${row.equipmentId ?? ''}`;
}

function mapRecord(row: RecordRow, renewed: boolean): RadiologyRecordRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    equipmentId: row.equipmentId,
    kind: row.kind,
    category: row.category,
    reference: row.reference,
    issuer: row.issuer,
    issuedOn: civil(row.issuedOn),
    expiresOn: civil(row.expiresOn),
    officerUserId: row.officerUserId,
    officerName: row.officerName,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    locationName: row.location.name,
    locationTimeZone: row.location.timeZone,
    equipmentName: row.equipment?.name ?? null,
    officerMemberName: row.officerMembership?.user.fullName ?? null,
    renewed,
  };
}

/**
 * DX-544: ids de los documentos VIVOS que vencen en `expiresOnOrBefore` o
 * antes y que NO se han renovado (ningún otro vivo del mismo tipo, sede y
 * equipo vence después). Compara `tenantId` con `=` para que, bajo RLS FORCE,
 * use `radiology_records_tenant_location_expires_idx`.
 */
export function radiologyDueCandidatesSql(
  tenantId: string,
  params: RadiologyDueRepoParams,
): Prisma.Sql {
  const byLocation = params.locationIds
    ? Prisma.sql`AND r."locationId" IN (${Prisma.join(
        params.locationIds.map((id) => Prisma.sql`${id}::uuid`),
      )})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT r."id"
    FROM "radiology_records" r
    WHERE r."tenantId" = ${tenantId}::uuid
      AND r."voidedAt" IS NULL
      ${byLocation}
      AND r."expiresOn" <= ${params.expiresOnOrBefore}::date
      AND NOT EXISTS (
        SELECT 1 FROM "radiology_records" n
        WHERE n."tenantId" = ${tenantId}::uuid
          AND n."locationId" = r."locationId"
          AND n."kind" = r."kind"
          AND n."equipmentId" IS NOT DISTINCT FROM r."equipmentId"
          AND n."voidedAt" IS NULL
          AND n."expiresOn" > r."expiresOn"
      )`;
}

/**
 * Red por si el trigger `dx_radiology_records_voided_final` saltara (una
 * escritura que no pasó por el UPDATE condicional): su `insufficient_privilege`
 * (42501) es «está anulado», un 409 en español, no un 500.
 */
function rethrowVoided(error: unknown): never {
  const text = error instanceof Error ? error.message : '';
  if (/42501|un documento anulado no se modifica/.test(text)) {
    throw new ConflictException(RADIOLOGY_VOIDED_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaRadiologyRepository implements RadiologyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * `renewed` de cada fila: hay otro documento VIVO de su grupo (tipo, sede
   * y equipo) que vence después. Una consulta para la página entera.
   */
  private async withRenewed(
    tx: Prisma.TransactionClient,
    rows: RecordRow[],
  ): Promise<RadiologyRecordRecord[]> {
    if (rows.length === 0) return [];
    const tenantId = this.requireTenantId();
    const locations = [...new Set(rows.map((r) => r.locationId))];
    const latest = await tx.$queryRaw<
      {
        locationId: string;
        kind: string;
        equipmentId: string | null;
        expiresOn: Date;
      }[]
    >`
      SELECT "locationId", "kind"::text AS "kind", "equipmentId",
             max("expiresOn") AS "expiresOn"
      FROM "radiology_records"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "locationId" IN (${Prisma.join(
          locations.map((id) => Prisma.sql`${id}::uuid`),
        )})
        AND "voidedAt" IS NULL
      GROUP BY "locationId", "kind", "equipmentId"`;
    const maxByGroup = new Map(
      latest.map((g) => [groupKey(g), civil(g.expiresOn)]),
    );
    return rows.map((row) => {
      const max = maxByGroup.get(groupKey(row));
      const renewed =
        row.voidedAt === null &&
        max !== undefined &&
        max > civil(row.expiresOn);
      return mapRecord(row, renewed);
    });
  }

  private async one(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<RadiologyRecordRecord> {
    const row = await tx.radiologyRecord.findFirstOrThrow({
      where: { id },
      include: RECORD_INCLUDE,
    });
    const [record] = await this.withRenewed(tx, [row]);
    return record;
  }

  /**
   * La membresía VIVA del encargado en esta clínica (RLS), que la FK
   * compuesta radiology_records_officer_fkey exige junto con el usuario. El
   * caso de uso ya comprobó que es un miembro activo.
   */
  private async membershipOf(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const membership = await tx.clinicMembership.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException(RADIOLOGY_OFFICER_NOT_FOUND_MESSAGE);
    }
    return membership.id;
  }

  list(
    params: ListRadiologyRepoParams,
  ): Promise<{ rows: RadiologyRecordRecord[]; total: number }> {
    const where: Prisma.RadiologyRecordWhereInput = {
      ...(params.locationIds
        ? { locationId: { in: [...params.locationIds] } }
        : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.status === 'ALL'
        ? {}
        : { voidedAt: params.status === 'LIVE' ? null : { not: null } }),
    };
    return this.prisma.runWithTenant(async (tx) => {
      const total = await tx.radiologyRecord.count({ where });
      const rows = await tx.radiologyRecord.findMany({
        where,
        include: RECORD_INCLUDE,
        orderBy: ORDER,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      });
      return { rows: await this.withRenewed(tx, rows), total };
    });
  }

  listDueCandidates(
    params: RadiologyDueRepoParams,
  ): Promise<RadiologyRecordRecord[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>(
        radiologyDueCandidatesSql(tenantId, params),
      );
      if (ids.length === 0) return [];
      const rows = await tx.radiologyRecord.findMany({
        where: { tenantId, id: { in: ids.map((r) => r.id) } },
        include: RECORD_INCLUDE,
        orderBy: ORDER,
      });
      return this.withRenewed(tx, rows);
    });
  }

  findById(id: string): Promise<RadiologyRecordRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.radiologyRecord.findFirst({
        where: { id },
        include: RECORD_INCLUDE,
      });
      if (!row) return null;
      const [record] = await this.withRenewed(tx, [row]);
      return record;
    });
  }

  create(input: CreateRadiologyRepoInput): Promise<RadiologyRecordRecord> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const officerMembershipId = input.officerUserId
        ? await this.membershipOf(tx, input.officerUserId)
        : null;
      const row = await tx.radiologyRecord.create({
        data: {
          tenantId,
          locationId: input.locationId,
          equipmentId: input.equipmentId,
          kind: input.kind,
          category: input.category,
          reference: input.reference,
          issuer: input.issuer,
          issuedOn: asDate(input.issuedOn),
          expiresOn: asDate(input.expiresOn),
          officerUserId: input.officerUserId,
          officerMembershipId,
          officerName: input.officerName,
          notes: input.notes,
          createdById: input.createdById,
          updatedById: input.createdById,
        },
        include: RECORD_INCLUDE,
      });
      const [record] = await this.withRenewed(tx, [row]);
      return record;
    });
  }

  /**
   * Por `id` bajo RLS y SOLO si sigue vivo: el UPDATE condicional no choca
   * con el trigger cuando otra petición lo anuló entre la lectura del caso de
   * uso y esta escritura (`null` → 409). El mismo encargado conserva su
   * membresía (aunque se haya desactivado después); uno nuevo toma la viva.
   */
  update(
    id: string,
    input: UpdateRadiologyRepoInput,
  ): Promise<RadiologyRecordRecord | null> {
    return this.prisma
      .runWithTenant(async (tx) => {
        const current = await tx.radiologyRecord.findFirst({
          where: { id, voidedAt: null },
          select: { officerUserId: true, officerMembershipId: true },
        });
        if (!current) return null;
        const officerMembershipId =
          input.officerUserId === null
            ? null
            : input.officerUserId === current.officerUserId
              ? current.officerMembershipId
              : await this.membershipOf(tx, input.officerUserId);
        const { count } = await tx.radiologyRecord.updateMany({
          where: { id, voidedAt: null },
          data: {
            locationId: input.locationId,
            equipmentId: input.equipmentId,
            category: input.category,
            reference: input.reference,
            issuer: input.issuer,
            issuedOn: asDate(input.issuedOn),
            expiresOn: asDate(input.expiresOn),
            officerUserId: input.officerUserId,
            officerMembershipId,
            officerName: input.officerName,
            notes: input.notes,
            updatedById: input.updatedById,
          },
        });
        if (count === 0) return null;
        return this.one(tx, id);
      })
      .catch(rethrowVoided);
  }

  void(
    id: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<RadiologyRecordRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: de dos anulaciones a la vez, solo una cambia la fila.
      const { count } = await tx.radiologyRecord.updateMany({
        where: { id, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidedById: input.voidedById,
          voidReason: input.voidReason,
          updatedById: input.voidedById,
        },
      });
      if (count === 0) return null;
      return this.one(tx, id);
    });
  }
}
