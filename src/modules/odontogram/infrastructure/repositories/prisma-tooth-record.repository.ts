import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreateToothRecordRepoInput,
  CreateToothRecordVoidOutcome,
  CreateToothRecordVoidRepoInput,
  ToothRecordRepository,
} from '../../domain/ports/tooth-record-repository.port';
import { DEFAULT_BUSINESS_HOURS_TIMEZONE } from '../../../../shared/locations/default-business-hours';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';

type PrismaToothRecord = Prisma.ToothRecordGetPayload<Record<string, never>>;

function mapToEntity(row: PrismaToothRecord): ToothRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    toothNumber: row.toothNumber,
    // surfaces is a Postgres enum array column — Prisma already returns it
    // as ToothSurface[]; mapped through explicitly (not passed by
    // reference) so this stays an intentional projection, same convention
    // as every other field on this entity.
    surfaces: row.surfaces.map((surface) => surface),
    kind: row.kind,
    catalogItemId: row.catalogItemId,
    status: row.status,
    notes: row.notes,
    clinicalEntryId: row.clinicalEntryId,
    performedById: row.performedById,
    sourcePlanItemId: row.sourcePlanItemId,
    origin: row.origin,
    voidsRecordId: row.voidsRecordId,
    voidReason: row.voidReason,
    recordedAt: row.recordedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaToothRecordRepository implements ToothRecordRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * `tenantId` is NOT NULL at the DB level with no column default that
   * autofills from the RLS GUC, so — unlike a plain SELECT, which RLS
   * filters transparently — an INSERT still needs the app to supply it
   * explicitly. We never take it from the input (never from the client); we
   * read it from the same request-scoped context that `runWithTenant(fn)`
   * uses to set `app.current_tenant` (see PrismaClinicalEntryRepository /
   * PrismaMedicalHistoryRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreateToothRecordRepoInput): Promise<ToothRecord> {
    const tenantId = this.requireTenantId();

    // Append-only: this is a plain INSERT. There is no update/delete method
    // on this repository at all — immutability enforced at the interface
    // level, not just by convention.
    const row = await this.prisma.runWithTenant(async (tx) => {
      return tx.toothRecord.create({
        data: {
          tenantId,
          patientId: input.patientId,
          toothNumber: input.toothNumber,
          surfaces: input.surfaces,
          kind: input.kind,
          catalogItemId: input.catalogItemId,
          status: input.status,
          notes: input.notes,
          clinicalEntryId: input.clinicalEntryId,
          performedById: input.performedById,
          sourcePlanItemId: input.sourcePlanItemId,
          origin: input.origin,
          recordedAt: input.recordedAt ?? new Date(),
        },
      });
    });
    return mapToEntity(row);
  }

  async listByPatient(patientId: string): Promise<ToothRecord[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.toothRecord.findMany({
        where: { patientId, deletedAt: null },
        orderBy: { recordedAt: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  async listByTooth(
    patientId: string,
    toothNumber: string,
  ): Promise<ToothRecord[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.toothRecord.findMany({
        where: { patientId, toothNumber, deletedAt: null },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map(mapToEntity);
    });
  }

  async findById(patientId: string, id: string): Promise<ToothRecord | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.toothRecord.findFirst({ where: { id, patientId, deletedAt: null } }),
    );
    return row ? mapToEntity(row) : null;
  }

  /**
   * DX-120: la anulación es un INSERT más. El índice único parcial
   * `tooth_records_void_once_key` decide la carrera de dos anulaciones a la
   * vez: la segunda recibe P2002 y se traduce a ALREADY_VOIDED (409).
   */
  async createVoid(
    input: CreateToothRecordVoidRepoInput,
  ): Promise<CreateToothRecordVoidOutcome> {
    const tenantId = this.requireTenantId();
    const { target } = input;
    try {
      const row = await this.prisma.runWithTenant((tx) =>
        tx.toothRecord.create({
          data: {
            tenantId,
            patientId: input.patientId,
            toothNumber: target.toothNumber,
            surfaces: target.surfaces,
            kind: target.kind,
            catalogItemId: target.catalogItemId,
            status: target.status,
            origin: target.origin,
            performedById: input.performedById,
            voidsRecordId: target.id,
            voidReason: input.reason,
          },
        }),
      );
      return { kind: 'CREATED', record: mapToEntity(row) };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { kind: 'ALREADY_VOIDED' };
      }
      throw err;
    }
  }

  /**
   * Nombres por id SOLO de quien tiene (o tuvo) membresía en esta clínica:
   * la membresía va bajo RLS, así que un id de otra clínica no resuelve.
   */
  async memberNames(userIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.findMany({
        where: { userId: { in: [...userIds] } },
        select: { userId: true, user: { select: { fullName: true } } },
      }),
    );
    return new Map(rows.map((r) => [r.userId, r.user.fullName]));
  }

  /** Sede activa (cabecera validada por el guard) → su zona; sin sede, la por defecto. */
  async clinicTimeZone(): Promise<string> {
    const locationId = this.tenantContext.getLocationId();
    if (!locationId) return DEFAULT_BUSINESS_HOURS_TIMEZONE;
    const tenantId = this.requireTenantId();
    const zoneOf = await this.prisma.runWithTenant((tx) =>
      resolveLocationTimeZones(tx, tenantId, [locationId]),
    );
    return zoneOf(locationId);
  }

  // DX-207: bajo RLS y además con el tenant explícito (defensa en
  // profundidad: la columna del registro no tiene FK que lo respalde).
  async catalogItemExists(catalogItemId: string): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.dentalCatalogItem.findFirst({
        where: { id: catalogItemId, tenantId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  async clinicalEntryOfPatientExists(
    patientId: string,
    clinicalEntryId: string,
  ): Promise<boolean> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma.runWithTenant((tx) =>
      tx.clinicalEntry.findFirst({
        where: { id: clinicalEntryId, tenantId, patientId, deletedAt: null },
        select: { id: true },
      }),
    );
    return row !== null;
  }
}
