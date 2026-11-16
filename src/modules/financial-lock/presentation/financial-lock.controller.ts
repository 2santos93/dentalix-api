import { ExtraPermission } from '@prisma/client';
import {
  Body,
  Controller,
  Get,
  Patch,
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
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { AllowPermissions } from '../../auth/presentation/guards/permissions.decorator';
import {
  CLINIC_SETTINGS_WRITE_ROLES,
  PAYMENT_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  GetFinancialLockUseCase,
  GetPeriodLockUseCase,
  UpdateFinancialLockUseCase,
} from '../application/financial-lock.use-cases';
import type {
  FinancialLockSettingsView,
  PeriodLockView,
} from '../domain/financial-lock-settings';
import {
  FinancialLockSettingsDto,
  PeriodLockDto,
  UpdateFinancialLockDto,
} from './dto/financial-lock.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const FINANCIAL_LOCK_FORBIDDEN_MESSAGE =
  'Solo administración configura el cierre contable.';

const ZONE_CONFLICT =
  '`code: LOCATION_TIMEZONE_REQUIRED` si la sede de la petición no tiene zona horaria válida.';

/**
 * DX-091: Ajustes › Caja › Cierre contable. Solo ADMIN; cada cambio queda en
 * la auditoría (CLINIC_SETTINGS, FINANCIAL_LOCK) con el antes y el después.
 */
@ApiTags('clinic')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINIC_SETTINGS_WRITE_ROLES)
@RolesDeniedMessage(FINANCIAL_LOCK_FORBIDDEN_MESSAGE)
@ApiForbiddenResponse({ description: FINANCIAL_LOCK_FORBIDDEN_MESSAGE })
@Controller('clinic/settings/financial-lock')
export class FinancialLockSettingsController {
  constructor(
    private readonly getLock: GetFinancialLockUseCase,
    private readonly updateLock: UpdateFinancialLockUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Cierre contable de la clínica y sus últimas excepciones (DX-091)',
  })
  @ApiOkResponse({ type: FinancialLockSettingsDto })
  @ApiConflictResponse({ description: ZONE_CONFLICT })
  get(): Promise<FinancialLockSettingsView> {
    return this.getLock.execute();
  }

  @Patch()
  @ApiOperation({
    summary: 'Cambia el cierre contable (DX-091)',
    description:
      'Fecha fija (cerrado ese día y lo anterior) y/o días abiertos hacia ' +
      'atrás; rige el cierre más tardío, en el día civil de la sede de cada ' +
      'abono. Con el cierre, crear un abono con fecha cerrada, anularlo o ' +
      'crear o cancelar un plan con cuotas en días cerrados responde 409 ' +
      '`PERIOD_LOCKED`. Con `adminExempt`, el ADMIN puede hacerlo indicando ' +
      '`lockOverrideReason`, y queda registrado. Solo cambian los campos ' +
      'enviados; null quita ese cierre. Auditado con el antes y el después.',
  })
  @ApiOkResponse({ type: FinancialLockSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Fecha que no es AAAA-MM-DD o no es anterior a hoy en la sede, días fuera de 0..365 o exención que no es sí/no',
  })
  @ApiConflictResponse({ description: ZONE_CONFLICT })
  update(
    @Body() dto: UpdateFinancialLockDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<FinancialLockSettingsView> {
    return this.updateLock.execute(
      {
        lockDate: dto.lockDate,
        lockDays: dto.lockDays,
        adminExempt: dto.adminExempt,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}

/**
 * DX-091: el cierre que rige hoy en la sede donde se registra, para el
 * selector de fecha del abono: quien registra abonos (también la asistente
 * con PAYMENT_REGISTER).
 */
@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYMENT_ROLES)
@Controller('payments/period-lock')
export class PeriodLockController {
  constructor(private readonly getPeriodLock: GetPeriodLockUseCase) {}

  @AllowPermissions(ExtraPermission.PAYMENT_REGISTER)
  @Get()
  @ApiOperation({
    summary: 'Cierre contable vigente en la sede (DX-091)',
    description:
      'El último día cerrado hoy en la sede donde se registra el abono (los días hasta él, inclusive, no admiten abonos ni anulaciones) y si quien pregunta puede saltarlo con motivo.',
  })
  @ApiOkResponse({ type: PeriodLockDto })
  @ApiConflictResponse({ description: ZONE_CONFLICT })
  get(@Req() req: AuthenticatedRequest): Promise<PeriodLockView> {
    return this.getPeriodLock.execute(req.user.role);
  }
}
