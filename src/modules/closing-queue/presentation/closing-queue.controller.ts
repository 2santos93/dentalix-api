import {
  Body,
  Controller,
  Get,
  Post,
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
import { CLOSING_QUEUE_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  ClosingQueueUseCases,
  CLOSING_QUEUE_FORBIDDEN_MESSAGE,
  type ClosingQueue,
  type ClosingQueueCount,
  type ClosingQueueQuery,
  type DismissalResult,
} from '../application/closing-queue.use-cases';
import {
  ClosingDismissalDto,
  ClosingQueueCountDto,
  ClosingQueueDto,
  ClosingQueueQueryDto,
  CreateClosingDismissalDto,
} from './dto/closing-queue.dto';

interface AuthenticatedRequest extends AuditableRequest {
  // RolesGuard ya exige un token de clínica (con rol).
  user: TenantJwtPayload;
}

const SCOPE =
  'Lo que quedó sin cerrar de días ANTERIORES a hoy (en la zona de la sede de cada cita; por defecto los últimos 14 días hasta ayer): ' +
  '(1) citas en SCHEDULED/CONFIRMED, (2) COMPLETED sin evolución viva ligada y (3) COMPLETED con un ítem ligado aún en ACCEPTED que no reserva otra cita. ' +
  'Lo descartado con motivo no sale. ADMIN ve las tres; un DENTIST, la 2 y la 3 de SUS citas; RECEPTION, la 1. ' +
  'Solo las sedes permitidas al usuario (DX-089). Sin notas ni datos clínicos: paciente, hora, sede, profesional y, en la 3, procedimiento y diente.';
const FORBIDDEN = `${CLOSING_QUEUE_FORBIDDEN_MESSAGE} / un DENTIST pidiendo las citas de otro / sede fuera de las del usuario`;
const BAD_REQUEST = 'Fechas inválidas o período de más de 92 días';

/**
 * «Pendiente de cerrar» (DX-439). Cerrar cada pendiente usa los endpoints de
 * siempre (PATCH /appointments/:id, POST de la evolución con su cita, PATCH
 * del ítem a DONE); aquí solo se lista y se descarta con motivo.
 */
@ApiTags('closing-queue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLOSING_QUEUE_ROLES)
@RolesDeniedMessage(CLOSING_QUEUE_FORBIDDEN_MESSAGE)
@Controller('closing-queue')
export class ClosingQueueController {
  constructor(
    private readonly closingQueue: ClosingQueueUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  private query(
    dto: ClosingQueueQueryDto,
    req: AuthenticatedRequest,
  ): ClosingQueueQuery {
    const active = this.tenantContext.getLocationId();
    return {
      locationId: dto.locationId,
      from: dto.from,
      to: dto.to,
      professionalId: dto.professionalId,
      actor: { userId: req.user.sub, role: req.user.role },
      allowedLocationIds: this.tenantContext.getAllowedLocationIds(),
      ...(active !== undefined ? { activeLocationId: active } : {}),
    };
  }

  // Lleva los nombres de muchos pacientes: queda auditado (VIEW).
  @Audit({ action: 'VIEW', resource: 'APPOINTMENT', reason: 'CLOSING_QUEUE' })
  @Get()
  @ApiOperation({
    summary: '«Pendiente de cerrar»: las tres secciones con su contador',
    description: SCOPE,
  })
  @ApiOkResponse({ type: ClosingQueueDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  list(
    @Query() dto: ClosingQueueQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClosingQueue> {
    return this.closingQueue.list(this.query(dto, req));
  }

  @Get('count')
  @ApiOperation({
    summary: 'Contador del menú de «Pendiente de cerrar»',
    description: `Los mismos filtros y alcance que la lista, solo los números (sin pacientes, sin auditoría). ${SCOPE}`,
  })
  @ApiOkResponse({ type: ClosingQueueCountDto })
  @ApiBadRequestResponse({ description: BAD_REQUEST })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  count(
    @Query() dto: ClosingQueueQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClosingQueueCount> {
    return this.closingQueue.count(this.query(dto, req));
  }

  @Post('dismissals')
  @ApiOperation({
    summary: 'Descartar un pendiente con motivo',
    description:
      'Saca UN pendiente (sección + cita [+ ítem en TREATMENT]) de la lista con un motivo de la lista; «Otro» exige texto de 3–200. ' +
      'No cambia la cita, la historia ni el plan. Deja un `audit_event` CREATE CLOSING_QUEUE_DISMISSAL (CLOSING_QUEUE_DISMISSED) en la misma transacción, ' +
      'con quién, la sección y el código del motivo y la cita (y el ítem) en `params`; nunca el texto. ' +
      'El rol tiene que ver esa sección; la cita, ser de una sede permitida (y del propio DENTIST).',
  })
  @ApiCreatedResponse({ type: ClosingDismissalDto })
  @ApiBadRequestResponse({
    description:
      'Sin motivo o con uno fuera de la lista, «Otro» sin texto de 3–200, o el ítem que falta (TREATMENT) o sobra',
  })
  @ApiForbiddenResponse({
    description:
      'Rol que no cierra esa sección, la cita de otro profesional (DENTIST) o de una sede no permitida',
  })
  @ApiNotFoundResponse({ description: 'La cita no existe en esta clínica' })
  @ApiConflictResponse({
    description: 'Ya no está pendiente: se cerró o ya se había descartado',
  })
  dismiss(
    @Body() dto: CreateClosingDismissalDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<DismissalResult> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.closingQueue.dismiss(
      {
        section: dto.section,
        appointmentId: dto.appointmentId,
        planItemId: dto.planItemId ?? null,
        reasonCode: dto.reasonCode,
        reasonText: dto.reasonText ?? null,
      },
      { userId: req.user.sub, role: req.user.role },
      this.tenantContext.getAllowedLocationIds(),
      ctx,
    );
  }
}
