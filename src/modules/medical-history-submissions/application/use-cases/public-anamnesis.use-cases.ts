import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import {
  NO_POLICY_MESSAGE,
  OUTDATED_POLICY_MESSAGE,
} from '../../../data-consents/infrastructure/record-consents-in-tx';
import {
  anamnesisQuestionnaire,
  type AnamnesisAnswers,
  type QuestionnaireDefinition,
} from '../../domain/anamnesis-questionnaire';
import { answersValidationErrors } from '../../domain/answers-to-version';
import {
  hashAnamnesisToken,
  isWellFormedAnamnesisToken,
} from '../../domain/anamnesis-token';
import {
  MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
  OutdatedPolicyError,
  type MedicalHistorySubmissionRepository,
  type PublicSubmissionView,
} from '../../domain/ports/medical-history-submission-repository.port';
import { isOpenForPatient } from '../../domain/submission-status';
import { ANAMNESIS_CLOCK, type AnamnesisClock } from '../anamnesis-clock';

export const ANAMNESIS_LINK_NOT_FOUND_MESSAGE =
  'Este enlace no es válido, contacte con su clínica.';
export const ANAMNESIS_LINK_GONE_MESSAGE =
  'Este enlace ya no es válido, contacte con su clínica.';
export const ANAMNESIS_CONSENT_REQUIRED_MESSAGE =
  'Para enviar el cuestionario debe autorizar el tratamiento de sus datos de salud.';
export const ANAMNESIS_DECLARATION_REQUIRED_MESSAGE =
  'Confirme que la información que da es verdadera para poder enviarla.';

export interface PublicAnamnesis {
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  /** Solo el nombre de pila: ni apellidos, ni documento, ni datos previos. */
  patientFirstName: string | null;
  expiresAt: Date;
  questionnaire: QuestionnaireDefinition;
  consent: {
    /** El paciente no tiene vigente SENSITIVE_HEALTH: se pide antes. */
    required: boolean;
    /** Texto versionado de la clínica (DX-037), si hay que pedirla. */
    policy: {
      id: string;
      version: number;
      sensitiveHealthText: string;
      policyText: string;
    } | null;
  };
}

export interface SubmitPublicAnamnesisInput {
  answers: AnamnesisAnswers;
  declarationAccepted: boolean;
  consent?: { policyVersionId: string; granted: boolean };
}

/**
 * Búsqueda común de GET y POST públicos. El tenant sale SOLO del host: sin
 * clínica en contexto o con un token que no puede ser nuestro, 404 sin tocar
 * la BD. La RLS hace que un token de otra clínica no exista (mismo 404).
 * Usado, anulado, caducado o de un paciente retirado: 410.
 */
async function findOpen(
  tenantContext: TenantContextService,
  repo: MedicalHistorySubmissionRepository,
  clock: AnamnesisClock,
  token: string,
): Promise<PublicSubmissionView> {
  if (!tenantContext.getTenantId() || !isWellFormedAnamnesisToken(token)) {
    throw new NotFoundException(ANAMNESIS_LINK_NOT_FOUND_MESSAGE);
  }
  const view = await repo.findByTokenHash(hashAnamnesisToken(token));
  if (!view) throw new NotFoundException(ANAMNESIS_LINK_NOT_FOUND_MESSAGE);
  if (view.patientDeleted || !isOpenForPatient(view.submission, clock())) {
    throw new GoneException(ANAMNESIS_LINK_GONE_MESSAGE);
  }
  return view;
}

/**
 * PÚBLICO (DX-099): el cuestionario y el nombre de pila. Nunca datos de salud
 * anteriores (riesgo A.1): el paciente rellena desde cero y el profesional ve
 * las diferencias al revisar. Leer no cambia nada.
 */
@Injectable()
export class GetPublicAnamnesisUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(token: string): Promise<PublicAnamnesis> {
    const view = await findOpen(
      this.tenantContext,
      this.repo,
      this.clock,
      token,
    );
    const required = !view.sensitiveHealthGranted;
    return {
      clinic: view.clinic,
      patientFirstName: firstNameOnly(view.patientFirstName),
      expiresAt: view.submission.expiresAt,
      questionnaire: anamnesisQuestionnaire(),
      consent: { required, policy: required ? view.policy : null },
    };
  }
}

/**
 * PÚBLICO (DX-099): guarda las respuestas una sola vez. La HC NO cambia: el
 * envío queda «por revisar» hasta que un profesional lo acepta. Si el
 * paciente no tenía la autorización SENSITIVE_HEALTH vigente, la da aquí
 * (canal PATIENT_LINK, con la versión de la política que se le mostró), en la
 * misma transacción que el envío.
 */
@Injectable()
export class SubmitPublicAnamnesisUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly repo: MedicalHistorySubmissionRepository,
    @Inject(ANAMNESIS_CLOCK) private readonly clock: AnamnesisClock,
  ) {}

  async execute(
    token: string,
    input: SubmitPublicAnamnesisInput,
    evidence: {
      ipAddress: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
  ): Promise<{ submittedAt: Date }> {
    const view = await findOpen(
      this.tenantContext,
      this.repo,
      this.clock,
      token,
    );
    if (!input.declarationAccepted) {
      throw new BadRequestException(ANAMNESIS_DECLARATION_REQUIRED_MESSAGE);
    }
    const errors = answersValidationErrors(input.answers);
    if (errors.length > 0) throw new BadRequestException(errors);

    let consentPolicyVersionId: string | null = null;
    if (!view.sensitiveHealthGranted) {
      if (!view.policy) throw new ConflictException(NO_POLICY_MESSAGE);
      if (!input.consent?.granted) {
        throw new UnprocessableEntityException(
          ANAMNESIS_CONSENT_REQUIRED_MESSAGE,
        );
      }
      consentPolicyVersionId = input.consent.policyVersionId;
    }

    const now = this.clock();
    let outcome: Awaited<
      ReturnType<MedicalHistorySubmissionRepository['submit']>
    >;
    try {
      outcome = await this.repo.submit({
        id: view.submission.id,
        patientId: view.submission.patientId,
        answers: input.answers,
        now,
        consentPolicyVersionId,
        evidence: {
          ipAddress: evidence.ipAddress,
          userAgent: evidence.userAgent,
        },
        requestId: evidence.requestId,
      });
    } catch (err) {
      if (err instanceof OutdatedPolicyError) {
        throw new ConflictException(OUTDATED_POLICY_MESSAGE);
      }
      throw err;
    }
    // Otro envío con el mismo token ganó la carrera: no hay un segundo envío.
    if (outcome === 'GONE')
      throw new GoneException(ANAMNESIS_LINK_GONE_MESSAGE);
    return { submittedAt: now };
  }
}
