import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CLINICAL_ENTRY_REPOSITORY } from '../../domain/ports/clinical-entry-repository.port';
import type { ClinicalEntryRepository } from '../../domain/ports/clinical-entry-repository.port';
import {
  computeRdaReadiness,
  type RdaReadiness,
} from '../../domain/rda-readiness';

export const RDA_ENTRY_NOT_FOUND_MESSAGE =
  'Evolución no encontrada en esta clínica';

/**
 * DX-212: ¿la atención de esta evolución tiene los datos del RDA? Solo lee:
 * no genera ni envía nada. Una evolución de otra clínica da el mismo 404 que
 * una inexistente (RLS).
 */
@Injectable()
export class GetRdaReadinessUseCase {
  constructor(
    @Inject(CLINICAL_ENTRY_REPOSITORY)
    private readonly repo: ClinicalEntryRepository,
  ) {}

  async execute(entryId: string): Promise<RdaReadiness> {
    const facts = await this.repo.loadRdaFacts(entryId);
    if (!facts) throw new NotFoundException(RDA_ENTRY_NOT_FOUND_MESSAGE);
    return computeRdaReadiness(facts);
  }
}
