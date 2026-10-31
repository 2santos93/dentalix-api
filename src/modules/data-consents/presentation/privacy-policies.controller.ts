import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  PrivacyPoliciesDto,
  PrivacyPolicyVersionDto,
  PublishPrivacyPolicyDto,
} from './dto/privacy-policy.dto';
import { GetPrivacyPoliciesUseCase } from '../application/use-cases/get-privacy-policies.use-case';
import { PublishPrivacyPolicyUseCase } from '../application/use-cases/publish-privacy-policy.use-case';
import type {
  PrivacyPolicies,
  PrivacyPolicyVersion,
} from '../domain/entities/privacy-policy.entity';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  DATA_CONSENT_ROLES,
  PRIVACY_POLICY_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Sin PATCH/PUT/DELETE a propósito: una versión publicada es inmutable (y la
// BD lo impone con un trigger). Cambiar la política = publicar otra versión.
@ApiTags('privacy-policies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...DATA_CONSENT_ROLES)
@Controller('privacy-policies')
export class PrivacyPoliciesController {
  constructor(
    private readonly getPolicies: GetPrivacyPoliciesUseCase,
    private readonly publishPolicy: PublishPrivacyPolicyUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Política de tratamiento de datos vigente e historial de versiones',
  })
  @ApiOkResponse({ type: PrivacyPoliciesDto })
  list(): Promise<PrivacyPolicies> {
    return this.getPolicies.execute();
  }

  @Post()
  @Roles(...PRIVACY_POLICY_WRITE_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Publicar una nueva versión de la política (solo ADMIN)',
    description:
      'Crea la versión siguiente y pasa a ser la vigente. No hay borradores ni edición.',
  })
  @ApiCreatedResponse({ type: PrivacyPolicyVersionDto })
  @ApiBadRequestResponse({ description: 'Algún texto está vacío.' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN publica la política.' })
  @ApiConflictResponse({
    description: 'Otra versión se publicó a la vez; recarga y reintenta.',
  })
  publish(
    @Body() dto: PublishPrivacyPolicyDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PrivacyPolicyVersion> {
    return this.publishPolicy.execute(
      {
        policyText: dto.policyText,
        generalText: dto.generalText,
        sensitiveHealthText: dto.sensitiveHealthText,
        marketingText: dto.marketingText,
      },
      req.user.sub,
    );
  }
}
