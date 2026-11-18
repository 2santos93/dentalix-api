import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import {
  APPOINTMENT_ROLES,
  CLINIC_SETTINGS_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  OnlineBookingRequestsUseCases,
  OnlineBookingSettingsUseCases,
  OnlineBookingTypesUseCases,
} from '../application/use-cases/online-booking-admin.use-cases';
import type { OnlineBookingSettings } from '../domain/online-booking-settings';
import type { OnlineRequestView } from '../domain/ports/online-booking-repository.port';
import {
  ListOnlineRequestsQueryDto,
  OnlineBookingSettingsDto,
  OnlinePendingCountDto,
  OnlineRequestDto,
  OnlineRequestPageDto,
  OnlineTypeDto,
  UpdateOnlineBookingSettingsDto,
  UpdateOnlineTypeDto,
} from './dto/online-booking.dto';

export const ONLINE_BOOKING_ADMIN_MESSAGE =
  'Solo un administrador puede cambiar la reserva online.';

function ctxOf(
  req: AuditableRequest,
  tenantContext: TenantContextService,
): AuditRequestContext {
  const ctx = auditRequestContext(req, tenantContext);
  if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
  return ctx;
}

/**
 * Reserva online (DX-016) para el personal: ajustes y tipos (los cambia el
 * ADMIN, auditados) y la bandeja «Solicitudes online» (roles de la agenda,
 * con las sedes permitidas DX-089). Las escrituras se auditan en el caso de
 * uso, en su transacción.
 */
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('online-booking')
export class OnlineBookingController {
  constructor(
    private readonly settings: OnlineBookingSettingsUseCases,
    private readonly types: OnlineBookingTypesUseCases,
    private readonly requests: OnlineBookingRequestsUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('settings')
  @ApiOperation({
    summary: 'Ajustes de la reserva online (por defecto, desactivada)',
  })
  @ApiOkResponse({ type: OnlineBookingSettingsDto })
  getSettings(): Promise<OnlineBookingSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(ONLINE_BOOKING_ADMIN_MESSAGE)
  @ApiOperation({
    summary:
      'Activa o desactiva la reserva online y fija modos y antelaciones; queda en la auditoría',
  })
  @ApiOkResponse({ type: OnlineBookingSettingsDto })
  @ApiBadRequestResponse({ description: 'Un valor fuera de rango' })
  @ApiForbiddenResponse({ description: ONLINE_BOOKING_ADMIN_MESSAGE })
  updateSettings(
    @Body() dto: UpdateOnlineBookingSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<OnlineBookingSettings> {
    return this.settings.update(
      {
        enabled: dto.enabled,
        newPatientMode: dto.newPatientMode,
        existingPatientMode: dto.existingPatientMode,
        minLeadMinutesNew: dto.minLeadMinutesNew,
        minLeadMinutesExisting: dto.minLeadMinutesExisting,
        maxAdvanceDays: dto.maxAdvanceDays,
        slotStepMinutes: dto.slotStepMinutes,
      },
      ctxOf(req, this.tenantContext),
    );
  }

  @Get('types')
  @ApiOperation({
    summary: 'Tipos de cita del catálogo y su configuración online',
  })
  @ApiOkResponse({ type: [OnlineTypeDto] })
  listTypes(): Promise<OnlineTypeDto[]> {
    return this.types.list();
  }

  @Put('types/:appointmentTypeId')
  @Roles(...CLINIC_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(ONLINE_BOOKING_ADMIN_MESSAGE)
  @ApiOperation({
    summary:
      'Ofrece (o no) un tipo de cita online, con su duración, profesionales y sedes; queda en la auditoría',
  })
  @ApiOkResponse({ type: OnlineTypeDto })
  @ApiBadRequestResponse({
    description: 'Duración, profesional o sede inválidos',
  })
  @ApiNotFoundResponse({
    description: 'Tipo de cita no encontrado (o de otra clínica)',
  })
  @ApiConflictResponse({
    description: 'El tipo está desactivado en el catálogo',
  })
  @ApiForbiddenResponse({ description: ONLINE_BOOKING_ADMIN_MESSAGE })
  updateType(
    @Param('appointmentTypeId', ParseUUIDPipe) appointmentTypeId: string,
    @Body() dto: UpdateOnlineTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<OnlineTypeDto> {
    return this.types.update(
      {
        appointmentTypeId,
        visibleOnline: dto.visibleOnline,
        durationNewMinutes: dto.durationNewMinutes ?? null,
        durationExistingMinutes: dto.durationExistingMinutes ?? null,
        providerIds: dto.providerIds,
        locationIds: dto.locationIds,
      },
      ctxOf(req, this.tenantContext),
    );
  }

  @Get('requests')
  @ApiOperation({
    summary:
      'Bandeja «Solicitudes online» (y reservas directas) de las sedes permitidas',
  })
  @ApiOkResponse({ type: OnlineRequestPageDto })
  listRequests(
    @Query() query: ListOnlineRequestsQueryDto,
  ): Promise<{ items: OnlineRequestView[]; total: number }> {
    return this.requests.list({
      status: query.status ?? null,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
  }

  @Get('requests/pending-count')
  @ApiOperation({
    summary:
      'Cuántas solicitudes online quedan por revisar (para Pendientes y ⌘K)',
  })
  @ApiOkResponse({ type: OnlinePendingCountDto })
  pendingCount(): Promise<{ pending: number }> {
    return this.requests.pendingCount();
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Aceptar una solicitud: crea la cita (marca «Online») con las reglas de siempre y avisa al paciente',
  })
  @ApiOkResponse({ type: OnlineRequestDto })
  @ApiNotFoundResponse({
    description: 'Solicitud no encontrada (o de otra clínica)',
  })
  @ApiForbiddenResponse({
    description: 'La solicitud es de una sede no permitida',
  })
  @ApiConflictResponse({
    description: 'Ya resuelta, o la hora ya está ocupada',
  })
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest & TenantHostRequest,
  ): Promise<OnlineRequestView> {
    return this.requests.accept(
      id,
      ctxOf(req, this.tenantContext),
      req.tenantHost?.host,
    );
  }

  @Post('requests/:id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar una solicitud online' })
  @ApiOkResponse({ type: OnlineRequestDto })
  @ApiNotFoundResponse({
    description: 'Solicitud no encontrada (o de otra clínica)',
  })
  @ApiForbiddenResponse({
    description: 'La solicitud es de una sede no permitida',
  })
  @ApiConflictResponse({ description: 'Ya resuelta' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<OnlineRequestView> {
    return this.requests.decline(id, ctxOf(req, this.tenantContext));
  }
}
