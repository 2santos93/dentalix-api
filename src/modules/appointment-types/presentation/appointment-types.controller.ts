import {
  BadRequestException,
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
  APPOINTMENT_TYPE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreateAppointmentTypeUseCase,
  DeleteAppointmentTypeUseCase,
  GetAppointmentTypeUseCase,
  ListAppointmentTypesUseCase,
  UpdateAppointmentTypeUseCase,
} from '../application/use-cases/appointment-types.use-cases';
import { AppointmentType } from '../domain/entities/appointment-type.entity';
import { localizedTextEntries } from '../../../shared/i18n/localized-text';
import {
  AppointmentTypeDto,
  CreateAppointmentTypeDto,
  ListAppointmentTypesQueryDto,
  PreVisitInstructionDto,
  UpdateAppointmentTypeDto,
} from './dto/appointment-type.dto';
import { PRE_VISIT_INSTRUCTIONS_NOT_A_LIST_MESSAGE } from '../domain/appointment-type-rules';

/**
 * DX-564: la lista que llega, campo a campo. `null` es un 400 y no «sin el
 * campo»: `PartialType` hace opcional (y salta `null`) toda regla del PATCH.
 */
function instructionsInput(
  entries: PreVisitInstructionDto[] | null | undefined,
): { language: string; text: string }[] | undefined {
  if (entries === null) {
    throw new BadRequestException(PRE_VISIT_INSTRUCTIONS_NOT_A_LIST_MESSAGE);
  }
  return entries?.map((e) => ({ language: e.language, text: e.text }));
}

/** La respuesta: el mapa de indicaciones como lista ordenada (DX-564). */
function toDto(type: AppointmentType): AppointmentTypeDto {
  return {
    id: type.id,
    tenantId: type.tenantId,
    name: type.name,
    durationMinutes: type.durationMinutes,
    color: type.color,
    active: type.active,
    isUrgent: type.isUrgent,
    preVisitInstructions: localizedTextEntries(type.preVisitInstructions),
    createdAt: type.createdAt,
    updatedAt: type.updatedAt,
  };
}

// Tipos de cita (DX-121). Leerlos: quien agenda (los 4 roles, para el selector
// del formulario). Crear, editar, desactivar y retirar: solo ADMIN.
@ApiTags('appointment-types')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('appointment-types')
export class AppointmentTypesController {
  constructor(
    private readonly listTypes: ListAppointmentTypesUseCase,
    private readonly getType: GetAppointmentTypeUseCase,
    private readonly createType: CreateAppointmentTypeUseCase,
    private readonly updateType: UpdateAppointmentTypeUseCase,
    private readonly deleteType: DeleteAppointmentTypeUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [AppointmentTypeDto] })
  async list(
    @Query() query: ListAppointmentTypesQueryDto,
  ): Promise<AppointmentTypeDto[]> {
    const types = await this.listTypes.execute({
      includeInactive: query.includeInactive,
    });
    return types.map(toDto);
  }

  @Get(':id')
  @ApiOkResponse({
    type: AppointmentTypeDto,
    description:
      'DX-564: un tipo por id, también desactivado o retirado (las citas lo conservan y sus indicaciones previas se siguen enviando). Los 4 roles.',
  })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AppointmentTypeDto> {
    return toDto(await this.getType.execute(id));
  }

  @Post()
  @Roles(...APPOINTMENT_TYPE_WRITE_ROLES)
  @ApiCreatedResponse({ type: AppointmentTypeDto })
  @ApiBadRequestResponse({
    description:
      'Nombre vacío, duración fuera de rango, color no #RRGGBB o indicaciones previas inválidas (idioma no ofrecido o repetido, más de 600 caracteres, enlaces o HTML)',
  })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async create(
    @Body() dto: CreateAppointmentTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<AppointmentTypeDto> {
    const created = await this.createType.execute(
      {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        color: dto.color,
        active: dto.active,
        isUrgent: dto.isUrgent,
        preVisitInstructions: instructionsInput(dto.preVisitInstructions),
      },
      this.audit(req),
    );
    return toDto(created);
  }

  @Patch(':id')
  @Roles(...APPOINTMENT_TYPE_WRITE_ROLES)
  @ApiOkResponse({ type: AppointmentTypeDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<AppointmentTypeDto> {
    const updated = await this.updateType.execute(
      id,
      {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        color: dto.color,
        active: dto.active,
        isUrgent: dto.isUrgent,
        preVisitInstructions: instructionsInput(dto.preVisitInstructions),
      },
      this.audit(req),
    );
    return toDto(updated);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(...APPOINTMENT_TYPE_WRITE_ROLES)
  @ApiNoContentResponse({
    description:
      'Retirado (borrado lógico). Las citas que lo usan lo conservan.',
  })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.deleteType.execute(id, this.audit(req));
  }

  /** Quién escribe, para el evento que el repositorio guarda (DX-360). */
  private audit(req: AuditableRequest): AuditRequestContext {
    return requireAuditRequestContext(req, this.tenantContext);
  }
}
