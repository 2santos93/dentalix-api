import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MedicalHistorySubmissionStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { SafetyFlags } from '../../../medical-history/domain/entities/medical-history.entity';
import {
  MEDICAL_HISTORY_REPOSITORY,
  type MedicalHistoryRepository,
  type MedicalHistoryVersionData,
} from '../../../medical-history/domain/ports/medical-history-repository.port';
import { deriveSafetyFlags } from '../../../medical-history/domain/safety-flags';
import type { AnamnesisAnswers } from '../../domain/anamnesis-questionnaire';
import {
  countAffirmativeAnswers,
  proposeVersionFromAnswers,
} from '../../domain/answers-to-version';
import {
  diffMedicalHistory,
  type HistoryDiff,
} from '../../domain/history-diff';
import {
  MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
  type MedicalHistorySubmissionRepository,
} from '../../domain/ports/medical-history-submission-repository.port';
import { ANAMNESIS_CLOCK, type AnamnesisClock } from '../anamnesis-clock';
import {
  ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE,
  INBOX_LIMIT,
  type SubmissionListItem,
  unwrapReview,
  withEffectiveStatus,
} from './anamnesis-requests.use-cases';

export const ANAMNESIS_ALREADY_REVIEWED_MESSAGE =
  'Esta anamnesis ya se revisó.';
export const ANAMNESIS_NOT_SUBMITTED_MESSAGE =
  'El paciente aún no ha enviado esta anamnesis.';
export const ANAMNESIS_REJECT_REASON_MESSAGE =
  'Escribe el motivo (al menos 3 caracteres).';
export const ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE =
  'Solo un odontólogo o un administrador puede aceptar o rechazar la anamnesis.';

function reviewConflict(status: MedicalHistorySubmissionStatus): string {
  return status === MedicalHistorySubmissionStatus.ACCEPTED ||
    status === MedicalHistorySubmissionStatus.REJECTED
    ? ANAMNESIS_ALREADY_REVIEWED_MESSAGE
    : ANAMNESIS_NOT_SUBMITTED_MESSAGE;
}

export interface SubmissionReview {
  submission: SubmissionListItem;
  questionnaireVersion: string;
  /** Lo que respondió el paciente; `null` si aún no lo envió. */
  answers: AnamnesisAnswers | null;
  affirmativeCount: number;
  /** La versión vigente de la HC (contra la que se compara). */
  currentVersion: { id: string; version: number; createdAt: Date } | null;
  /** Lo que quedaría al aceptar sin ajustes (solo si está por revisar). */
  proposed: MedicalHistoryVersionData | null;
  proposedFlags: { safetyFlags: SafetyFlags; hasCriticalAlert: boolean } | null;
  diff: HistoryDiff | null;
}

/** `GET /medical-history/submissions?status=` — la bandeja por sedes. */
@Injectable()
export class ListAnamnesisInboxUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(
    status: MedicalHistorySubmissionStatus,
  ): Promise<SubmissionListItem[]> {
    const now = this.clock();
    const rows = await this.repo.listInbox(status, INBOX_LIMIT);
    return rows.map((r) => withEffectiveStatus(r, now));
  }
}

/** `GET /medical-history/submissions/summary` — el contador del menú. */
@Injectable()
export class CountAnamnesisInboxUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
  ) {}

  async execute(): Promise<{ submitted: number }> {
    return {
      submitted: await this.repo.countInbox(
        MedicalHistorySubmissionStatus.SUBMITTED,
      ),
    };
  }
}

/**
 * `GET /medical-history/submissions/:id` — vista de revisión: respuestas,
 * versión vigente y diferencias (añadido, quitado, cambiado; los «Sí»
 * primero). La HC no cambia por mirarla.
 */
@Injectable()
export class GetAnamnesisReviewUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    @Inject(MEDICAL_HISTORY_REPOSITORY)
    private readonly histories: MedicalHistoryRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(id: string): Promise<SubmissionReview> {
    const detail = await this.repo.findDetail(id);
    if (!detail) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertLocationAllowed(detail.submission.locationId);
    const { submission } = detail;
    const current = await this.histories.getLatest(submission.patientId);
    const pending =
      submission.status === MedicalHistorySubmissionStatus.SUBMITTED &&
      submission.answers !== null;
    const proposed =
      pending && submission.answers
        ? proposeVersionFromAnswers(submission.answers, current)
        : null;
    return {
      submission: withEffectiveStatus(detail.summary, this.clock()),
      questionnaireVersion: submission.questionnaireVersion,
      answers: submission.answers,
      affirmativeCount: submission.answers
        ? countAffirmativeAnswers(submission.answers)
        : 0,
      currentVersion: current
        ? {
            id: current.id,
            version: current.version,
            createdAt: current.createdAt,
          }
        : null,
      proposed,
      proposedFlags: proposed ? deriveSafetyFlags(proposed) : null,
      diff: proposed ? diffMedicalHistory(current, proposed) : null,
    };
  }
}

/** Solo los campos conocidos (como el guardado del personal). */
function normalizeAdjusted(
  data: MedicalHistoryVersionData,
): MedicalHistoryVersionData {
  return {
    allergies: data.allergies,
    conditions: data.conditions,
    medications: data.medications,
    habits: data.habits,
    dentalHistory: data.dentalHistory,
    surgeries: data.surgeries,
    vitalSigns: data.vitalSigns,
    familyHistory: data.familyHistory,
    notes: data.notes,
    embarazo: data.embarazo,
    semanasEmbarazo: data.semanasEmbarazo,
  };
}

/**
 * `POST /medical-history/submissions/:id/accept` (ADMIN, DENTIST): crea
 * exactamente UNA versión de la HC con origen PATIENT_FORM y autor = quien
 * revisa, con los ajustes del profesional si los manda, y pasa el envío a
 * ACCEPTED en la MISMA transacción. Las banderas se recalculan siempre.
 */
@Injectable()
export class AcceptAnamnesisUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(
    id: string,
    reviewerId: string,
    adjusted?: MedicalHistoryVersionData,
  ): Promise<SubmissionListItem> {
    const detail = await this.repo.findDetail(id);
    if (!detail) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertLocationAllowed(detail.submission.locationId);
    const answers = detail.submission.answers;
    unwrapReview(
      await this.repo.accept({
        id,
        reviewerId,
        build: (current) =>
          adjusted
            ? normalizeAdjusted(adjusted)
            : // `answers` existe siempre en SUBMITTED (CHECK de la BD); el
              // repositorio solo llama aquí si el envío está por revisar.
              proposeVersionFromAnswers(answers as AnamnesisAnswers, current),
      }),
      reviewConflict,
    );
    return this.reload(id);
  }

  private async reload(id: string): Promise<SubmissionListItem> {
    const fresh = await this.repo.findDetail(id);
    if (!fresh) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    return withEffectiveStatus(fresh.summary, this.clock());
  }
}

/** `POST /medical-history/submissions/:id/reject` (ADMIN, DENTIST), con motivo. */
@Injectable()
export class RejectAnamnesisUseCase {
  constructor(
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(
    id: string,
    reviewerId: string,
    reason: string,
  ): Promise<SubmissionListItem> {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      throw new BadRequestException(ANAMNESIS_REJECT_REASON_MESSAGE);
    }
    const detail = await this.repo.findDetail(id);
    if (!detail) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    this.tenantContext.assertLocationAllowed(detail.submission.locationId);
    unwrapReview(
      await this.repo.reject({ id, reviewerId, reason: trimmed }),
      reviewConflict,
    );
    const fresh = await this.repo.findDetail(id);
    if (!fresh) {
      throw new NotFoundException(ANAMNESIS_SUBMISSION_NOT_FOUND_MESSAGE);
    }
    return withEffectiveStatus(fresh.summary, this.clock());
  }
}
