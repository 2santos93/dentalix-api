import { Injectable } from '@nestjs/common';
import { Prisma, type PatientImplantKind } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../shared/locations/location-time-zone';
import type {
  ImplantCardPatient,
  ImplantCatalogEntry,
  ImplantLotMatch,
  PatientImplant,
} from '../domain/entities/patient-implant.entity';
import type { ImplantCardLocation } from '../domain/implant-card';
import type {
  CreatePatientImplantRepoInput,
  ImplantLotQuery,
  PatientImplantRepository,
  VoidImplantOutcome,
} from '../domain/ports/patient-implant-repository.port';

const INCLUDE = {
  location: { select: { name: true } },
  professional: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
} satisfies Prisma.PatientImplantInclude;

type Row = Prisma.PatientImplantGetPayload<{ include: typeof INCLUDE }>;

const DOC_TYPE_LABEL: Record<string, string> = {
  CC: 'CC',
  TI: 'TI',
  CE: 'CE',
  PASSPORT: 'Pasaporte',
  OTHER: 'Doc.',
};

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fromDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

function mapRow(row: Row): PatientImplant {
  return {
    id: row.id,
    patientId: row.patientId,
    locationId: row.locationId,
    locationName: row.location.name,
    professionalId: row.professionalId,
    professionalName: row.professional.fullName,
    placedOn: toDateOnly(row.placedOn),
    toothNumber: row.toothNumber,
    treatmentPlanItemId: row.treatmentPlanItemId,
    kind: row.kind,
    manufacturer: row.manufacturer,
    system: row.system,
    reference: row.reference,
    lot: row.lot,
    udi: row.udi,
    diameterMm: decimal(row.diameterMm),
    lengthMm: decimal(row.lengthMm),
    sanitaryRegistration: row.sanitaryRegistration,
    notes: row.notes,
    createdAt: row.createdAt,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidedByName: row.voidedBy?.fullName ?? null,
    voidReason: row.voidReason,
    cardDeliveredAt: row.cardDeliveredAt,
  };
}

interface LotRow {
  implantId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  docType: string;
  docNumber: string | null;
  phone: string | null;
  placedOn: Date;
  toothNumber: string;
  kind: PatientImplantKind;
  manufacturer: string;
  system: string | null;
  reference: string;
  lot: string;
  professionalName: string;
  locationName: string;
  voided: boolean;
}

/** Tope de filas de la búsqueda por lote (un lote real no llega a tanto). */
export const IMPLANT_LOT_SEARCH_LIMIT = 1000;

/**
 * Todo bajo `runWithTenant` (RLS FORCE). `users` y `tenants` son globales: se
 * leen por el id de la fila o del contexto. El repositorio NUNCA actualiza el
 * contenido de un implante: solo inserta, anula y marca la entrega (lo único
 * que admite el trigger `dx_patient_implants_immutable`).
 */
@Injectable()
export class PrismaPatientImplantRepository implements PatientImplantRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadPatient(patientId: string): Promise<ImplantCardPatient | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          docType: true,
          docNumber: true,
          birthDate: true,
        },
      }),
    );
  }

  resolveLocation(): Promise<{ id: string; timeZone: string }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // DX-089: la sede del request o la de escritura de la sesión.
      const id = await this.tenantContext.writeLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [id]);
      return { id, timeZone: zoneOf(id) };
    });
  }

  async planItemBelongsToPatient(
    planItemId: string,
    patientId: string,
  ): Promise<boolean> {
    const item = await this.prisma.runWithTenant((tx) =>
      tx.treatmentPlanItem.findFirst({
        where: {
          id: planItemId,
          deletedAt: null,
          plan: { patientId, deletedAt: null },
        },
        select: { id: true },
      }),
    );
    return item !== null;
  }

  async create(input: CreatePatientImplantRepoInput): Promise<PatientImplant> {
    const tenantId = this.requireTenantId();
    const { placedOn, ...rest } = input;
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.create({
        data: { ...rest, tenantId, placedOn: fromDateOnly(placedOn) },
        include: INCLUDE,
      }),
    );
    return mapRow(row);
  }

  async listByPatient(patientId: string): Promise<PatientImplant[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.findMany({
        where: { patientId },
        orderBy: [{ placedOn: 'desc' }, { createdAt: 'desc' }],
        include: INCLUDE,
      }),
    );
    return rows.map(mapRow);
  }

  async listByPatientOn(
    patientId: string,
    placedOn: string,
  ): Promise<PatientImplant[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.findMany({
        where: { patientId, placedOn: fromDateOnly(placedOn) },
        orderBy: [{ createdAt: 'asc' }],
        include: INCLUDE,
      }),
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<PatientImplant | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.findFirst({ where: { id }, include: INCLUDE }),
    );
    return row ? mapRow(row) : null;
  }

  /**
   * `updateMany … WHERE voidedAt IS NULL`: una segunda anulación concurrente,
   * al re-evaluar el WHERE tras el bloqueo de la fila, ya no la ve.
   */
  void(
    id: string,
    input: { voidedById: string; voidedAt: Date; reason: string },
  ): Promise<VoidImplantOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.patientImplant.updateMany({
        where: { id, voidedAt: null },
        data: {
          voidedAt: input.voidedAt,
          voidedById: input.voidedById,
          voidReason: input.reason,
        },
      });
      const row = await tx.patientImplant.findFirst({
        where: { id },
        include: INCLUDE,
      });
      if (!row) return { kind: 'NOT_FOUND' };
      if (count === 0) return { kind: 'ALREADY_VOIDED' };
      return { kind: 'VOIDED', implant: mapRow(row) };
    });
  }

  async markCardDelivered(
    patientId: string,
    placedOn: string,
    input: { deliveredById: string; deliveredAt: Date },
  ): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.updateMany({
        where: {
          patientId,
          placedOn: fromDateOnly(placedOn),
          voidedAt: null,
          cardDeliveredAt: null,
        },
        data: {
          cardDeliveredAt: input.deliveredAt,
          cardDeliveredById: input.deliveredById,
        },
      }),
    );
  }

  async clinicName(): Promise<string> {
    const tenantId = this.requireTenantId();
    const tenant = await this.prisma.runWithTenant((tx) =>
      tx.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
    );
    return tenant?.name ?? '';
  }

  locations(ids: string[]): Promise<ImplantCardLocation[]> {
    return this.prisma.runWithTenant((tx) =>
      tx.location.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, address: true },
      }),
    );
  }

  /** Fabricantes y sistemas ya usados por la clínica (también anulados). */
  async catalog(): Promise<ImplantCatalogEntry[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientImplant.groupBy({
        by: ['manufacturer', 'system'],
        orderBy: [{ manufacturer: 'asc' }, { system: 'asc' }],
      }),
    );
    const byManufacturer = new Map<string, string[]>();
    for (const row of rows) {
      const systems = byManufacturer.get(row.manufacturer) ?? [];
      if (row.system) systems.push(row.system);
      byManufacturer.set(row.manufacturer, systems);
    }
    return [...byManufacturer].map(([manufacturer, systems]) => ({
      manufacturer,
      systems,
    }));
  }

  /**
   * Coincidencia exacta sin mayúsculas sobre `upper(btrim(...))`, la misma
   * expresión de los índices patient_implants_tenant_lot_idx / _reference_idx.
   * El `tenantId` explícito, además de la RLS, deja al planificador usarlos.
   */
  async searchByLot(query: ImplantLotQuery): Promise<ImplantLotMatch[]> {
    const tenantId = this.requireTenantId();
    const conditions: Prisma.Sql[] = [
      Prisma.sql`i."tenantId" = ${tenantId}::uuid`,
    ];
    if (query.lot) {
      conditions.push(Prisma.sql`upper(btrim(i."lot")) = upper(${query.lot})`);
    }
    if (query.reference) {
      conditions.push(
        Prisma.sql`upper(btrim(i."reference")) = upper(${query.reference})`,
      );
    }
    const rows = await this.prisma.runWithTenant(
      (tx) =>
        tx.$queryRaw<LotRow[]>`
        SELECT i."id" AS "implantId", i."patientId", p."firstName", p."lastName",
               p."docType"::text AS "docType", p."docNumber", p."phone",
               i."placedOn", i."toothNumber", i."kind", i."manufacturer",
               i."system", i."reference", i."lot",
               u."fullName" AS "professionalName", l."name" AS "locationName",
               (i."voidedAt" IS NOT NULL) AS "voided"
        FROM "patient_implants" i
        JOIN "patients" p ON p."tenantId" = i."tenantId" AND p."id" = i."patientId"
        JOIN "locations" l ON l."tenantId" = i."tenantId" AND l."id" = i."locationId"
        JOIN "users" u ON u."id" = i."professionalId"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY i."placedOn" DESC, p."lastName", p."firstName", i."id"
        LIMIT ${IMPLANT_LOT_SEARCH_LIMIT}`,
    );
    return rows.map((r) => ({
      implantId: r.implantId,
      patientId: r.patientId,
      patientName: `${r.firstName} ${r.lastName}`.trim(),
      patientDocument: r.docNumber
        ? `${DOC_TYPE_LABEL[r.docType] ?? 'Doc.'} ${r.docNumber}`
        : null,
      phone: r.phone,
      placedOn: toDateOnly(r.placedOn),
      toothNumber: r.toothNumber,
      kind: r.kind,
      manufacturer: r.manufacturer,
      system: r.system,
      reference: r.reference,
      lot: r.lot,
      professionalName: r.professionalName,
      locationName: r.locationName,
      voided: r.voided,
    }));
  }
}
