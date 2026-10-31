import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  APPOINTMENT_ROLES,
  SCHEDULE_BLOCK_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateScheduleBlockUseCase,
  DeleteScheduleBlockUseCase,
  ListAffectedAppointmentsUseCase,
  ListScheduleBlocksUseCase,
  UpdateScheduleBlockUseCase,
  type ScheduleBlockActor,
} from '../application/use-cases/schedule-blocks.use-cases';
import type {
  ScheduleBlock,
  ScheduleBlockView,
} from '../domain/entities/schedule-block.entity';
import type { AffectedAppointmentsPage } from '../domain/ports/schedule-block-repository.port';
import {
  AffectedAppointmentsPageDto,
  AffectedAppointmentsQueryDto,
  CreateScheduleBlockDto,
  ListScheduleBlocksQueryDto,
  ScheduleBlockDto,
  ScheduleBlockListItemDto,
  UpdateScheduleBlockDto,
} from './dto/schedule-block.dto';

interface AuthenticatedRequest {
  // RolesGuard ya exige un token de clínica (con rol) en todas las rutas.
  user: TenantJwtPayload;
}

function actorOf(req: AuthenticatedRequest): ScheduleBlockActor {
  return { userId: req.user.sub, role: req.user.role };
}

/**
 * Bloqueos de agenda (DX-122). Leerlos: los 4 roles de agenda (se pintan en
 * Día y Semana). Escribirlos: ADMIN y recepción; el odontólogo, solo los de su
 * propia agenda (403 si no). Altas, cambios y bajas dejan `audit_event`.
 */
@ApiTags('schedule-blocks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('schedule-blocks')
export class ScheduleBlocksController {
  constructor(
    private readonly listBlocks: ListScheduleBlocksUseCase,
    private readonly listAffected: ListAffectedAppointmentsUseCase,
    private readonly createBlock: CreateScheduleBlockUseCase,
    private readonly updateBlock: UpdateScheduleBlockUseCase,
    private readonly deleteBlock: DeleteScheduleBlockUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [ScheduleBlockListItemDto] })
  @ApiBadRequestResponse({
    description: 'Rango vacío o de más de 92 días',
  })
  @ApiNotFoundResponse({ description: 'Sede o profesional de otra clínica' })
  list(
    @Query() query: ListScheduleBlocksQueryDto,
  ): Promise<ScheduleBlockView[]> {
    return this.listBlocks.execute({
      from: new Date(query.from),
      to: new Date(query.to),
      locationId: query.locationId,
      providerIds: query.providerIds,
    });
  }

  @Get('affected-appointments')
  @ApiOkResponse({
    type: AffectedAppointmentsPageDto,
    description:
      'Citas vivas (programadas o confirmadas) que quedarían dentro de un bloqueo con ese alcance y rango: las primeras 50 por hora y el total. No se tocan.',
  })
  @ApiBadRequestResponse({
    description: 'Sin sede ni profesional, o rango inválido',
  })
  @ApiNotFoundResponse({ description: 'Sede o profesional de otra clínica' })
  affected(
    @Query() query: AffectedAppointmentsQueryDto,
  ): Promise<AffectedAppointmentsPage> {
    return this.listAffected.execute({
      start: new Date(query.start),
      end: new Date(query.end),
      providerId: query.providerId,
      locationId: query.locationId,
    });
  }

  @Post()
  @Roles(...SCHEDULE_BLOCK_WRITE_ROLES)
  @Audit({
    action: 'CREATE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: { response: 'id' },
  })
  @ApiCreatedResponse({ type: ScheduleBlockDto })
  @ApiBadRequestResponse({
    description:
      'Sin sede ni profesional, fin no posterior al inicio, más de 366 días, nota inválida, o reservado mal formado (DX-446: sin tipos, sin sede, más de un día, liberación tras el inicio, tipo desactivado)',
  })
  @ApiForbiddenResponse({
    description: 'Asistente, o un odontólogo que bloquea otra agenda o la sede',
  })
  @ApiNotFoundResponse({
    description:
      'Sede, profesional o tipo de cita reservado (DX-446) de otra clínica',
  })
  @ApiConflictResponse({
    description:
      'Hay citas dentro del rango y no vino `confirmAffected: true` (no se tocan)',
  })
  create(
    @Body() dto: CreateScheduleBlockDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleBlock> {
    return this.createBlock.execute(
      {
        providerId: dto.providerId,
        locationId: dto.locationId,
        start: new Date(dto.start),
        end: new Date(dto.end),
        kind: dto.kind,
        allowsBooking: dto.allowsBooking,
        note: dto.note,
        reservedForTypeIds: dto.reservedForTypeIds,
        releaseAtMinute: dto.releaseAtMinute,
        confirmAffected: dto.confirmAffected,
      },
      actorOf(req),
    );
  }

  @Patch(':id')
  @Roles(...SCHEDULE_BLOCK_WRITE_ROLES)
  @Audit({
    action: 'UPDATE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: { param: 'id' },
  })
  @ApiOkResponse({ type: ScheduleBlockDto })
  @ApiBadRequestResponse({ description: 'Rango o nota inválidos' })
  @ApiForbiddenResponse({
    description: 'Asistente, o un odontólogo con un bloqueo ajeno',
  })
  @ApiNotFoundResponse({ description: 'Bloqueo no encontrado en esta clínica' })
  @ApiConflictResponse({
    description: 'El nuevo rango cubre citas y no vino `confirmAffected`',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateScheduleBlockDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ScheduleBlock> {
    return this.updateBlock.execute(
      id,
      {
        start: dto.start !== undefined ? new Date(dto.start) : undefined,
        end: dto.end !== undefined ? new Date(dto.end) : undefined,
        kind: dto.kind,
        allowsBooking: dto.allowsBooking,
        note: dto.note,
        reservedForTypeIds: dto.reservedForTypeIds,
        releaseAtMinute: dto.releaseAtMinute,
        confirmAffected: dto.confirmAffected,
      },
      actorOf(req),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(...SCHEDULE_BLOCK_WRITE_ROLES)
  @Audit({
    action: 'DELETE',
    resource: 'SCHEDULE_BLOCK',
    resourceId: { param: 'id' },
  })
  @ApiNoContentResponse({ description: 'Retirado (borrado lógico).' })
  @ApiForbiddenResponse({
    description: 'Asistente, o un odontólogo con un bloqueo ajeno',
  })
  @ApiNotFoundResponse({ description: 'Bloqueo no encontrado en esta clínica' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.deleteBlock.execute(id, actorOf(req));
  }
}
