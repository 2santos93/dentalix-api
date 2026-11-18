import {
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TREATMENT_PLAN_FOLLOW_UP_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  FOLLOW_UP_ALREADY_PAUSED_MESSAGE,
  FOLLOW_UP_NOT_OPEN_MESSAGE,
  FOLLOW_UP_NOT_PAUSED_MESSAGE,
  FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE,
  SetQuoteFollowUpPausedUseCase,
} from '../application/quote-follow-up-pause.use-cases';
import { QuoteFollowUpPauseDto } from './dto/quote-follow-up.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

/** Motivos de la auditoría (UPDATE TREATMENT_PLAN). */
export const QUOTE_FOLLOW_UP_PAUSED_REASON = 'QUOTE_FOLLOW_UP_PAUSED';
export const QUOTE_FOLLOW_UP_RESUMED_REASON = 'QUOTE_FOLLOW_UP_RESUMED';

/**
 * «Presupuestos por seguir» › ⋯ › Pausar / Reanudar el seguimiento automático
 * (DX-561, D6). Los roles de la lista de DX-040 (ADMIN, RECEPTION). Rutas con
 * sufijo propio: no chocan con `/treatment-plans/:id` de TreatmentPlansController.
 */
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...TREATMENT_PLAN_FOLLOW_UP_ROLES)
@Controller('treatment-plans')
export class QuoteFollowUpPauseController {
  constructor(private readonly pause: SetQuoteFollowUpPausedUseCase) {}

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: QUOTE_FOLLOW_UP_PAUSED_REASON,
  })
  @Post(':id/follow-up/pause')
  @HttpCode(200)
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Cualquier opción del grupo',
  })
  @ApiOperation({
    summary:
      'Pausa el seguimiento automático del presupuesto (todas sus opciones)',
    description:
      'Mientras está en pausa no sale ningún aviso y no se consume ningún paso. Auditado (UPDATE TREATMENT_PLAN, QUOTE_FOLLOW_UP_PAUSED).',
  })
  @ApiOkResponse({ type: QuoteFollowUpPauseDto })
  @ApiForbiddenResponse({
    description: 'Solo ADMIN y RECEPTION; o No tienes acceso a esta sede.',
  })
  @ApiNotFoundResponse({ description: FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE })
  @ApiConflictResponse({
    description: `${FOLLOW_UP_NOT_OPEN_MESSAGE} / ${FOLLOW_UP_ALREADY_PAUSED_MESSAGE}`,
  })
  pauseFollowUp(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<QuoteFollowUpPauseDto> {
    return this.pause.execute(id, true, req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'id' },
    patient: { lookup: 'treatmentPlan', param: 'id' },
    reason: QUOTE_FOLLOW_UP_RESUMED_REASON,
  })
  @Post(':id/follow-up/resume')
  @HttpCode(200)
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Cualquier opción del grupo',
  })
  @ApiOperation({
    summary: 'Reanuda el seguimiento automático del presupuesto',
    description:
      'Sale el paso que toque en la siguiente pasada dentro de la franja (los atrasados no se acumulan: SUPERSEDED / TOO_LATE). Auditado (UPDATE TREATMENT_PLAN, QUOTE_FOLLOW_UP_RESUMED).',
  })
  @ApiOkResponse({ type: QuoteFollowUpPauseDto })
  @ApiForbiddenResponse({
    description: 'Solo ADMIN y RECEPTION; o No tienes acceso a esta sede.',
  })
  @ApiNotFoundResponse({ description: FOLLOW_UP_PLAN_NOT_FOUND_MESSAGE })
  @ApiConflictResponse({ description: FOLLOW_UP_NOT_PAUSED_MESSAGE })
  resumeFollowUp(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<QuoteFollowUpPauseDto> {
    return this.pause.execute(id, false, req.user.sub);
  }
}
