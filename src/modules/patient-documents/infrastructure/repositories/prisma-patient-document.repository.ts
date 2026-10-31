import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type { DetectedType } from '../../domain/document-content';
import type { PatientDocument } from '../../domain/entities/patient-document.entity';
import {
  DuplicateActivePatientDocumentError,
  type CreatePatientDocumentInput,
  type PatientDocumentFilters,
  type PatientDocumentRepository,
  type VoidPatientDocumentOutcome,
} from '../../domain/ports/patient-document-repository.port';

type Row = Prisma.PatientDocumentGetPayload<object>;

/** Único parcial (SQL, no en schema.prisma) de un contenido vigente. */
const ACTIVE_SHA256_INDEX = 'patient_documents_active_sha256_key';

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fromDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function mapRow(row: Row): PatientDocument {
  return {
    id: row.id,
    tenantId: row.tenantId,
    patientId: row.patientId,
    locationId: row.locationId,
    category: row.category,
    originalName: row.originalName,
    // La columna es texto; solo la escribe `create` con el tipo DETECTADO.
    mimeType: row.mimeType as DetectedType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    storageKey: row.storageKey,
    clinicalDate: row.clinicalDate ? toDateOnly(row.clinicalDate) : null,
    toothNumbers: row.toothNumbers,
    notes: row.notes,
    uploadedById: row.uploadedById,
    uploadedAt: row.uploadedAt,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
  };
}

/**
 * ¿Choca con el único parcial del sha256 vigente? Bajo RLS Prisma a veces no
 * informa `meta.target` ("(not available)"); los otros únicos de la tabla
 * (`id`, `storageKey`, `(tenantId, id)`) son uuid recién generados y no
 * chocan en la práctica, así que sin target también se trata como duplicado.
 * Uno que nombra otra columna o índice sube tal cual.
 */
function isActiveSha256Violation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const target = error.meta?.target;
  const names = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
  if (names.length === 0 || names.includes('(not available)')) return true;
  return names.some((n) => n === ACTIVE_SHA256_INDEX || n === 'sha256');
}

/**
 * Todo bajo `runWithTenant` (RLS FORCE): un paciente o documento de otra
 * clínica no existe para esta. Nunca actualiza el contenido de un documento:
 * solo inserta y anula (lo único que admite el trigger
 * `dx_patient_documents_immutable`), y no borra filas.
 */
@Injectable()
export class PrismaPatientDocumentRepository implements PatientDocumentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Sede donde se escribe: la de la cabecera (`X-Location-Id`) o, sin ella, la
   * primera permitida del miembro (DX-089) o la principal de la clínica. ÚNICO
   * punto que la resuelve en el módulo.
   */
  private resolveWriteLocationId(
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    return this.tenantContext.writeLocationId(tx);
  }

  clinicToday(now: Date): Promise<string> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const id = await this.resolveWriteLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [id]);
      return civilDateIn(now, zoneOf(id));
    });
  }

  resolveWriteLocation(): Promise<{ locationId: string; timeZone: string }> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.resolveWriteLocationId(tx);
      const zoneOf = await resolveLocationTimeZones(tx, tenantId, [locationId]);
      return { locationId, timeZone: zoneOf(locationId) };
    });
  }

  async create(input: CreatePatientDocumentInput): Promise<PatientDocument> {
    const tenantId = this.requireTenantId();
    const { clinicalDate, ...rest } = input;
    try {
      const row = await this.prisma.runWithTenant(async (tx) =>
        tx.patientDocument.create({
          data: {
            ...rest,
            tenantId,
            clinicalDate: clinicalDate ? fromDateOnly(clinicalDate) : null,
          },
        }),
      );
      return mapRow(row);
    } catch (error) {
      if (isActiveSha256Violation(error)) {
        throw new DuplicateActivePatientDocumentError();
      }
      throw error;
    }
  }

  async findById(
    patientId: string,
    id: string,
  ): Promise<PatientDocument | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientDocument.findFirst({ where: { id, patientId } }),
    );
    return row ? mapRow(row) : null;
  }

  async listByPatient(
    patientId: string,
    filters: PatientDocumentFilters = {},
  ): Promise<PatientDocument[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.patientDocument.findMany({
        where: {
          patientId,
          ...(filters.category ? { category: filters.category } : {}),
          ...(filters.tooth ? { toothNumbers: { has: filters.tooth } } : {}),
        },
        orderBy: [{ uploadedAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return rows.map(mapRow);
  }

  /**
   * `updateMany … WHERE voidedAt IS NULL`: una segunda anulación concurrente,
   * al re-evaluar el WHERE tras el bloqueo de la fila, ya no la ve.
   */
  void(
    id: string,
    input: { voidedById: string; reason: string },
  ): Promise<VoidPatientDocumentOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      // DX-422: el PDF firmado que archivó el servidor no se anula (en la
      // misma sentencia: nadie lo enlaza entre medias, su fila es READY).
      const { count } = await tx.patientDocument.updateMany({
        where: { id, voidedAt: null, signedConsentPdf: { is: null } },
        data: {
          voidedAt: new Date(),
          voidedById: input.voidedById,
          voidReason: input.reason,
        },
      });
      if (count === 1) return 'VOIDED';
      const exists = await tx.patientDocument.findFirst({
        where: { id },
        select: {
          id: true,
          voidedAt: true,
          signedConsentPdf: { select: { id: true } },
        },
      });
      if (!exists) return 'NOT_FOUND';
      if (!exists.voidedAt && exists.signedConsentPdf) {
        return 'SIGNED_CONSENT_PDF';
      }
      return 'ALREADY_VOIDED';
    });
  }

  async findActiveBySha256(
    patientId: string,
    sha256: string,
  ): Promise<PatientDocument | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patientDocument.findFirst({
        where: { patientId, sha256, voidedAt: null },
      }),
    );
    return row ? mapRow(row) : null;
  }

  /** `users` es global: se lee por id (autor y quien anuló, de esta clínica). */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.runWithTenant((tx) =>
      tx.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true },
      }),
    );
    return new Map(users.map((u) => [u.id, u.fullName]));
  }
}
