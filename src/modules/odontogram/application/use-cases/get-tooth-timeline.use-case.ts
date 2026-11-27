import { Inject, Injectable } from '@nestjs/common';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import {
  ODONTOGRAM_CLOCK,
  resolveClinicDay,
  type OdontogramClock,
} from '../odontogram-clock';
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
    @Inject(ODONTOGRAM_CLOCK)
    private readonly now: OdontogramClock,
  ) {}

  /**
   * Ordering (recordedAt DESC — most recent first) is the repository's
   * responsibility; this use case keeps it. DX-120: voided records stay in
   * the history, marked with their void (reason, author, date), and the void
   * rows are not listed on their own.
   *
   * DX-132: con `asOf` (YYYY-MM-DD) el corte es el MISMO que el de la carta a
   * esa fecha (`resolveClinicDay`): el fin del día civil en la zona de la sede
   * de la petición (X-Location-Id; sin ella, la principal), no el del
   * navegador ni UTC. Solo cuenta lo registrado antes del corte, anulaciones
   * incluidas: lo anulado después sale sin anular, como en esa carta. 400 si la
   * fecha no existe o es futura.
   */
  async execute(
    patientId: string,
    toothNumber: string,
    asOf?: string,
  ): Promise<ToothTimelineEntry[]> {
    const cutoff =
      asOf === undefined
        ? undefined
        : resolveClinicDay(asOf, this.now(), await this.repo.clinicTimeZone())
            .cutoff;
    const listed = await this.repo.listByTooth(patientId, toothNumber);
    const records = attachVoids(
      cutoff
        ? listed.filter((r) => r.recordedAt.getTime() < cutoff.getTime())
        : listed,
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
