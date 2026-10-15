import { Inject, Injectable } from '@nestjs/common';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from '../../domain/ports/appointment-confirmation-repository.port';
import type { AppointmentConfirmationRepository } from '../../domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { confirmationState } from '../confirmation-token';
import { findConfirmationByToken } from '../find-confirmation-by-token';
import {
  PublicConfirmationView,
  toPublicConfirmationView,
} from '../public-confirmation-view';

/**
 * Caso de uso PÚBLICO (sin auth): lo que ve el paciente al abrir el enlace.
 * SOLO LEE — abrir el enlace no confirma nada, porque los previsualizadores de
 * WhatsApp y los antivirus de correo lo abren solos. La respuesta exige un
 * segundo clic (POST).
 */
@Injectable()
export class GetPublicConfirmationUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly repo: AppointmentConfirmationRepository,
  ) {}

  async execute(token: string): Promise<PublicConfirmationView> {
    const { confirmation, appointment } = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const status = confirmationState(confirmation, appointment, new Date());
    const clinic = await this.repo.findClinicBranding();
    return toPublicConfirmationView(status, confirmation, appointment, clinic);
  }
}
