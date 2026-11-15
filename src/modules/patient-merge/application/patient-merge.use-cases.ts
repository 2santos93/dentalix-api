import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  DUPLICATES_DEFAULT_PAGE_SIZE,
  DUPLICATES_MAX_PAGE_SIZE,
  orderedPair,
} from '../domain/duplicate-reasons';
import {
  MERGE_PATIENT_NOT_FOUND_MESSAGE,
  MERGE_SAME_PATIENT_MESSAGE,
} from '../domain/merge-errors';
import type { MergeFieldChoices } from '../domain/merge-fields';
import {
  PATIENT_MERGE_REPOSITORY,
  type DuplicatePair,
  type MergePreview,
  type MergeResult,
  type PatientMergeRepository,
} from '../domain/patient-merge-repository.port';

/** Hora del sistema; inyectable para los tests. */
export type MergeClock = () => Date;
export const PATIENT_MERGE_CLOCK = Symbol('PATIENT_MERGE_CLOCK');

export interface DuplicatePage {
  items: DuplicatePair[];
  total: number;
  page: number;
  pageSize: number;
}

function distinct(a: string, b: string): [string, string] {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) throw new BadRequestException(MERGE_SAME_PATIENT_MESSAGE);
  return [x, y];
}

/** «Posibles duplicados» de la clínica (y de una sede, si se filtra). */
@Injectable()
export class ListDuplicatePatientsUseCase {
  constructor(
    @Inject(PATIENT_MERGE_REPOSITORY)
    private readonly repo: PatientMergeRepository,
  ) {}

  async execute(input: {
    locationId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<DuplicatePage> {
    const page = input.page ?? 1;
    const pageSize = Math.min(
      input.pageSize ?? DUPLICATES_DEFAULT_PAGE_SIZE,
      DUPLICATES_MAX_PAGE_SIZE,
    );
    const { items, total } = await this.repo.listDuplicates({
      locationId: input.locationId,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}

/** «No es duplicado»: la pareja deja de salir. Idempotente. */
@Injectable()
export class DismissDuplicatePairUseCase {
  constructor(
    @Inject(PATIENT_MERGE_REPOSITORY)
    private readonly repo: PatientMergeRepository,
  ) {}

  async execute(
    patientIds: [string, string],
    ctx: AuditRequestContext,
  ): Promise<void> {
    const [a, b] = distinct(...patientIds);
    const ok = await this.repo.dismiss(orderedPair(a, b), ctx);
    if (!ok) throw new NotFoundException(MERGE_PATIENT_NOT_FOUND_MESSAGE);
  }
}

/** Los dos pacientes campo a campo, lo que se moverá y lo que lo impide. */
@Injectable()
export class PreviewPatientMergeUseCase {
  constructor(
    @Inject(PATIENT_MERGE_REPOSITORY)
    private readonly repo: PatientMergeRepository,
    @Inject(PATIENT_MERGE_CLOCK) private readonly now: MergeClock,
  ) {}

  async execute(
    keptId: string,
    absorbedId: string,
    ctx: AuditRequestContext,
  ): Promise<MergePreview> {
    const [kept, absorbed] = distinct(keptId, absorbedId);
    const preview = await this.repo.preview(kept, absorbed, this.now(), ctx);
    if (!preview) throw new NotFoundException(MERGE_PATIENT_NOT_FOUND_MESSAGE);
    return preview;
  }
}

/**
 * Fusiona `absorbedId` en `keptId` (solo ADMIN, lo exige el controlador):
 * todo lo del absorbido pasa al conservado y el absorbido queda retirado con
 * `mergedIntoId`. Sin deshacer (fuera de alcance de DX-266).
 */
@Injectable()
export class MergePatientsUseCase {
  constructor(
    @Inject(PATIENT_MERGE_REPOSITORY)
    private readonly repo: PatientMergeRepository,
    @Inject(PATIENT_MERGE_CLOCK) private readonly now: MergeClock,
  ) {}

  async execute(
    input: { keptId: string; absorbedId: string; choices: MergeFieldChoices },
    ctx: AuditRequestContext,
  ): Promise<MergeResult> {
    const [keptId, absorbedId] = distinct(input.keptId, input.absorbedId);
    return this.repo.merge(
      { keptId, absorbedId, choices: input.choices },
      this.now(),
      ctx,
    );
  }
}
