import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Payer } from '../../../payers/domain/entities/payer.entity';
import {
  PAYER_REPOSITORY,
  type PayerRepository,
} from '../../../payers/domain/ports/payer-repository.port';
import type { PayerType } from '@prisma/client';
import {
  COVERAGE_NOT_FOUND_MESSAGE,
  COVERAGE_PAYER_NOT_FOUND_MESSAGE,
  COVERAGE_PRIMARY_REQUIRED_MESSAGE,
  COVERAGE_VERIFY_INTERNAL_MESSAGE,
  COVERAGE_VERIFY_NO_NUMBER_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
  PAYER_INACTIVE_MESSAGE,
  coverageStatus,
  normalizeCoverageText,
  validateCoverageDates,
  type CoverageStatus,
} from '../../domain/coverage-rules';
import type { PatientCoverage } from '../../domain/entities/patient-coverage.entity';
import {
  memberNumberChanged,
  memberNumberError,
  normalizeMemberNumber,
  requiresMemberNumber,
} from '../../domain/member-number-rules';
import {
  PATIENT_COVERAGE_REPOSITORY,
  type PatientCoverageRepository,
} from '../../domain/ports/patient-coverage-repository.port';

export const COVERAGES_CLOCK = Symbol('COVERAGES_CLOCK');

/** Lo mismo que `PAYER_NOT_FOUND_MESSAGE` del catálogo, aquí como 400. */
export { COVERAGE_PAYER_NOT_FOUND_MESSAGE };

export interface PatientCoverageView extends PatientCoverage {
  status: CoverageStatus;
}

export interface CreatePatientCoverageInput {
  payerId: string;
  planName?: string | null;
  memberNumber?: string | null;
  policyHolderName?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export type UpdatePatientCoverageInput = Partial<CreatePatientCoverageInput>;

const withStatus = (
  c: PatientCoverage,
  today: string,
): PatientCoverageView => ({
  ...c,
  status: coverageStatus(c, today),
});

async function assertPatient(
  repo: PatientCoverageRepository,
  patientId: string,
): Promise<void> {
  if (!(await repo.patientExists(patientId))) {
    throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  }
}

async function loadCoverage(
  repo: PatientCoverageRepository,
  patientId: string,
  coverageId: string,
): Promise<PatientCoverage> {
  await assertPatient(repo, patientId);
  const found = await repo.findById(patientId, coverageId);
  if (!found) throw new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE);
  return found;
}

/** Pagador vivo de ESTA clínica (RLS) o 400; `requireActive` en alta y cambio. */
async function resolvePayer(
  payers: PayerRepository,
  payerId: string,
  requireActive: boolean,
): Promise<Payer> {
  const payer = await payers.findById(payerId);
  if (!payer) throw new BadRequestException(COVERAGE_PAYER_NOT_FOUND_MESSAGE);
  if (requireActive && !payer.active) {
    throw new BadRequestException(PAYER_INACTIVE_MESSAGE);
  }
  return payer;
}

function assertDates(from: string | null, to: string | null): void {
  const error = validateCoverageDates(from, to);
  if (error) throw new BadRequestException(error);
}

/** SEC-049: nº obligatorio y con formato si el pagador es externo (400). */
function assertMemberNumber(type: PayerType, value: string | null): void {
  const error = memberNumberError(type, value);
  if (error) throw new BadRequestException(error);
}

/** Coberturas vivas del paciente (principal primero) con su estado a hoy. */
@Injectable()
export class ListPatientCoveragesUseCase {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
    @Inject(COVERAGES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(patientId: string): Promise<PatientCoverageView[]> {
    await assertPatient(this.repo, patientId);
    const [rows, today] = await Promise.all([
      this.repo.listByPatient(patientId),
      this.repo.clinicToday(this.clock()),
    ]);
    return rows.map((c) => withStatus(c, today));
  }
}

/**
 * Alta de una cobertura: pagador vivo y activo de la clínica, vigencia válida,
 * nº de afiliado obligatorio con un pagador externo (SEC-049) y hasta 5 por
 * paciente. Queda declarada por quien la crea y sin verificar. La primera viva es principal aunque no se pida;
 * `isPrimary: true` en otra desmarca la anterior (una transacción).
 */
@Injectable()
export class CreatePatientCoverageUseCase {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(COVERAGES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    input: CreatePatientCoverageInput,
    createdById: string,
  ): Promise<PatientCoverageView> {
    await assertPatient(this.repo, patientId);
    const validFrom = input.validFrom ?? null;
    const validTo = input.validTo ?? null;
    assertDates(validFrom, validTo);
    const payer = await resolvePayer(this.payers, input.payerId, true);
    const memberNumber = normalizeMemberNumber(input.memberNumber);
    assertMemberNumber(payer.type, memberNumber);

    const created = await this.repo.create({
      patientId,
      payerId: input.payerId,
      planName: normalizeCoverageText(input.planName),
      memberNumber,
      policyHolderName: normalizeCoverageText(input.policyHolderName),
      validFrom,
      validTo,
      // El repositorio decide con el candado tomado: tope (400), primera
      // cobertura (principal) y desmarcar la anterior, en una transacción.
      isPrimary: input.isPrimary === true,
      notes: normalizeCoverageText(input.notes),
      createdById,
    });
    return withStatus(created, await this.repo.clinicToday(this.clock()));
  }
}

/**
 * Edita una cobertura. Cambiar de pagador exige uno activo; con el mismo, un
 * pagador ya desactivado no estorba. La vigencia se valida sobre el resultado
 * (lo enviado sobre lo guardado). `isPrimary: true` la hace principal;
 * `false` sobre la principal se rechaza: hay que marcar otra.
 *
 * SEC-049: si cambia el pagador o el nº de afiliado, el resultado debe cumplir
 * el nº obligatorio del pagador (400), y el repositorio borra la verificación.
 * Una cobertura anterior sin nº se sigue editando en lo demás sin pedirlo.
 */
@Injectable()
export class UpdatePatientCoverageUseCase {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
    @Inject(PAYER_REPOSITORY) private readonly payers: PayerRepository,
    @Inject(COVERAGES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    coverageId: string,
    input: UpdatePatientCoverageInput,
    updatedById: string,
  ): Promise<PatientCoverageView> {
    const current = await loadCoverage(this.repo, patientId, coverageId);

    const nextFrom =
      input.validFrom === undefined ? current.validFrom : input.validFrom;
    const nextTo =
      input.validTo === undefined ? current.validTo : input.validTo;
    assertDates(nextFrom, nextTo);

    const payer =
      input.payerId === undefined
        ? current.payer
        : await resolvePayer(
            this.payers,
            input.payerId,
            input.payerId !== current.payer.id,
          );
    const memberNumber =
      input.memberNumber === undefined
        ? undefined
        : normalizeMemberNumber(input.memberNumber);
    if (
      payer.id !== current.payer.id ||
      (memberNumber !== undefined &&
        memberNumberChanged(current.memberNumber, memberNumber))
    ) {
      assertMemberNumber(
        payer.type,
        memberNumber === undefined ? current.memberNumber : memberNumber,
      );
    }
    if (input.isPrimary === false && current.isPrimary) {
      throw new BadRequestException(COVERAGE_PRIMARY_REQUIRED_MESSAGE);
    }

    await this.repo.update(coverageId, {
      payerId: input.payerId,
      planName:
        input.planName === undefined
          ? undefined
          : normalizeCoverageText(input.planName),
      memberNumber,
      policyHolderName:
        input.policyHolderName === undefined
          ? undefined
          : normalizeCoverageText(input.policyHolderName),
      validFrom: input.validFrom,
      validTo: input.validTo,
      notes:
        input.notes === undefined
          ? undefined
          : normalizeCoverageText(input.notes),
      isPrimary:
        input.isPrimary === true && !current.isPrimary ? true : undefined,
      updatedById,
    });
    const saved = await this.repo.findById(patientId, coverageId);
    if (!saved) throw new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE);
    return withStatus(saved, await this.repo.clinicToday(this.clock()));
  }
}

/**
 * SEC-049: un ADMIN verifica la cobertura de un pagador externo (comprobó el
 * nº de afiliado con el carné o el pagador). Con eso, cualquier rol puede
 * asignar el convenio de ese pagador con ella. `checkedMemberNumber` es el nº
 * que el ADMIN tenía delante: si ya no es el guardado, 409 y nada cambia.
 * Volver a verificar actualiza quién y cuándo.
 */
@Injectable()
export class VerifyPatientCoverageUseCase {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
    @Inject(COVERAGES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    coverageId: string,
    checkedMemberNumber: string,
    verifiedById: string,
  ): Promise<PatientCoverageView> {
    const current = await loadCoverage(this.repo, patientId, coverageId);
    if (!requiresMemberNumber(current.payer.type)) {
      throw new BadRequestException(COVERAGE_VERIFY_INTERNAL_MESSAGE);
    }
    if (current.memberNumber === null) {
      throw new BadRequestException(COVERAGE_VERIFY_NO_NUMBER_MESSAGE);
    }
    const saved = await this.repo.verify(coverageId, {
      checkedMemberNumber,
      verifiedById,
    });
    if (!saved) throw new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE);
    return withStatus(saved, await this.repo.clinicToday(this.clock()));
  }
}

/**
 * Retira una cobertura (en blando). Si era la principal y quedan vivas, la
 * más antigua pasa a principal en la misma transacción: hay principal si y
 * solo si hay alguna viva.
 */
@Injectable()
export class DeletePatientCoverageUseCase {
  constructor(
    @Inject(PATIENT_COVERAGE_REPOSITORY)
    private readonly repo: PatientCoverageRepository,
  ) {}

  async execute(
    patientId: string,
    coverageId: string,
    updatedById: string,
  ): Promise<void> {
    await loadCoverage(this.repo, patientId, coverageId);
    if (!(await this.repo.softDelete(coverageId, updatedById))) {
      throw new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE);
    }
  }
}
