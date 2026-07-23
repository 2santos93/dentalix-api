import { Inject, Injectable } from '@nestjs/common';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';

export interface OdontogramToothGroup {
  toothNumber: string;
  records: ToothRecord[];
}

@Injectable()
export class GetOdontogramUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
  ) {}

  /**
   * The odontogram is the PROJECTION of every one of a patient's
   * (non-deleted) `ToothRecord`s, grouped by `toothNumber` — this is what
   * the SVG will render (one entry per tooth that has at least one record).
   * A tooth with no records simply has no group here; the frontend renders
   * it as "healthy"/untouched.
   *
   * Groups are returned ordered by `toothNumber` ascending for a stable,
   * deterministic projection; each group preserves the order returned by
   * the repository (chronological, recordedAt ASC).
   */
  async execute(patientId: string): Promise<OdontogramToothGroup[]> {
    const records = await this.repo.listByPatient(patientId);

    const grouped = new Map<string, ToothRecord[]>();
    for (const record of records) {
      const bucket = grouped.get(record.toothNumber);
      if (bucket) {
        bucket.push(record);
      } else {
        grouped.set(record.toothNumber, [record]);
      }
    }

    return Array.from(grouped.entries())
      .map(([toothNumber, toothRecords]) => ({
        toothNumber,
        records: toothRecords,
      }))
      .sort((a, b) => a.toothNumber.localeCompare(b.toothNumber));
  }
}
