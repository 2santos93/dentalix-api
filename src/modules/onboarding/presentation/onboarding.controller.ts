import {
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { ONBOARDING_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  DismissOnboardingUseCase,
  GetOnboardingStatusUseCase,
} from '../application/onboarding.use-cases';
import type { OnboardingStatus } from '../domain/onboarding-steps';
import { OnboardingStatusDto } from './dto/onboarding.dto';

export const ONBOARDING_FORBIDDEN_MESSAGE =
  'Solo administración ve la puesta en marcha de la clínica.';

/**
 * DX-020: tarjeta «Pon en marcha tu clínica» del panel. Solo ADMIN; siempre
 * la clínica de la sesión.
 */
@ApiTags('onboarding')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ONBOARDING_ROLES)
@RolesDeniedMessage(ONBOARDING_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: ONBOARDING_FORBIDDEN_MESSAGE })
@Controller('onboarding')
export class OnboardingController {
  constructor(
    private readonly getStatus: GetOnboardingStatusUseCase,
    private readonly dismissCard: DismissOnboardingUseCase,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Pasos de la puesta en marcha (DX-020)',
    description:
      'Cinco pasos obligatorios y uno opcional, calculados con los datos de la clínica (nada se marca a mano), y si la tarjeta está descartada.',
  })
  @ApiOkResponse({ type: OnboardingStatusDto })
  status(): Promise<OnboardingStatus> {
    return this.getStatus.execute();
  }

  @Post('dismiss')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Descarta la tarjeta de puesta en marcha (DX-020)',
    description:
      'Idempotente: un segundo descarte conserva la primera fecha. Devuelve el estado ya descartado.',
  })
  @ApiOkResponse({ type: OnboardingStatusDto })
  dismiss(): Promise<OnboardingStatus> {
    return this.dismissCard.execute();
  }
}
