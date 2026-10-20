import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  loadLocationTimeZones,
  timeZoneForCountry,
} from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type { RdaFacts } from '../../domain/rda-readiness';
import { performedItemsOf } from './performed-items';
import {
  ClinicalEntryAppointmentRef,
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ADDENDA_ORDER,
  mapAddendum,
} from './prisma-clinical-entry-addendum.repository';

/** DX-170: lo que la ficha muestra de la cita ligada. */
const APPOINTMENT_SUMMARY = {
  select: { id: true, start: true, providerId: true },
} as const;

/** DX-212: diagnósticos con su texto CIE-10, el principal primero. */
const DIAGNOSES = {
  orderBy: { position: 'asc' },
  include: { icd10: { select: { labelEs: true } } },
} as const;

type PrismaClinicalEntry = Prisma.ClinicalEntryGetPayload<{
  include: {
    addenda: true;
    appointment: typeof APPOINTMENT_SUMMARY;
    diagnoses: typeof DIAGNOSES;
  };
}>;

function mapToEntity(
  row: PrismaClinicalEntry,
  providerNames: Map<string, string>,
): ClinicalEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    entryDate: row.entryDate,
    reason: row.reason,
    notes: row.notes,
    performedById: row.performedById,
    appointmentId: row.appointmentId,
    templateId: row.templateId,
    appointment: row.appointment
      ? {
          id: row.appointment.id,
          start: row.appointment.start,
          providerId: row.appointment.providerId,
          providerName: providerNames.get(row.appointment.providerId) ?? null,
        }
      : null,
    createdAt: row.createdAt,
    addenda: row.addenda.map(mapAddendum),
    diagnoses: row.diagnoses.map((d) => ({
      id: d.id,
      icd10Code: d.icd10Code,
      labelEs: d.icd10.labelEs,
      kind: d.kind,
      toothFdi: d.toothFdi,
      position: d.position,
    })),
  };
}

/**
 * Nombres de los profesionales de las citas ligadas. El profesional es un
 * usuario global: su nombre se lee a través de la membresía, que tiene RLS,
 * así que solo aparece si es (o fue) de esta clínica. Sin filtrar `deletedAt`:
 * si dejó la clínica, la cita sigue siendo suya.
 */
async function providerNamesOf(
  tx: Prisma.TransactionClient,
  rows: PrismaClinicalEntry[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((r) => (r.appointment ? [r.appointment.providerId] : [])),
    ),
  ];
  if (ids.length === 0) return new Map();
  const memberships = await tx.clinicMembership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { fullName: true } } },
  });
  return new Map(memberships.map((m) => [m.userId, m.user.fullName]));
}

@Injectable()
export class PrismaClinicalEntryRepository implements ClinicalEntryRepository {
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
   * uses to set `app.current_tenant` (see PrismaMedicalHistoryRepository /
   * PrismaDentalCatalogRepository for the same convention).
   */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  async create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry> {
    const tenantId = this.requireTenantId();

    // Append-only: this is a plain INSERT. There is no update/delete method
    // on this repository at all — immutability enforced at the interface
    // level, not just by convention.
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicalEntry.create({
        data: {
          tenantId,
          patientId: input.patientId,
          entryDate: input.entryDate ?? new Date(),
          reason: input.reason,
          notes: input.notes,
          performedById: input.performedById,
          // DX-170: FK compuestas — la cita tiene que ser de esta clínica y
          // de este paciente; la plantilla, de esta clínica.
          appointmentId: input.appointmentId,
          templateId: input.templateId,
          // DX-212: en la MISMA transacción que la evolución (un trigger
          // rechaza un diagnóstico añadido a una evolución ya guardada).
          diagnoses: input.diagnoses?.length
            ? {
                // tenantId y patientId los pone la relación (FK compuesta).
                create: input.diagnoses.map((d) => ({
                  icd10Code: d.icd10Code,
                  kind: d.kind,
                  toothFdi: d.toothFdi,
                  position: d.position,
                })),
              }
            : undefined,
        },
        include: {
          addenda: true,
          appointment: APPOINTMENT_SUMMARY,
          diagnoses: DIAGNOSES,
        },
      });
      return mapToEntity(row, await providerNamesOf(tx, [row]));
    });
  }

  async findAppointment(
    id: string,
  ): Promise<ClinicalEntryAppointmentRef | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.appointment.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          patientId: true,
          status: true,
          start: true,
          locationId: true,
          location: { select: { country: true } },
        },
      });
      if (!row) return null;
      const zones = await loadLocationTimeZones(tx, tenantId, [row.locationId]);
      return {
        id: row.id,
        patientId: row.patientId,
        status: row.status,
        start: row.start,
        timeZone:
          zones.get(row.locationId) ?? timeZoneForCountry(row.location.country),
      };
    });
  }

  async listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    const where: Prisma.ClinicalEntryWhereInput = {
      patientId,
      deletedAt: null,
      ...(params?.from || params?.to
        ? {
            entryDate: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicalEntry.findMany({
        where,
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        // DX-038: las adendas viajan con su evolución, en orden cronológico.
        include: {
          addenda: { orderBy: ADDENDA_ORDER },
          appointment: APPOINTMENT_SUMMARY,
          diagnoses: DIAGNOSES,
        },
      });
      const names = await providerNamesOf(tx, rows);
      return rows.map((row) => mapToEntity(row, names));
    });
  }

  async existingIcd10Codes(codes: string[]): Promise<Set<string>> {
    // Tabla global de referencia (sin RLS): no necesita el tenant.
    const rows = await this.prisma.icd10Code.findMany({
      where: { code: { in: codes } },
      select: { code: true },
    });
    return new Set(rows.map((r) => r.code));
  }

  /**
   * DX-212. Todo bajo RLS, en una transacción:
   * - sede: la de la cita ligada o, sin cita, la principal de la clínica
   *   (la primera activa; la evolución no guarda sede);
   * - día de la atención: la fecha civil de `entryDate` (la que muestra la
   *   ficha, en UTC);
   * - procedimientos realizados: registros del odontograma del paciente de
   *   tipo PROCEDURE, COMPLETED y hechos en esta clínica, ligados a la
   *   evolución o registrados ese día en la zona de la sede, sin los anulados
   *   ni las anulaciones (lo hecho en un plan se espeja ahí al marcarlo DONE);
   * - autor: su membresía en esta clínica (registro profesional y nombre),
   *   aunque ya no sea miembro.
   */
  async loadRdaFacts(id: string): Promise<RdaFacts | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const entry = await tx.clinicalEntry.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          entryDate: true,
          performedById: true,
          patient: { select: { id: true, docNumber: true } },
          appointment: { select: { locationId: true } },
          diagnoses: { where: { kind: 'PRINCIPAL' }, select: { id: true } },
        },
      });
      if (!entry) return null;

      const locationSelect = {
        id: true,
        name: true,
        country: true,
        repsHabilitationCode: true,
      } as const;
      const location = entry.appointment
        ? await tx.location.findFirst({
            where: { id: entry.appointment.locationId },
            select: locationSelect,
          })
        : await tx.location.findFirst({
            where: { deletedAt: null, isActive: true },
            orderBy: { createdAt: 'asc' },
            select: locationSelect,
          });
      if (!location) return null;

      const zones = await loadLocationTimeZones(tx, tenantId, [location.id]);
      const timeZone =
        zones.get(location.id) ?? timeZoneForCountry(location.country);
      const day = attentionDay(entry.entryDate, timeZone);

      const [performedItems, author] = await Promise.all([
        performedItemsOf(tx, entry.patient.id, [entry.id], day, timeZone),
        entry.performedById
          ? tx.clinicMembership.findFirst({
              where: { userId: entry.performedById },
              orderBy: { createdAt: 'desc' },
              select: {
                professionalLicense: true,
                user: { select: { fullName: true } },
              },
            })
          : null,
      ]);

      return {
        country: location.country,
        location: {
          id: location.id,
          name: location.name,
          repsHabilitationCode: location.repsHabilitationCode,
        },
        patient: entry.patient,
        hasPrincipalDiagnosis: entry.diagnoses.length > 0,
        performedItems,
        author: {
          userId: entry.performedById,
          name: author?.user.fullName ?? null,
          professionalLicense: author?.professionalLicense ?? null,
        },
      };
    });
  }
}

/**
 * Día civil de la atención. Una fecha elegida a mano o la de la cita llega
 * como fecha civil (medianoche UTC, la que muestra la ficha); la de «ahora»
 * (alta sin fecha) es un instante, y su día es el de la zona de la sede.
 */
function attentionDay(entryDate: Date, timeZone: string): string {
  const iso = entryDate.toISOString();
  return iso.endsWith('T00:00:00.000Z')
    ? iso.slice(0, 10)
    : civilDateIn(entryDate, timeZone);
}
