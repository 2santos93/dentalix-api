import { Inject, Injectable } from '@nestjs/common';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';

@Injectable()
export class GetToothTimelineUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
  ) {}

  /**
   * Ordering (recordedAt DESC — most recent first) is the repository's
   * responsibility (see PrismaToothRecordRepository / the in-memory fake in
   * the spec for the same contract) — this use case only forwards the
   * patientId + toothNumber untouched.
   */
  async execute(
    patientId: string,
    toothNumber: string,
  ): Promise<ToothRecord[]> {
    return this.repo.listByTooth(patientId, toothNumber);
  }
}
