import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { CLINICAL_ENTRY_REPOSITORY } from '../../domain/ports/clinical-entry-repository.port';
import type { ClinicalEntryRepository } from '../../domain/ports/clinical-entry-repository.port';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';

// NOTE: deliberately NO `tenantId`/`id`/`createdAt`/`performedById` field —
// tenant comes from the guarded request context (never the client, same
// convention as MedicalHistoryVersionData / CreateCatalogItemInput);
// `performedById` is passed as a separate explicit argument sourced from
// `req.user.sub` in the controller, never taken from the request body.
export interface CreateClinicalEntryInput {
  entryDate?: Date;
  reason?: string;
  notes: string;
}

@Injectable()
export class CreateClinicalEntryUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
  ) {}

  /**
   * Append-only: ALWAYS inserts a brand-new entry via `repo.create` — there
   * is no update/delete method on the port at all, so immutability is
   * enforced at the interface level, not just by convention.
   */
  async execute(
    patientId: string,
    input: CreateClinicalEntryInput,
    performedById?: string,
  ): Promise<ClinicalEntry> {
    if (input.notes.trim() === '') {
      throw new BadRequestException('notes must not be blank');
    }

    // Rebuild the payload from only the known fields — same defensive
    // convention as SaveMedicalHistoryUseCase / CreateCatalogItemUseCase:
    // anything sneaked into `input` beyond this shape (e.g. a client-supplied
    // `tenantId`/`performedById`) is dropped here, never forwarded to the
    // repository.
    return this.repo.create({
      patientId,
      // entryDate defaults to "now" when the caller omits it.
      entryDate: input.entryDate ?? new Date(),
      reason: input.reason,
      notes: input.notes,
      performedById,
    });
  }
}
