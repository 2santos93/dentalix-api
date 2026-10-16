import { Inject, Injectable } from '@nestjs/common';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import { activeRecords } from '../../domain/record-projection';
import {
  ODONTOGRAM_CLOCK,
  resolveClinicDay,
  type OdontogramClock,
} from '../odontogram-clock';

export interface OdontogramToothGroup {
  toothNumber: string;
  records: ToothRecord[];
}

@Injectable()
export class GetOdontogramUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
    @Inject(ODONTOGRAM_CLOCK)
    private readonly now: OdontogramClock,
  ) {}

  /**
   * The odontogram is the PROJECTION of a patient's `ToothRecord`s grouped by
   * `toothNumber` — what the chart renders (one entry per tooth with at least
   * one record; a tooth with no group is "healthy"/untouched).
   *
   * DX-120: voided records and the void records themselves are left out
   * (`activeRecords`). With `asOf` (YYYY-MM-DD, the clinic's civil day) only
   * what was recorded up to the end of that day counts — voids included, so a
   * record voided LATER still shows on that day's chart.
   *
   * Groups are ordered by `toothNumber` ascending; each keeps the
   * repository's chronological order (recordedAt ASC).
   */
  async execute(
    patientId: string,
    asOf?: string,
  ): Promise<OdontogramToothGroup[]> {
    const cutoff =
      asOf === undefined
        ? undefined
        : resolveClinicDay(asOf, this.now(), await this.repo.clinicTimeZone())
            .cutoff;
    const records = activeRecords(
      await this.repo.listByPatient(patientId),
      cutoff,
    );

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
