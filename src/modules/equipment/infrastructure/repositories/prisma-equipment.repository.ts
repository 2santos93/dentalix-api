import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  EquipmentMaintenance,
  EquipmentRecord,
  LastPreventive,
} from '../../domain/entities/equipment.entity';
import { EQUIPMENT_RETIRED_MESSAGE } from '../../domain/equipment-rules';
import type {
  CreateEquipmentRepoInput,
  CreateMaintenanceRepoInput,
  EquipmentRepository,
  ListEquipmentRepoParams,
  MaintenanceCandidatesRepoParams,
  RetireEquipmentRepoInput,
  UpdateEquipmentRepoInput,
} from '../../domain/ports/equipment-repository.port';

const EQUIPMENT_INCLUDE = {
  location: { select: { name: true, timeZone: true } },
  chair: { select: { name: true } },
} satisfies Prisma.EquipmentInclude;

type EquipmentRow = Prisma.EquipmentGetPayload<{
  include: typeof EQUIPMENT_INCLUDE;
}>;

const MAINTENANCE_INCLUDE = {
  createdBy: { select: { fullName: true } },
} satisfies Prisma.EquipmentMaintenanceInclude;

type MaintenanceRow = Prisma.EquipmentMaintenanceGetPayload<{
  include: typeof MAINTENANCE_INCLUDE;
}>;

const ORDER = [
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.EquipmentOrderByWithRelationInput[];

/** Una columna DATE llega como medianoche UTC: su día civil es el ISO. */
function civil(value: Date): string;
function civil(value: Date | null): string | null;
function civil(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function asDate(day: string): Date;
function asDate(day: string | null): Date | null;
function asDate(day: string | null): Date | null {
  return day === null ? null : new Date(`${day}T00:00:00.000Z`);
}

function maybeDate(day: string | null | undefined): Date | null | undefined {
  return day === undefined ? undefined : asDate(day);
}

interface MaintenanceFacts {
  lastPreventive: LastPreventive | null;
  lastMaintenanceOn: string | null;
}

function mapEquipment(
  row: EquipmentRow,
  facts: MaintenanceFacts | undefined,
): EquipmentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    chairId: row.chairId,
    name: row.name,
    category: row.category,
    brand: row.brand,
    model: row.model,
    serialNumber: row.serialNumber,
    sanitaryRegistration: row.sanitaryRegistration,
    riskClass: row.riskClass,
    acquiredOn: civil(row.acquiredOn),
    maintenanceIntervalMonths: row.maintenanceIntervalMonths,
    status: row.status,
    retiredOn: civil(row.retiredOn),
    retiredReason: row.retiredReason,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    locationName: row.location.name,
    locationTimeZone: row.location.timeZone,
    chairName: row.chair?.name ?? null,
    lastPreventive: facts?.lastPreventive ?? null,
    lastMaintenanceOn: facts?.lastMaintenanceOn ?? null,
  };
}

function mapMaintenance(row: MaintenanceRow): EquipmentMaintenance {
  return {
    id: row.id,
    equipmentId: row.equipmentId,
    kind: row.kind,
    performedOn: civil(row.performedOn),
    technician: row.technician,
    company: row.company,
    description: row.description,
    cost: row.cost === null ? null : row.cost.toNumber(),
    currency: row.currency,
    nextDueOn: civil(row.nextDueOn),
    createdById: row.createdById,
    createdByName: row.createdBy.fullName,
    createdAt: row.createdAt,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidReason: row.voidReason,
  };
}

/**
 * DX-543: ids de los equipos ACTIVOS cuyo próximo preventivo cae en
 * `dueOnOrBefore` o antes. Repite en SQL `nextMaintenanceOn`: la fecha que
 * dejó fijada el último preventivo vivo; si no fijó ninguna, su fecha + la
 * periodicidad; sin preventivos, la adquisición + la periodicidad (NULL = sin
 * programar, nunca sale). `date + interval 'n months'` recorta a fin de mes
 * igual que `addCivilMonths`. Compara `tenantId` con `=` para que, bajo RLS
 * FORCE, use `equipment_tenant_active_location_idx` y el índice de la hoja de
 * vida (lo comprueba `test/equipment-maintenance-due.int-spec.ts`).
 */
export function maintenanceCandidatesSql(
  tenantId: string,
  params: MaintenanceCandidatesRepoParams,
): Prisma.Sql {
  const byLocation = params.locationIds
    ? Prisma.sql`AND e."locationId" IN (${Prisma.join(
        params.locationIds.map((id) => Prisma.sql`${id}::uuid`),
      )})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT e."id"
    FROM "equipment" e
    LEFT JOIN LATERAL (
      SELECT m."performedOn", m."nextDueOn"
      FROM "equipment_maintenances" m
      WHERE m."tenantId" = ${tenantId}::uuid
        AND m."equipmentId" = e."id"
        AND m."voidedAt" IS NULL
        AND m."kind" = 'PREVENTIVE'
      ORDER BY m."performedOn" DESC, m."createdAt" DESC
      LIMIT 1
    ) lp ON true
    WHERE e."tenantId" = ${tenantId}::uuid
      AND e."status" = 'ACTIVE'
      ${byLocation}
      AND COALESCE(
            lp."nextDueOn",
            (COALESCE(lp."performedOn", e."acquiredOn")
              + make_interval(months => e."maintenanceIntervalMonths"))::date
          ) <= ${params.dueOnOrBefore}::date`;
}

/**
 * Red por si el trigger `dx_equipment_retired_final` aún saltara (una
 * escritura que no pasó por el UPDATE condicional): su `insufficient_privilege`
 * (42501) es «está dado de baja», un 409 en español, no un 500.
 */
function rethrowRetired(error: unknown): never {
  const text = error instanceof Error ? error.message : '';
  if (/42501|un equipo dado de baja no se modifica/.test(text)) {
    throw new ConflictException(EQUIPMENT_RETIRED_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaEquipmentRepository implements EquipmentRepository {
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
   * El último preventivo vivo y la fecha del último mantenimiento vivo de
   * cada equipo, en dos consultas para la página entera (sin N+1). Comparan
   * `tenantId` con `=` para usar el índice de la hoja de vida bajo RLS.
   */
  private async factsOf(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
  ): Promise<Map<string, MaintenanceFacts>> {
    const facts = new Map<string, MaintenanceFacts>();
    if (ids.length === 0) return facts;
    const tenantId = this.requireTenantId();
    const idList = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
    const preventives = await tx.$queryRaw<
      { equipmentId: string; performedOn: Date; nextDueOn: Date | null }[]
    >`
      SELECT DISTINCT ON ("equipmentId")
             "equipmentId", "performedOn", "nextDueOn"
      FROM "equipment_maintenances"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "equipmentId" IN (${idList})
        AND "voidedAt" IS NULL
        AND "kind" = 'PREVENTIVE'
      ORDER BY "equipmentId", "performedOn" DESC, "createdAt" DESC`;
    const latest = await tx.$queryRaw<
      { equipmentId: string; performedOn: Date }[]
    >`
      SELECT "equipmentId", max("performedOn") AS "performedOn"
      FROM "equipment_maintenances"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "equipmentId" IN (${idList})
        AND "voidedAt" IS NULL
      GROUP BY "equipmentId"`;
    for (const row of latest) {
      facts.set(row.equipmentId, {
        lastPreventive: null,
        lastMaintenanceOn: civil(row.performedOn),
      });
    }
    for (const row of preventives) {
      const current = facts.get(row.equipmentId);
      if (!current) continue;
      current.lastPreventive = {
        performedOn: civil(row.performedOn),
        nextDueOn: civil(row.nextDueOn),
      };
    }
    return facts;
  }

  private async record(
    tx: Prisma.TransactionClient,
    row: EquipmentRow,
  ): Promise<EquipmentRecord> {
    const facts = await this.factsOf(tx, [row.id]);
    return mapEquipment(row, facts.get(row.id));
  }

  list(
    params: ListEquipmentRepoParams,
  ): Promise<{ rows: EquipmentRecord[]; total: number }> {
    const where: Prisma.EquipmentWhereInput = {
      ...(params.locationIds
        ? { locationId: { in: [...params.locationIds] } }
        : {}),
      ...(params.status === 'ALL' ? {} : { status: params.status }),
      ...(params.query
        ? {
            OR: (['name', 'brand', 'model', 'serialNumber'] as const).map(
              (field) => ({
                [field]: { contains: params.query, mode: 'insensitive' },
              }),
            ),
          }
        : {}),
    };
    return this.prisma.runWithTenant(async (tx) => {
      const total = await tx.equipment.count({ where });
      const rows = await tx.equipment.findMany({
        where,
        include: EQUIPMENT_INCLUDE,
        orderBy: ORDER,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      });
      const facts = await this.factsOf(
        tx,
        rows.map((r) => r.id),
      );
      return {
        rows: rows.map((r) => mapEquipment(r, facts.get(r.id))),
        total,
      };
    });
  }

  listMaintenanceCandidates(
    params: MaintenanceCandidatesRepoParams,
  ): Promise<EquipmentRecord[]> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>(
        maintenanceCandidatesSql(tenantId, params),
      );
      if (ids.length === 0) return [];
      const rows = await tx.equipment.findMany({
        where: { tenantId, id: { in: ids.map((r) => r.id) } },
        include: EQUIPMENT_INCLUDE,
        orderBy: ORDER,
      });
      const facts = await this.factsOf(
        tx,
        rows.map((r) => r.id),
      );
      return rows.map((r) => mapEquipment(r, facts.get(r.id)));
    });
  }

  findById(id: string): Promise<EquipmentRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.equipment.findFirst({
        where: { id },
        include: EQUIPMENT_INCLUDE,
      });
      return row ? this.record(tx, row) : null;
    });
  }

  create(input: CreateEquipmentRepoInput): Promise<EquipmentRecord> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.equipment.create({
        data: {
          tenantId,
          locationId: input.locationId,
          chairId: input.chairId,
          name: input.name,
          category: input.category,
          brand: input.brand,
          model: input.model,
          serialNumber: input.serialNumber,
          sanitaryRegistration: input.sanitaryRegistration,
          riskClass: input.riskClass,
          acquiredOn: asDate(input.acquiredOn),
          maintenanceIntervalMonths: input.maintenanceIntervalMonths,
          notes: input.notes,
          createdById: input.createdById,
          updatedById: input.createdById,
        },
        include: EQUIPMENT_INCLUDE,
      });
      return this.record(tx, row);
    });
  }

  /**
   * Por `id` bajo RLS y SOLO si sigue activo: el UPDATE condicional no choca
   * con el trigger `dx_equipment_retired_final` cuando otra petición lo dio de
   * baja entre la lectura del caso de uso y esta escritura (`null` → 409).
   */
  update(
    id: string,
    input: UpdateEquipmentRepoInput,
  ): Promise<EquipmentRecord | null> {
    return this.prisma
      .runWithTenant(async (tx) => {
        const { count } = await tx.equipment.updateMany({
          where: { id, status: 'ACTIVE' },
          data: {
            locationId: input.locationId,
            chairId: input.chairId,
            name: input.name,
            category: input.category,
            brand: input.brand,
            model: input.model,
            serialNumber: input.serialNumber,
            sanitaryRegistration: input.sanitaryRegistration,
            riskClass: input.riskClass,
            acquiredOn: maybeDate(input.acquiredOn),
            maintenanceIntervalMonths: input.maintenanceIntervalMonths,
            notes: input.notes,
            updatedById: input.updatedById,
          },
        });
        if (count === 0) return null;
        const row = await tx.equipment.findFirstOrThrow({
          where: { id },
          include: EQUIPMENT_INCLUDE,
        });
        return this.record(tx, row);
      })
      .catch(rethrowRetired);
  }

  retire(
    id: string,
    input: RetireEquipmentRepoInput,
  ): Promise<EquipmentRecord | null> {
    return this.prisma.runWithTenant(async (tx) => {
      // Condicional: de dos bajas a la vez, solo una cambia la fila.
      const { count } = await tx.equipment.updateMany({
        where: { id, status: 'ACTIVE' },
        data: {
          status: 'RETIRED',
          retiredOn: asDate(input.retiredOn),
          retiredReason: input.retiredReason,
          retiredById: input.retiredById,
          updatedById: input.retiredById,
        },
      });
      if (count === 0) return null;
      const row = await tx.equipment.findFirstOrThrow({
        where: { id },
        include: EQUIPMENT_INCLUDE,
      });
      return this.record(tx, row);
    });
  }

  listMaintenances(equipmentId: string): Promise<EquipmentMaintenance[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.equipmentMaintenance.findMany({
        where: { equipmentId },
        include: MAINTENANCE_INCLUDE,
        orderBy: [{ performedOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(mapMaintenance);
    });
  }

  findMaintenance(
    equipmentId: string,
    maintenanceId: string,
  ): Promise<EquipmentMaintenance | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.equipmentMaintenance.findFirst({
        where: { id: maintenanceId, equipmentId },
        include: MAINTENANCE_INCLUDE,
      });
      return row ? mapMaintenance(row) : null;
    });
  }

  /**
   * Bloquea el equipo (`FOR UPDATE`) y registra solo si sigue activo: una baja
   * simultánea espera a este alta o la deja sin equipo activo (`null` → 409).
   */
  addMaintenance(
    input: CreateMaintenanceRepoInput,
  ): Promise<EquipmentMaintenance | null> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const active = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "equipment"
          WHERE "tenantId" = ${tenantId}::uuid
            AND "id" = ${input.equipmentId}::uuid
            AND "status" = 'ACTIVE'
          FOR UPDATE`;
        if (active.length === 0) return null;
        const row = await tx.equipmentMaintenance.create({
          data: {
            tenantId,
            equipmentId: input.equipmentId,
            kind: input.kind,
            performedOn: asDate(input.performedOn),
            technician: input.technician,
            company: input.company,
            description: input.description,
            cost: input.cost === null ? null : new Prisma.Decimal(input.cost),
            currency: input.currency,
            nextDueOn: asDate(input.nextDueOn),
            createdById: input.createdById,
          },
          include: MAINTENANCE_INCLUDE,
        });
        return mapMaintenance(row);
      })
      .catch(rethrowRetired);
  }

  voidMaintenance(
    maintenanceId: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<EquipmentMaintenance | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.equipmentMaintenance.updateMany({
        where: { id: maintenanceId, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidedById: input.voidedById,
          voidReason: input.voidReason,
        },
      });
      if (count === 0) return null;
      const row = await tx.equipmentMaintenance.findFirstOrThrow({
        where: { id: maintenanceId },
        include: MAINTENANCE_INCLUDE,
      });
      return mapMaintenance(row);
    });
  }
}
