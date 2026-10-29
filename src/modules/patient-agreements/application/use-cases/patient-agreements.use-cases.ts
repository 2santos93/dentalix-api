import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  AGREEMENT_NOT_FOUND_MESSAGE,
  validateAgreementDates,
} from '../../../agreements/domain/agreement-rules';
import {
  AGREEMENT_REPOSITORY,
  type AgreementRepository,
} from '../../../agreements/domain/ports/agreement-repository.port';
import {
  COVERAGE_NOT_FOUND_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
  coverageStatus,
  normalizeCoverageText,
} from '../../../patient-coverages/domain/coverage-rules';
import {
  PATIENT_COVERAGE_REPOSITORY,
  type PatientCoverageRepository,
} from '../../../patient-coverages/domain/ports/patient-coverage-repository.port';
import type { PatientAgreement } from '../../domain/entities/patient-agreement.entity';
import {
  COVERAGE_NOT_LIVE_MESSAGE,
  COVERAGE_PAYER_MISMATCH_MESSAGE,
  COVERAGE_SELF_DECLARED_MESSAGE,
  INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE,
  PATIENT_AGREEMENT_NOT_FOUND_MESSAGE,
  coverageRequiredMessage,
  coverageTrustedFor,
  isExternalPayer,
  patientAgreementStatus,
  type PatientAgreementStatus,
} from '../../domain/patient-agreement-rules';
import {
  PATIENT_AGREEMENT_REPOSITORY,
  type AgreementActor,
  type PatientAgreementRepository,
} from '../../domain/ports/patient-agreement-repository.port';

export const PATIENT_AGREEMENTS_CLOCK = Symbol('PATIENT_AGREEMENTS_CLOCK');

export interface PatientAgreementView extends PatientAgreement {
  status: PatientAgreementStatus;
}

export interface PatientAgreementOutput {
  current: PatientAgreementView | null;
  history: PatientAgreementView[];
}

export interface AssignAgreementInput {
  agreementId: string;
  coverageId?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  notes?: string | null;
}

export type { AgreementActor };

const withStatus = (
  a: PatientAgreement,
  today: string,
): PatientAgreementView => ({
  ...a,
  status: patientAgreementStatus(a, today),
});

async function assertPatient(
  repo: PatientAgreementRepository,
  patientId: string,
): Promise<void> {
  if (!(await repo.patientExists(patientId))) {
    throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  }
}

/**
 * Convenio vigente del paciente y, con `includeHistory`, las asignaciones
 * retiradas (la más reciente primero). El estado va calculado a hoy.
 */
@Injectable()
export class GetPatientAgreementUseCase {
  constructor(
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly repo: PatientAgreementRepository,
    @Inject(PATIENT_AGREEMENTS_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    includeHistory: boolean,
  ): Promise<PatientAgreementOutput> {
    await assertPatient(this.repo, patientId);
    const [current, history, today] = await Promise.all([
      this.repo.current(patientId),
      includeHistory ? this.repo.history(patientId) : Promise.resolve([]),
      this.repo.clinicToday(this.clock()),
    ]);
    return {
      current: current ? withStatus(current, today) : null,
      history: history.map((h) => withStatus(h, today)),
    };
  }
}

/**
 * Asigna un convenio al paciente SUSTITUYENDO el vigente (queda en el
 * historial). El convenio debe existir sin retirar; uno desactivado se acepta y
 * la asignación sale con estado `INACTIVE`.
 *
 * Elegibilidad (SEC-047): el precio de convenio no cuenta como descuento, así
 * que asignarlo no puede ser una vía libre para saltarse el tope por rol.
 * - Convenio de un pagador externo: la cobertura es OBLIGATORIA y debe ser del
 *   paciente, del mismo pagador y estar vigente hoy (400 si no), para
 *   cualquier rol, ADMIN incluido.
 * - Convenio interno (pagador `OTHER`: cortesía, empleados…): ADMIN, con la
 *   cobertura opcional (si viene, se valida igual). Otro rol solo con una
 *   cobertura MIGRADA del texto libre de aseguradora anterior a DX-153, del
 *   paciente y de ese pagador (vigente: si no, 400); sin ella, 403 sin decir
 *   nada más de la cobertura.
 * - SEC-049: quien no es ADMIN no puede usar una cobertura cuyo pagador o nº
 *   de afiliado registró él mismo, salvo que un ADMIN la haya verificado (403
 *   que dice qué falta). Va después de comprobar que la cobertura es del
 *   paciente, así una de otra clínica sigue siendo «no encontrada».
 */
@Injectable()
export class AssignPatientAgreementUseCase {
  constructor(
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly repo: PatientAgreementRepository,
    @Inject(AGREEMENT_REPOSITORY)
    private readonly agreements: AgreementRepository,
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly coverages: PatientCoverageRepository,
    @Inject(PATIENT_AGREEMENTS_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    input: AssignAgreementInput,
    actor: AgreementActor,
  ): Promise<PatientAgreementView> {
    await assertPatient(this.repo, patientId);
    const validFrom = input.validFrom ?? null;
    const validTo = input.validTo ?? null;
    const dateError = validateAgreementDates(validFrom, validTo);
    if (dateError) throw new BadRequestException(dateError);

    const agreement = await this.agreements.findLiveById(input.agreementId);
    if (!agreement) throw new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE);

    const external = isExternalPayer(agreement.payer.type);
    const coverageId = input.coverageId ?? null;
    if (!external && actor.role !== ClinicRole.ADMIN) {
      const migrated =
        coverageId === null
          ? null
          : await this.coverages.findById(patientId, coverageId);
      if (
        !migrated?.migratedFromInsurerEps ||
        migrated.payer.id !== agreement.payer.id
      ) {
        throw new ForbiddenException(INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE);
      }
    }
    if (external && coverageId === null) {
      throw new BadRequestException(
        coverageRequiredMessage(agreement.payer.name),
      );
    }

    // Antes de escribir: si la zona horaria falla, que no haya un 500 tras un
    // alta ya confirmada.
    const today = await this.repo.clinicToday(this.clock());
    if (coverageId !== null) {
      const coverage = await this.coverages.findById(patientId, coverageId);
      if (!coverage) throw new BadRequestException(COVERAGE_NOT_FOUND_MESSAGE);
      if (coverage.payer.id !== agreement.payer.id) {
        throw new BadRequestException(COVERAGE_PAYER_MISMATCH_MESSAGE);
      }
      if (coverageStatus(coverage, today) !== 'ACTIVE') {
        throw new BadRequestException(COVERAGE_NOT_LIVE_MESSAGE);
      }
      if (!coverageTrustedFor(coverage, actor)) {
        throw new ForbiddenException(COVERAGE_SELF_DECLARED_MESSAGE);
      }
    }
    // El repositorio vuelve a comprobar convenio y cobertura dentro de la
    // transacción, con el candado del paciente tomado.
    const saved = await this.repo.replace(
      patientId,
      {
        agreementId: input.agreementId,
        coverageId,
        validFrom,
        validTo,
        notes: normalizeCoverageText(input.notes),
      },
      actor,
    );
    return withStatus(saved, today);
  }
}

/** Retira el convenio vigente del paciente (queda en el historial). */
@Injectable()
export class RemovePatientAgreementUseCase {
  constructor(
    @Inject(PATIENT_AGREEMENT_REPOSITORY)
    private readonly repo: PatientAgreementRepository,
  ) {}

  async execute(patientId: string, by: string): Promise<void> {
    await assertPatient(this.repo, patientId);
    if (!(await this.repo.retireCurrent(patientId, by))) {
      throw new NotFoundException(PATIENT_AGREEMENT_NOT_FOUND_MESSAGE);
    }
  }
}
