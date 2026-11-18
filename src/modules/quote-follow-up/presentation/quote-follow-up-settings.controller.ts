import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
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
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  ListQuoteFollowUpSettingsUseCase,
  QUOTE_FOLLOW_UP_LOCATION_NOT_FOUND_MESSAGE,
  UpdateQuoteFollowUpSettingsUseCase,
} from '../application/quote-follow-up-settings.use-cases';
import {
  LocationQuoteFollowUpSettingsDto,
  UpdateQuoteFollowUpSettingsDto,
} from './dto/quote-follow-up.dto';

export const QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede ver y cambiar el seguimiento automático de presupuestos.';

/**
 * Ajustes › Presupuestos › Seguimiento automático (DX-561, D1): por sede.
 * Solo ADMIN, para leer y para escribir.
 */
@ApiTags('quote-follow-up')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE)
@Controller('quote-follow-up-settings')
export class QuoteFollowUpSettingsController {
  constructor(
    private readonly list: ListQuoteFollowUpSettingsUseCase,
    private readonly update: UpdateQuoteFollowUpSettingsUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Ajustes del seguimiento automático de cada sede',
    description:
      'Una fila por sede viva. Sin configurar: apagado, avisos a los 3, 10 y 21 días, de 9 a 19 (hora de la sede).',
  })
  @ApiOkResponse({ type: [LocationQuoteFollowUpSettingsDto] })
  @ApiForbiddenResponse({
    description: QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE,
  })
  findAll(): Promise<LocationQuoteFollowUpSettingsDto[]> {
    return this.list.execute();
  }

  // Auditado en la transacción (UPDATE CLINIC_SETTINGS, reason
  // QUOTE_FOLLOW_UP_SETTINGS_UPDATED) con el antes y el después; sin evento
  // si nada cambia.
  @Put(':locationId')
  @ApiOperation({
    summary: 'Reemplaza los ajustes del seguimiento automático de una sede',
    description:
      'Queda en la auditoría (QUOTE_FOLLOW_UP_SETTINGS_UPDATED) con activado, días de los avisos y franja horaria antes y después, en esa sede. Guardar lo mismo no deja evento. El aviso solo lleva el nombre de la clínica, un saludo, un texto neutro, los enlaces de aceptación y la baja: ni importes ni tratamientos.',
  })
  @ApiOkResponse({ type: LocationQuoteFollowUpSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Días o franja inválidos (mensaje en español): de 1 a 3 avisos, días de 1 a 90 de menor a mayor, franja de 0–23 a 1–24 con el final después del inicio',
  })
  @ApiForbiddenResponse({
    description: QUOTE_FOLLOW_UP_SETTINGS_FORBIDDEN_MESSAGE,
  })
  @ApiNotFoundResponse({
    description: QUOTE_FOLLOW_UP_LOCATION_NOT_FOUND_MESSAGE,
  })
  replace(
    @Param(
      'locationId',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException('El identificador de la sede no es válido.'),
      }),
    )
    locationId: string,
    @Body() dto: UpdateQuoteFollowUpSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<LocationQuoteFollowUpSettingsDto> {
    return this.update.execute(
      locationId,
      {
        enabled: dto.enabled,
        offsetsDays: dto.offsetsDays,
        sendFromHour: dto.sendFromHour,
        sendUntilHour: dto.sendUntilHour,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }
}
