import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import { UserMfaService } from '../application/user-mfa.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles, RolesDeniedMessage } from './guards/roles.decorator';
import { SecurityPolicyDto } from './dto/security-policy.dto';

export const SECURITY_POLICY_FORBIDDEN_MESSAGE =
  'Solo la administración ve y cambia la seguridad de la clínica.';

/**
 * DX-021: política de seguridad de la clínica (hoy: exigir el MFA a los
 * ADMIN). Solo ADMIN; el cambio queda auditado (CLINIC_SETTINGS, `MFA_POLICY`).
 */
@ApiTags('auth')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(SECURITY_POLICY_FORBIDDEN_MESSAGE)
@Controller('security-policy')
export class SecurityPolicyController {
  constructor(
    private readonly mfa: UserMfaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Política de seguridad de la clínica' })
  @ApiOkResponse({ type: SecurityPolicyDto })
  @ApiForbiddenResponse({ description: SECURITY_POLICY_FORBIDDEN_MESSAGE })
  get(@Req() req: AuditableRequest): Promise<SecurityPolicyDto> {
    const ctx = requireAuditRequestContext(req, this.tenantContext);
    return this.mfa.clinicPolicy(ctx.tenantId);
  }

  @Put()
  @ApiOperation({
    summary: 'Cambia la política de seguridad de la clínica (solo ADMIN)',
    description:
      'Para exigir el MFA a los ADMIN, quien lo cambia debe tener ya el suyo activo (409 si no). Queda en la auditoría con el antes y el después.',
  })
  @ApiOkResponse({ type: SecurityPolicyDto })
  @ApiForbiddenResponse({ description: SECURITY_POLICY_FORBIDDEN_MESSAGE })
  @ApiConflictResponse({ description: 'Quien la enciende no tiene MFA activo' })
  update(
    @Req() req: AuditableRequest,
    @Body() dto: SecurityPolicyDto,
  ): Promise<SecurityPolicyDto> {
    return this.mfa.setClinicPolicy(
      dto.requireAdminMfa,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
