import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { EarlierWindow } from '@prisma/client';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from '../../domain/ports/appointment-confirmation-repository.port';
import type { AppointmentConfirmationRepository } from '../../domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { confirmationState } from '../confirmation-token';
import { findConfirmationByToken } from '../find-confirmation-by-token';
import {
  EARLIER_MESSAGES,
  earlierBlock,
  PublicConfirmationView,
  toPublicConfirmationView,
} from '../public-confirmation-view';

const EXPIRED = 'Este enlace ya no es válido';

/**
 * DX-437: desde el enlace de confirmación, el paciente pide que le avisen si
 * se libera un hueco antes (o lo quita). Vale con el enlace PENDING o ya
 * RESPONDIDO (confirmar no lo gasta para esto); caducado o sin efecto, 410.
 * La cita tiene que estar agendada o confirmada, en el futuro y en un día
 * posterior a hoy en la sede (400 en español si no). Queda auditado, origen
 * PUBLIC_LINK, sin token ni URL.
 */
@Injectable()
export class SetWantsEarlierFromLinkUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly repo: AppointmentConfirmationRepository,
  ) {}

  async execute(
    token: string,
    input: { wantsEarlier: boolean; preferredWindow?: EarlierWindow },
    request: AuditRequestMeta | null = null,
  ): Promise<PublicConfirmationView> {
    const { confirmation, appointment, policy } = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const now = new Date();
    const status = confirmationState(confirmation, appointment, now);
    if (status === 'EXPIRED' || !appointment) throw new GoneException(EXPIRED);
    const block = earlierBlock(appointment, now);
    if (block) throw new BadRequestException(EARLIER_MESSAGES[block]);

    const outcome = await this.repo.setWantsEarlier({
      appointmentId: appointment.id,
      wantsEarlier: input.wantsEarlier,
      window: input.wantsEarlier ? (input.preferredWindow ?? 'ANY') : null,
      now,
      request,
    });
    if (outcome === 'STALE') throw new GoneException(EXPIRED);

    // La vista fresca: con la marca ya puesta (o quitada).
    const fresh = await findConfirmationByToken(
      this.tenantContext,
      this.repo,
      token,
    );
    const clinic = await this.repo.findClinicBranding();
    return toPublicConfirmationView(
      confirmationState(fresh.confirmation, fresh.appointment, now),
      fresh.confirmation,
      fresh.appointment,
      clinic,
      policy,
      now,
    );
  }
}
