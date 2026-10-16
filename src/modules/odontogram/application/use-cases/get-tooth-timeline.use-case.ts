import { Inject, Injectable } from '@nestjs/common';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import {
  attachVoids,
  ToothRecordVoid,
  ToothRecordWithVoid,
} from '../../domain/record-projection';

/** Una entrada del historial: el registro, quién lo hizo y su anulación si la tiene. */
export interface ToothTimelineEntry extends Omit<ToothRecordWithVoid, 'void'> {
  performedByName: string | null;
  void: (ToothRecordVoid & { performedByName: string | null }) | null;
}

@Injectable()
export class GetToothTimelineUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
  ) {}

  /**
   * Ordering (recordedAt DESC — most recent first) is the repository's
   * responsibility; this use case keeps it. DX-120: voided records stay in
   * the history, marked with their void (reason, author, date), and the void
   * rows are not listed on their own.
   */
  async execute(
    patientId: string,
    toothNumber: string,
  ): Promise<ToothTimelineEntry[]> {
    const records = attachVoids(
      await this.repo.listByTooth(patientId, toothNumber),
    );
    const authorIds = new Set<string>();
    for (const r of records) {
      if (r.performedById) authorIds.add(r.performedById);
      if (r.void?.performedById) authorIds.add(r.void.performedById);
    }
    const names =
      authorIds.size > 0
        ? await this.repo.memberNames([...authorIds])
        : new Map<string, string>();
    const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    return records.map((r) => ({
      ...r,
      performedByName: nameOf(r.performedById),
      void: r.void
        ? { ...r.void, performedByName: nameOf(r.void.performedById) }
        : null,
    }));
  }
}
