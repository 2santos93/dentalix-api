import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CANCELLATION_POLICY_MESSAGES,
  policyInputError,
  type CancellationPolicyInput,
  type CancellationPolicyVersion,
} from '../../domain/cancellation-policy';
import {
  CANCELLATION_POLICY_REPOSITORY,
  type CancellationPolicyRepository,
} from '../../domain/ports/cancellation-policy-repository.port';

/** La política de una sede: la vigente y el historial (más nueva primero). */
export interface CancellationPolicyView {
  locationId: string;
  /** La versión de mayor número; `null` si la sede nunca la configuró. */
  current: CancellationPolicyVersion | null;
  versions: CancellationPolicyVersion[];
}

/** Lee la política de una sede de la clínica (DX-279). Otra clínica: 404. */
@Injectable()
export class GetCancellationPolicyUseCase {
  constructor(
    @Inject(CANCELLATION_POLICY_REPOSITORY)
    private readonly repo: CancellationPolicyRepository,
  ) {}

  async execute(locationId: string): Promise<CancellationPolicyView> {
    const versions = await this.repo.listVersions(locationId);
    if (versions === null) {
      throw new NotFoundException(
        CANCELLATION_POLICY_MESSAGES.locationNotFound,
      );
    }
    return { locationId, current: versions[0] ?? null, versions };
  }
}

/**
 * Guarda la versión siguiente de la política de la sede (DX-279). La anterior
 * no cambia (la tabla es append-only): es la prueba de lo que se comunicó al
 * paciente. Validación en español antes de escribir; la moneda tiene que estar
 * en el catálogo.
 */
@Injectable()
export class CreateCancellationPolicyVersionUseCase {
  constructor(
    @Inject(CANCELLATION_POLICY_REPOSITORY)
    private readonly repo: CancellationPolicyRepository,
  ) {}

  async execute(
    locationId: string,
    raw: CancellationPolicyInput,
    createdById: string,
  ): Promise<CancellationPolicyVersion> {
    const input: CancellationPolicyInput = {
      noticeHours: raw.noticeHours,
      suggestedFee: raw.suggestedFee ?? null,
      currency: raw.currency ? raw.currency.toUpperCase() : null,
      patientText: (raw.patientText ?? '').trim(),
      receptionCanCharge: raw.receptionCanCharge ?? false,
    };
    const error = policyInputError(input);
    if (error) throw new BadRequestException(error);
    if (
      input.currency !== null &&
      !(await this.repo.currencyExists(input.currency))
    ) {
      throw new BadRequestException(CANCELLATION_POLICY_MESSAGES.currency);
    }
    const created = await this.repo.createVersion(
      locationId,
      input,
      createdById,
    );
    if (!created) {
      throw new NotFoundException(
        CANCELLATION_POLICY_MESSAGES.locationNotFound,
      );
    }
    return created;
  }
}
