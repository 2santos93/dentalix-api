import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { InstantRange } from '../../../shared/time/civil-day';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { mapMedicalHistoryVersion } from '../../medical-history/infrastructure/repositories/prisma-medical-history.repository';
import type { MedicalHistory } from '../../medical-history/domain/entities/medical-history.entity';
import type { ClinicalRecordCopySummary } from '../domain/clinical-record-copy';
import type {
  ClinicalRecordCopyRepository,
  CopyContext,
  CopyLookupIds,
  NewClinicalRecordCopy,
} from '../domain/ports/clinical-record-copy-repository.port';
import type {
  CopyAppointmentSource,
  CopyLookups,
} from '../domain/copy-content';

const SUMMARY_SELECT = {
  id: true,
  rangeFrom: true,
  rangeTo: true,
  sections: true,
  deliveredTo: true,
  createdAt: true,
  generatedById: true,
  generatedBy: { select: { fullName: true } },
  location: { select: { id: true, name: true } },
} as const satisfies Prisma.ClinicalRecordCopySelect;

type SummaryRow = Prisma.ClinicalRecordCopyGetPayload<{
  select: typeof SUMMARY_SELECT;
}>;

/** Día civil de una columna DATE (Prisma la trae como medianoche UTC). */
function civilDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** El día civil como valor de una columna DATE. */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function summaryOf(row: SummaryRow): ClinicalRecordCopySummary {
  return {
    id: row.id,
    from: civilDay(row.rangeFrom),
    to: civilDay(row.rangeTo),
    sections: row.sections,
    deliveredTo: row.deliveredTo,
    generatedAt: row.createdAt,
    generatedBy: { id: row.generatedById, name: row.generatedBy.fullName },
    location: { id: row.location.id, name: row.location.name },
  };
}

function compact(ids: Iterable<string | null>): string[] {
  const out = new Set<string>();
  for (const id of ids) if (id) out.add(id);
  return [...out];
}

@Injectable()
export class PrismaClinicalRecordCopyRepository implements ClinicalRecordCopyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Sin clínica en el contexto');
    return tenantId;
  }

  generationLocationId(): Promise<string> {
    return this.prisma.runWithTenant((tx) =>
      this.tenantContext.writeLocationId(tx),
    );
  }

  loadContext(
    patientId: string,
    locationId: string,
  ): Promise<CopyContext | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          firstName: true,
          lastName: true,
          patientCode: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
          birthDate: true,
        },
      });
      if (!patient) return null;
      const [tenant, location] = await Promise.all([
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            legalName: true,
            taxIdLabel: true,
            taxId: true,
          },
        }),
        // Sin filtrar `deletedAt`/`isActive`: una copia de una sede retirada
        // se sigue reimprimiendo con su nombre.
        tx.location.findFirstOrThrow({
          where: { id: locationId },
          select: {
            id: true,
            name: true,
            address: true,
            timeZone: true,
            locale: true,
            hourCycle: true,
          },
        }),
      ]);
      const { documentType, ...rest } = patient;
      return {
        patient: { ...rest, docType: documentType },
        clinic: tenant,
        location,
      };
    });
  }

  create(
    record: NewClinicalRecordCopy,
    audit: AuditRequestContext,
  ): Promise<ClinicalRecordCopySummary> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicalRecordCopy.create({
        data: {
          tenantId,
          patientId: record.patientId,
          locationId: record.locationId,
          rangeFrom: dateColumn(record.from),
          rangeTo: dateColumn(record.to),
          sections: record.sections,
          deliveredTo: record.deliveredTo,
          generatedById: audit.actor.userId,
        },
        select: SUMMARY_SELECT,
      });
      await writeAuditEvent(tx, {
        tenantId,
        locationId: record.locationId,
        actor: {
          kind: 'user',
          userId: audit.actor.userId,
          role: audit.actor.role,
        },
        action: 'EXPORT',
        resourceType: 'PATIENT',
        resourceId: record.patientId,
        patient: { kind: 'patient', id: record.patientId },
        requestId: audit.requestId,
        ip: audit.ip,
        userAgent: audit.userAgent,
        metadata: {
          reason: 'CLINICAL_RECORD_COPY_GENERATED',
          params: { patientId: record.patientId, copyId: row.id },
          period: { from: record.from, to: record.to },
          recordCopy: {
            sections: record.sections,
            deliveredTo: record.deliveredTo !== null,
          },
        },
      });
      return summaryOf(row);
    });
  }

  list(patientId: string): Promise<ClinicalRecordCopySummary[]> {
    // DX-089: un miembro restringido solo ve las generaciones de SUS sedes
    // (llevan «entregado a»). Las sedes permitidas, no la de la cabecera: un
    // ADMIN o un miembro de varias sedes ve las de todas las suyas.
    const allowed = this.tenantContext.getAllowedLocationIds();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicalRecordCopy.findMany({
        where: {
          patientId,
          ...(allowed === 'ALL' ? {} : { locationId: { in: [...allowed] } }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: SUMMARY_SELECT,
      });
      return rows.map(summaryOf);
    });
  }

  find(
    patientId: string,
    id: string,
  ): Promise<ClinicalRecordCopySummary | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicalRecordCopy.findFirst({
        where: { id, patientId },
        select: SUMMARY_SELECT,
      });
      return row ? summaryOf(row) : null;
    });
  }

  lookups(ids: CopyLookupIds): Promise<CopyLookups> {
    const userIds = compact(ids.userIds);
    const entryIds = [...new Set(ids.entryIds)];
    const catalogIds = compact(ids.catalogItemIds);
    return this.prisma.runWithTenant(async (tx) => {
      // La sede de cada evolución (DX-232) no viaja en la entidad de la
      // historia: se lee aquí y se suma a las sedes que hay que nombrar.
      const entries = entryIds.length
        ? await tx.clinicalEntry.findMany({
            where: { id: { in: entryIds } },
            select: { id: true, locationId: true },
          })
        : [];
      const locationIds = compact([
        ...ids.locationIds,
        ...entries.map((e) => e.locationId),
      ]);
      const [memberships, locations, catalog] = await Promise.all([
        // El nombre de un usuario se lee por su membresía (RLS): solo aparece
        // si es (o fue) de esta clínica. Sin filtrar `deletedAt`: quien dejó
        // la clínica sigue siendo el autor de lo que escribió.
        userIds.length
          ? tx.clinicMembership.findMany({
              where: { userId: { in: userIds } },
              select: { userId: true, user: { select: { fullName: true } } },
            })
          : [],
        locationIds.length
          ? tx.location.findMany({
              where: { id: { in: locationIds } },
              select: { id: true, name: true },
            })
          : [],
        catalogIds.length
          ? tx.dentalCatalogItem.findMany({
              where: { id: { in: catalogIds } },
              select: { id: true, labelEs: true },
            })
          : [],
      ]);
      const users = new Map(
        memberships.map((m) => [m.userId, m.user.fullName]),
      );
      const places = new Map(locations.map((l) => [l.id, l.name]));
      const entrySede = new Map(entries.map((e) => [e.id, e.locationId]));
      const labels = new Map(catalog.map((c) => [c.id, c.labelEs]));
      return {
        userName: (id) => (id ? (users.get(id) ?? null) : null),
        locationName: (id) => (id ? (places.get(id) ?? null) : null),
        entryLocationId: (id) => entrySede.get(id) ?? null,
        catalogLabel: (id) => (id ? (labels.get(id) ?? null) : null),
      };
    });
  }

  anamnesisVersions(
    patientId: string,
    range: InstantRange,
  ): Promise<MedicalHistory[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.medicalHistoryVersion.findMany({
        where: {
          patientId,
          deletedAt: null,
          createdAt: { gte: range.start, lt: range.end },
        },
        orderBy: { version: 'asc' },
      });
      return rows.map(mapMedicalHistoryVersion);
    });
  }

  appointments(
    patientId: string,
    range: InstantRange,
  ): Promise<CopyAppointmentSource[]> {
    const allowed = this.tenantContext.getAllowedLocationIds();
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.appointment.findMany({
        where: {
          patientId,
          deletedAt: null,
          start: { gte: range.start, lt: range.end },
          ...(allowed === 'ALL' ? {} : { locationId: { in: [...allowed] } }),
        },
        orderBy: [{ start: 'asc' }, { id: 'asc' }],
        select: {
          start: true,
          end: true,
          status: true,
          providerId: true,
          locationId: true,
          reason: true,
          createdAt: true,
          appointmentType: { select: { name: true } },
        },
      });
      return rows.map(({ appointmentType, ...a }) => ({
        ...a,
        typeName: appointmentType?.name ?? null,
      }));
    });
  }
}
