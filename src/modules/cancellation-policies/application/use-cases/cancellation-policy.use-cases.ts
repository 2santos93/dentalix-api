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
import { reminderPolicyVars } from '../../domain/reminder-policy-vars';
import { EmailOutbox } from '../../../notifications/email/application/email-outbox.service';
import type { RenderedEmail } from '../../../notifications/email/domain/email-message';
import { startsAtLabel } from '../../../reminders/domain/starts-at-label';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';

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

/** Datos de ejemplo de la vista previa: nunca los de un paciente real. */
export const PREVIEW_SAMPLE = {
  patientName: 'Ana',
  providerName: 'Dra. Laura Gómez',
  confirmUrl: 'https://ejemplo.dentalix.app/confirmar/vista-previa',
} as const;

/**
 * DX-291: vista previa del recordatorio por email de una sede, con su
 * política VIGENTE en `{politica_cancelacion}` y la marca de la clínica. Los
 * datos del paciente son de ejemplo. No encola ni registra nada.
 */
@Injectable()
export class PreviewReminderEmailUseCase {
  constructor(
    @Inject(CANCELLATION_POLICY_REPOSITORY)
    private readonly repo: CancellationPolicyRepository,
    private readonly email: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(locationId: string, now = new Date()): Promise<RenderedEmail> {
    const tenantId = this.tenantContext.getTenantId();
    const [location, versions] = await Promise.all([
      this.repo.findPreviewLocation(locationId),
      this.repo.listVersions(locationId),
    ]);
    if (!tenantId || !location || versions === null) {
      throw new NotFoundException(
        CANCELLATION_POLICY_MESSAGES.locationNotFound,
      );
    }
    // El formato y el reloj de la sede, como en el envío real (409 si faltan).
    const fmt = requireLocationFormat(location);
    return this.email.preview(tenantId, 'appointment-reminder', {
      patientName: PREVIEW_SAMPLE.patientName,
      guardianName: null,
      startsAtLabel: startsAtLabel(
        new Date(now.getTime() + 24 * 3_600_000),
        location.timeZone,
        fmt,
      ),
      locationName: location.name,
      locationAddress: location.address,
      providerName: PREVIEW_SAMPLE.providerName,
      confirmUrl: PREVIEW_SAMPLE.confirmUrl,
      unsubscribeUrl: null,
      cancellationPolicy: reminderPolicyVars(versions[0] ?? null, fmt),
    });
  }
}
