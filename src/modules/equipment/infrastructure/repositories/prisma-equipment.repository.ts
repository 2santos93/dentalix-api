import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  EquipmentMaintenance,
  EquipmentRecord,
  LastPreventive,
} from '../../domain/entities/equipment.entity';
import type {
  CreateEquipmentRepoInput,
  CreateMaintenanceRepoInput,
  EquipmentRepository,
  ListEquipmentRepoParams,
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

  /** Por `id` bajo RLS; el caso de uso ya comprobó que existe y está activo. */
  update(
    id: string,
    input: UpdateEquipmentRepoInput,
  ): Promise<EquipmentRecord> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.equipment.update({
        where: { id },
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
        include: EQUIPMENT_INCLUDE,
      });
      return this.record(tx, row);
    });
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

  addMaintenance(
    input: CreateMaintenanceRepoInput,
  ): Promise<EquipmentMaintenance> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
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
    });
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
