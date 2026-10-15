import {
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
  ): Promise<PublicConfirmationView> {
    const { confirmation, appointment } = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const now = new Date();
    const status = confirmationState(confirmation, appointment, now);
    if (status === 'RESPONDED') throw new ConflictException(ALREADY_RESPONDED);
    if (status === 'EXPIRED' || !appointment) throw new GoneException(EXPIRED);

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
    });
    if (outcome === 'ALREADY_USED')
      throw new ConflictException(ALREADY_RESPONDED);
    if (outcome === 'STALE') throw new GoneException(EXPIRED);

    const clinic = await this.repo.findClinicBranding();
    return toPublicConfirmationView(
      'RESPONDED',
      { ...confirmation, respondedAt: now, response },
      appointment,
      clinic,
    );
  }
}
