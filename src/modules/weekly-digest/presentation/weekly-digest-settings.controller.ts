import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { CLINIC_SETTINGS_WRITE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetWeeklyDigestSettingsUseCase,
  SendWeeklyDigestTestUseCase,
  UpdateWeeklyDigestSettingsUseCase,
  WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE,
  WEEKLY_DIGEST_RECIPIENTS_MESSAGE,
  type WeeklyDigestSettingsView,
  type WeeklyDigestTestResult,
} from '../application/weekly-digest-settings.use-cases';
import {
  UpdateWeeklyDigestSettingsDto,
  WeeklyDigestSettingsDto,
  WeeklyDigestTestResultDto,
} from './dto/weekly-digest.dto';

export const WEEKLY_DIGEST_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver y cambiar el resumen semanal.';

/**
 * Ajustes › Resumen semanal (DX-568): el email semanal con las cifras de la
 * clínica para sus ADMIN. Solo ADMIN, todo auditado en el caso de uso.
 */
@ApiTags('clinic')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(WEEKLY_DIGEST_FORBIDDEN_MESSAGE)
@Controller('clinic')
export class WeeklyDigestSettingsController {
  constructor(
    private readonly getSettings: GetWeeklyDigestSettingsUseCase,
    private readonly updateSettings: UpdateWeeklyDigestSettingsUseCase,
    private readonly sendTest: SendWeeklyDigestTestUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  private ctx(req: AuditableRequest) {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  @Get('weekly-digest-settings')
  @ApiOperation({
    summary:
      'Ajustes del resumen semanal por email y los ADMIN candidatos (DX-568)',
  })
  @ApiOkResponse({ type: WeeklyDigestSettingsDto })
  @ApiForbiddenResponse({ description: WEEKLY_DIGEST_FORBIDDEN_MESSAGE })
  settings(): Promise<WeeklyDigestSettingsView> {
    return this.getSettings.execute();
  }

  @Put('weekly-digest-settings')
  @ApiOperation({
    summary:
      'Cambia el resumen semanal: activado, día, hora y destinatarios (DX-568)',
    description:
      'Sustituye los destinatarios entre los ADMIN activos y lo audita (CLINIC_SETTINGS, WEEKLY_DIGEST_SETTINGS, antes y después); sin evento si nada cambia. Activado sin destinatarios se permite y avisa con `NO_RECIPIENTS`.',
  })
  @ApiOkResponse({ type: WeeklyDigestSettingsDto })
  @ApiBadRequestResponse({
    description: `Día fuera de 0..6, hora fuera de 0..23, ids mal formados o «${WEEKLY_DIGEST_RECIPIENTS_MESSAGE}»`,
  })
  @ApiForbiddenResponse({ description: WEEKLY_DIGEST_FORBIDDEN_MESSAGE })
  update(
    @Body() dto: UpdateWeeklyDigestSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<WeeklyDigestSettingsView> {
    return this.updateSettings.execute(
      {
        enabled: dto.enabled,
        weekday: dto.weekday,
        hour: dto.hour,
        recipientMembershipIds: dto.recipientMembershipIds,
      },
      this.ctx(req),
    );
  }

  @Post('weekly-digest/send-test')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Envía ahora una prueba del resumen semanal a quien la pide (DX-568)',
    description:
      'El resumen de la semana anterior completa, solo a tu correo (confirmado), con «[Prueba]» en el asunto y sin enlace de baja. No cuenta como el envío semanal. Una cada 5 minutos por persona; queda en la auditoría (VIEW de CLINIC_SETTINGS, WEEKLY_DIGEST_TEST_SENT).',
  })
  @ApiOkResponse({ type: WeeklyDigestTestResultDto })
  @ApiConflictResponse({
    description: `EMAIL_NOT_VERIFIED: «${WEEKLY_DIGEST_NOT_VERIFIED_MESSAGE}»; LOCATION_REQUIRED: sin sede principal con zona y formato`,
  })
  @ApiTooManyRequestsResponse({
    description:
      'Ya pediste una prueba hace menos de 5 minutos (o se alcanzó el tope de correos); `retryAfterSeconds` dice cuánto esperar.',
  })
  @ApiForbiddenResponse({ description: WEEKLY_DIGEST_FORBIDDEN_MESSAGE })
  test(@Req() req: AuditableRequest): Promise<WeeklyDigestTestResult> {
    return this.sendTest.execute(this.ctx(req));
  }
}
