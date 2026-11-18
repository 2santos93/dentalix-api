import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  QUOTE_FOLLOW_UP_CLOCK,
  QUOTE_FOLLOW_UP_REPOSITORY,
  type QuoteFollowUpClock,
  type QuoteFollowUpRepository,
} from '../domain/ports/quote-follow-up-repository.port';

export const FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE =
  'Plan de tratamiento no encontrado';
export const FOLLOW_UP_NOT_OPEN_MESSAGE =
  'Solo se pausa el seguimiento de un presupuesto presentado y sin aceptar.';
export const FOLLOW_UP_ALREADY_PAUSED_MESSAGE =
  'El seguimiento automático de este presupuesto ya está en pausa.';
export const FOLLOW_UP_NOT_PAUSED_MESSAGE =
  'El seguimiento automático de este presupuesto no está en pausa.';

export interface QuoteFollowUpPauseState {
  planId: string;
  /** El grupo de opciones (plan raíz): la pausa vale para todas. */
  groupId: string;
  paused: boolean;
  pausedAt: Date | null;
  pausedById: string | null;
}

/**
 * Pausar o reanudar el seguimiento automático de un presupuesto (DX-561, D6):
 * se escribe en todos los planes del grupo, con el grupo bloqueado. Solo un
 * presupuesto abierto (alguna opción presentada y ninguna aceptada) se pausa;
 * reanudar vale siempre que esté en pausa. Una sede de presentación que el
 * miembro no ve es 403 (SEC-045). Pausado no consume pasos: al reanudar sale
 * el paso que toque (con las reglas de SUPERSEDED y TOO_LATE).
 */
@Injectable()
export class SetQuoteFollowUpPausedUseCase {
  constructor(
    @Inject(QUOTE_FOLLOW_UP_REPOSITORY)
    private readonly repo: QuoteFollowUpRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(QUOTE_FOLLOW_UP_CLOCK) private readonly clock: QuoteFollowUpClock,
  ) {}

  async execute(
    planId: string,
    paused: boolean,
    userId: string,
  ): Promise<QuoteFollowUpPauseState> {
    const outcome = await this.repo.setPaused({
      planId,
      paused,
      userId,
      now: this.clock(),
      assertLocation: (locationId) => {
        if (locationId) this.tenantContext.assertLocationAllowed(locationId);
      },
    });
    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw new NotFoundException(FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE);
      case 'NOT_OPEN':
        throw new ConflictException(FOLLOW_UP_NOT_OPEN_MESSAGE);
      case 'ALREADY':
        throw new ConflictException(
          paused
            ? FOLLOW_UP_ALREADY_PAUSED_MESSAGE
            : FOLLOW_UP_NOT_PAUSED_MESSAGE,
        );
      default:
        return {
          planId,
          groupId: outcome.groupId as string,
          paused,
          pausedAt: outcome.pausedAt ?? null,
          pausedById: outcome.pausedById ?? null,
        };
    }
  }
}
