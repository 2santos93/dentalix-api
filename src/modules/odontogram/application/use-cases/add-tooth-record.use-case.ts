import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CatalogKind, ToothRecordStatus, ToothSurface } from '@prisma/client';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';

// FDI/ISO-3950 tooth codes: permanent dentition is quadrants 1-4 with tooth
// position 1-8 (11-18, 21-28, 31-38, 41-48); primary (deciduous) dentition is
// quadrants 5-8 with tooth position 1-5 (51-55, 61-65, 71-75, 81-85).
export const FDI_TOOTH_NUMBER_PATTERN = /^([1-4][1-8]|[5-8][1-5])$/;

export function isValidFdiToothNumber(
  toothNumber: unknown,
): toothNumber is string {
  return (
    typeof toothNumber === 'string' &&
    FDI_TOOTH_NUMBER_PATTERN.test(toothNumber)
  );
}

const VALID_TOOTH_SURFACES = new Set<string>(Object.values(ToothSurface));

export function isValidToothSurface(surface: unknown): surface is ToothSurface {
  return typeof surface === 'string' && VALID_TOOTH_SURFACES.has(surface);
}

export function areValidToothSurfaces(
  surfaces: unknown,
): surfaces is ToothSurface[] {
  return Array.isArray(surfaces) && surfaces.every(isValidToothSurface);
}

export function isValidCatalogKind(kind: unknown): kind is CatalogKind {
  return kind === CatalogKind.DIAGNOSIS || kind === CatalogKind.PROCEDURE;
}

// NOTE: deliberately NO `tenantId`/`id`/`createdAt`/`performedById` field —
// tenant comes from the guarded request context (never the client, same
// convention as CreateClinicalEntryInput / CreateCatalogItemInput);
// `performedById` is passed as a separate explicit argument sourced from
// `req.user.sub` in the controller, never taken from the request body.
//
// `catalogItemId`/`clinicalEntryId` are optional and are deliberately NOT
// existence/ownership-checked here: a bad or cross-tenant id would only ever
// resolve to nothing under RLS when later joined, so it renders harmlessly.
// Follow-up: add an explicit existence check once the catalog/entry lookups
// are wired through this module (tracked, not scope-creeped into Task 2).
export interface AddToothRecordInput {
  toothNumber: string;
  surfaces?: ToothSurface[];
  kind: CatalogKind;
  catalogItemId?: string;
  status?: ToothRecordStatus;
  notes?: string;
  clinicalEntryId?: string;
  recordedAt?: Date;
}

@Injectable()
export class AddToothRecordUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
  ) {}

  /**
   * Append-only: ALWAYS inserts a brand-new record via `repo.create` — there
   * is no update/delete method on the port at all, so immutability is
   * enforced at the interface level, not just by convention.
   */
  async execute(
    patientId: string,
    input: AddToothRecordInput,
    performedById?: string,
  ): Promise<ToothRecord> {
    if (!isValidFdiToothNumber(input.toothNumber)) {
      throw new BadRequestException(
        'toothNumber must be a valid FDI code (permanent 11-18/21-28/31-38/41-48 or primary 51-55/61-65/71-75/81-85)',
      );
    }

    const surfaces = input.surfaces ?? [];
    if (!areValidToothSurfaces(surfaces)) {
      throw new BadRequestException(
        'surfaces must only contain valid ToothSurface values (MESIAL, DISTAL, OCCLUSAL, VESTIBULAR, LINGUAL)',
      );
    }

    if (!isValidCatalogKind(input.kind)) {
      throw new BadRequestException(
        'kind must be one of: DIAGNOSIS, PROCEDURE',
      );
    }

    // Rebuild the payload from only the known fields — same defensive
    // convention as CreateClinicalEntryUseCase / CreateCatalogItemUseCase:
    // anything sneaked into `input` beyond this shape (e.g. a client-supplied
    // `tenantId`) is dropped here, never forwarded to the repository.
    return this.repo.create({
      patientId,
      toothNumber: input.toothNumber,
      surfaces,
      kind: input.kind,
      catalogItemId: input.catalogItemId,
      status: input.status,
      notes: input.notes,
      clinicalEntryId: input.clinicalEntryId,
      performedById,
      recordedAt: input.recordedAt,
    });
  }
}
