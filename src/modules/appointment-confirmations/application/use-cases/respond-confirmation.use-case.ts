import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from '../../domain/ports/appointment-confirmation-repository.port';
import type { AppointmentConfirmationRepository } from '../../domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { confirmationState } from '../confirmation-token';
import { findConfirmationByToken } from '../find-confirmation-by-token';
import {
  ACTION_TO_RESPONSE,
  ConfirmationAction,
  PublicConfirmationView,
  toPublicConfirmationView,
} from '../public-confirmation-view';
import {
  LINK_POLICY_MESSAGES,
  isLateLinkCancellation,
  linkResponseBlock,
} from '../../domain/link-cancellation-policy';

/** DX-291: lo que la página manda además de la acción. */
export interface RespondPolicyInput {
  /** El paciente marcó «Acepto la política» (cancelar tarde lo exige). */
  acknowledgePolicy?: boolean;
  /** Versión de la política que mostró la página (`null` = ninguna). */
  policyVersionId?: string | null;
}

const ALREADY_RESPONDED = 'Este enlace ya se usó para responder';
const EXPIRED = 'Este enlace ya no es válido';

/**
 * Caso de uso PÚBLICO (sin auth): el segundo clic del paciente.
 * - confirm  → la cita pasa a CONFIRMED.
 * - cancel   → CANCELLED.
 * - call_me  → sigue SCHEDULED y queda marcada "pide llamada" para recepción.
 *
 * Un solo uso: tras responder, el enlace solo muestra la respuesta (409 si se
 * intenta otra vez). 410 si caducó o la cita cambió desde que se emitió.
 */
@Injectable()
export class RespondConfirmationUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly repo: AppointmentConfirmationRepository,
  ) {}

  async execute(
    token: string,
    action: ConfirmationAction,
    policyInput: RespondPolicyInput = {},
  ): Promise<PublicConfirmationView> {
    const { confirmation, appointment, policy } = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const now = new Date();
    const status = confirmationState(confirmation, appointment, now);
    if (status === 'RESPONDED') throw new ConflictException(ALREADY_RESPONDED);
    if (status === 'EXPIRED' || !appointment) throw new GoneException(EXPIRED);

    const acknowledgePolicy = policyInput.acknowledgePolicy === true;
    // Comprobación temprana con la foto leída; el repositorio la repite con
    // la cita bloqueada y la hora de la respuesta.
    this.assertPolicy(
      linkResponseBlock({
        cancelling: action === 'cancel',
        late: isLateLinkCancellation(appointment.start, now, policy),
        acknowledgePolicy,
        shownPolicyVersionId: policyInput.policyVersionId,
        currentPolicyId: policy?.id ?? null,
      }),
      policy?.noticeHours ?? 0,
    );

    const response = ACTION_TO_RESPONSE[action];
    // El repo vuelve a comprobar todo en la escritura (un solo uso y "la cita
    // sigue como al emitir"), así que dos clics simultáneos no pueden
    // responder dos veces aunque ambos hayan pasado la comprobación de arriba.
    const outcome = await this.repo.respond({
      confirmationId: confirmation.id,
      appointmentId: appointment.id,
      response,
      now,
      expectedStart: confirmation.appointmentStart,
      expectedStatus: confirmation.appointmentStatus,
      acknowledgePolicy,
      shownPolicyVersionId: policyInput.policyVersionId,
    });
    if (outcome === 'ALREADY_USED')
      throw new ConflictException(ALREADY_RESPONDED);
    if (outcome === 'STALE') throw new GoneException(EXPIRED);
    if (outcome === 'POLICY_CHANGED' || outcome === 'ACK_REQUIRED') {
      // La política cambió entre la lectura y la escritura: se relee.
      const fresh = await findConfirmationByToken(
        this.tenantContext,
        this.repo,
        token,
      );
      this.assertPolicy(outcome, fresh.policy?.noticeHours ?? 0);
    }

    const clinic = await this.repo.findClinicBranding();
    return toPublicConfirmationView(
      'RESPONDED',
      { ...confirmation, respondedAt: now, response },
      appointment,
      clinic,
    );
  }

  private assertPolicy(
    block: 'POLICY_CHANGED' | 'ACK_REQUIRED' | null,
    noticeHours: number,
  ): void {
    if (block === 'POLICY_CHANGED')
      throw new ConflictException(LINK_POLICY_MESSAGES.policyChanged);
    if (block === 'ACK_REQUIRED')
      throw new BadRequestException(
        LINK_POLICY_MESSAGES.acknowledgeRequired(noticeHours),
      );
  }
}
