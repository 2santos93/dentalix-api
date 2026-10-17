import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  CASH_SESSION_ADMIN_ROLES,
  CASH_SESSION_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  AddCashAdjustmentUseCase,
  ALREADY_OPEN_MESSAGE,
  CloseCashSessionUseCase,
  DIFFERENCE_REASON_REQUIRED_MESSAGE,
  GetCashSessionUseCase,
  GetCashSettingsUseCase,
  GetCurrentCashSessionUseCase,
  ListCashSessionsUseCase,
  NOT_CLOSED_MESSAGE,
  OpenCashSessionUseCase,
  ReopenCashSessionUseCase,
  SESSION_CLOSED_MESSAGE,
  UpdateCashSettingsUseCase,
  type CashSessionPage,
  type CurrentCashSession,
} from '../application/use-cases/cash-sessions.use-cases';
import type {
  CashActor,
  CashAdjustmentView,
  CashSessionDetail,
  CashSettings,
} from '../domain/cash-session.entity';
import {
  CashAdjustmentDto,
  CashSessionDetailDto,
  CashSessionPageDto,
  CashSettingsDto,
  CloseCashSessionDto,
  CreateCashAdjustmentDto,
  CurrentCashSessionDto,
  CurrentCashSessionQueryDto,
  ListCashSessionsQueryDto,
  OpenCashSessionDto,
  ReopenCashSessionDto,
} from './dto/cash-sessions.dto';

export const CASH_SESSIONS_FORBIDDEN_MESSAGE =
  'Tu rol no tiene acceso a la caja: es para administración y recepción.';
export const CASH_SESSIONS_ADMIN_MESSAGE =
  'Solo un administrador puede reabrir o corregir un cierre de caja y cambiar los ajustes de caja.';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const actorOf = (req: AuthenticatedRequest): CashActor => ({
  userId: req.user.sub,
  isAdmin: req.user.role === ClinicRole.ADMIN,
});

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede activa. Sin cabecera (ni locationId): la principal o, en la lista, todas.',
};

// Caja por turno (DX-027): dato FINANCIERO -> CASH_SESSION_ROLES (ADMIN +
// RECEPTION), 403 en español al resto. RECEPTION solo ve, abre y cierra las
// suyas (404 en las ajenas, lo decide el caso de uso). Sin PATCH ni DELETE A
// PROPÓSITO: un cierre no se edita (también en la BD); se corrige con un
// ajuste o reabriendo (ADMIN, con motivo). Rutas fijas antes de `:id`.
@ApiTags('cash-sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CASH_SESSION_ROLES)
@RolesDeniedMessage(CASH_SESSIONS_FORBIDDEN_MESSAGE)
@Controller('cash-sessions')
export class CashSessionsController {
  constructor(
    private readonly getSettings: GetCashSettingsUseCase,
    private readonly updateSettings: UpdateCashSettingsUseCase,
    private readonly getCurrent: GetCurrentCashSessionUseCase,
    private readonly openSession: OpenCashSessionUseCase,
    private readonly listSessions: ListCashSessionsUseCase,
    private readonly getSession: GetCashSessionUseCase,
    private readonly closeSession: CloseCashSessionUseCase,
    private readonly reopenSession: ReopenCashSessionUseCase,
    private readonly addAdjustment: AddCashAdjustmentUseCase,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Ajustes de caja de la clínica' })
  @ApiOkResponse({ type: CashSettingsDto })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  settings(): Promise<CashSettings> {
    return this.getSettings.execute();
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    reason: 'CASH_SETTINGS',
  })
  @Roles(...CASH_SESSION_ADMIN_ROLES)
  @RolesDeniedMessage(CASH_SESSIONS_ADMIN_MESSAGE)
  @Put('settings')
  @ApiOperation({
    summary: 'Cambiar los ajustes de caja de la clínica (solo ADMIN)',
    description:
      '«Exigir caja abierta» y «arqueo ciego». Por defecto los dos desactivados: el comportamiento de antes de la caja por turno.',
  })
  @ApiOkResponse({ type: CashSettingsDto })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_ADMIN_MESSAGE })
  saveSettings(@Body() dto: CashSettingsDto): Promise<CashSettings> {
    return this.updateSettings.execute({
      requireOpenSession: dto.requireOpenSession,
      blindClose: dto.blindClose,
    });
  }

  @Audit({
    action: 'VIEW',
    resource: 'CASH_SESSION',
    reason: 'CASH_SESSION_CURRENT',
  })
  @Get('current')
  @ApiOperation({
    summary: 'Mi caja abierta en la sede (o null) y los ajustes de caja',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: CurrentCashSessionDto })
  @ApiBadRequestResponse({ description: 'Sede ajena a la clínica' })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  current(
    @Query() query: CurrentCashSessionQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CurrentCashSession> {
    return this.getCurrent.execute(actorOf(req), query.locationId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'CASH_SESSION',
    resourceId: { response: 'id' },
  })
  @Post('open')
  @ApiOperation({
    summary: 'Abrir mi caja en la sede con el fondo inicial por moneda',
    description:
      'Una caja abierta por usuario y sede. Los ajustes pendientes de la sede (anulaciones o abonos tardíos de quien no tenía caja) entran en esta.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: CashSessionDetailDto })
  @ApiBadRequestResponse({
    description: 'Sede ajena, moneda desconocida o repetida, importe inválido',
  })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  @ApiConflictResponse({ description: ALREADY_OPEN_MESSAGE })
  open(
    @Body() dto: OpenCashSessionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashSessionDetail> {
    return this.openSession.execute(
      { locationId: dto.locationId, floats: dto.floats, notes: dto.notes },
      actorOf(req),
    );
  }

  @Audit({ action: 'VIEW', resource: 'CASH_SESSION' })
  @Get()
  @ApiOperation({
    summary: 'Turnos de caja (ADMIN: todos; RECEPTION: los suyos)',
    description:
      'Más recientes primero; filtros por sede, días de apertura y estado.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: CashSessionPageDto })
  @ApiBadRequestResponse({ description: 'Período o sede inválidos' })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  list(
    @Query() query: ListCashSessionsQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashSessionPage> {
    return this.listSessions.execute(
      {
        locationId: query.locationId,
        from: query.from,
        to: query.to,
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      },
      actorOf(req),
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
  })
  @Get(':id')
  @ApiOperation({
    summary: 'Una caja: fondo, abonos, anulados, ajustes, arqueo y cierres',
    description:
      'Con «arqueo ciego» y la caja abierta, quien no es ADMIN recibe `expected` y `payments` a null.',
  })
  @ApiOkResponse({ type: CashSessionDetailDto })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra clínica o (RECEPTION) es de otro usuario',
  })
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashSessionDetail> {
    return this.getSession.execute(id, actorOf(req));
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_CLOSED',
  })
  @Post(':id/close')
  @ApiOperation({
    summary: 'Cerrar la caja con el arqueo por moneda y método',
    description:
      'Calcula el esperado (fondo + abonos del turno + ajustes) y guarda contado y diferencia. Una diferencia distinta de 0 exige motivo. El cierre es inmutable y deja la fecha de bloqueo sugerida (DX-091).',
  })
  @ApiCreatedResponse({ type: CashSessionDetailDto })
  @ApiBadRequestResponse({ description: DIFFERENCE_REASON_REQUIRED_MESSAGE })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description:
      'No existe, es de otra clínica o (RECEPTION) es de otro usuario',
  })
  @ApiConflictResponse({ description: SESSION_CLOSED_MESSAGE })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseCashSessionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashSessionDetail> {
    return this.closeSession.execute(
      id,
      {
        counts: dto.counts,
        differenceReason: dto.differenceReason,
        notes: dto.notes,
      },
      actorOf(req),
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_REOPENED',
  })
  @Roles(...CASH_SESSION_ADMIN_ROLES)
  @RolesDeniedMessage(CASH_SESSIONS_ADMIN_MESSAGE)
  @Post(':id/reopen')
  @ApiOperation({
    summary: 'Reabrir un cierre (solo ADMIN, con motivo)',
    description:
      'El cierre anterior se conserva intacto; el siguiente cierre es una vuelta nueva.',
  })
  @ApiCreatedResponse({ type: CashSessionDetailDto })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_ADMIN_MESSAGE })
  @ApiNotFoundResponse({ description: 'No existe o es de otra clínica' })
  @ApiConflictResponse({
    description: `${NOT_CLOSED_MESSAGE} O quien la abrió ya tiene otra abierta en la sede.`,
  })
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReopenCashSessionDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashSessionDetail> {
    return this.reopenSession.execute(id, dto.reason, actorOf(req));
  }

  @Audit({
    action: 'CREATE',
    resource: 'CASH_SESSION',
    resourceId: { param: 'id' },
    reason: 'CASH_SESSION_ADJUSTMENT',
  })
  @Roles(...CASH_SESSION_ADMIN_ROLES)
  @RolesDeniedMessage(CASH_SESSIONS_ADMIN_MESSAGE)
  @Post(':id/adjustments')
  @ApiOperation({
    summary: 'Corregir un cierre con un ajuste (solo ADMIN, con motivo)',
    description:
      'El cierre no cambia: el ajuste cuenta en tu caja abierta en esa sede o, si no tienes, en la siguiente que se abra allí.',
  })
  @ApiCreatedResponse({ type: CashAdjustmentDto })
  @ApiBadRequestResponse({
    description: 'Importe 0, moneda o motivo inválidos',
  })
  @ApiForbiddenResponse({ description: CASH_SESSIONS_ADMIN_MESSAGE })
  @ApiNotFoundResponse({ description: 'No existe o es de otra clínica' })
  @ApiConflictResponse({ description: NOT_CLOSED_MESSAGE })
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCashAdjustmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CashAdjustmentView> {
    return this.addAdjustment.execute(
      id,
      {
        currency: dto.currency,
        method: dto.method,
        amount: dto.amount,
        reason: dto.reason,
      },
      actorOf(req),
    );
  }
}
