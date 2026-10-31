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
  ListAppointmentTypesUseCase,
  UpdateAppointmentTypeUseCase,
} from '../application/use-cases/appointment-types.use-cases';
import { AppointmentType } from '../domain/entities/appointment-type.entity';
import {
  AppointmentTypeDto,
  CreateAppointmentTypeDto,
  ListAppointmentTypesQueryDto,
  UpdateAppointmentTypeDto,
} from './dto/appointment-type.dto';

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
    private readonly createType: CreateAppointmentTypeUseCase,
    private readonly updateType: UpdateAppointmentTypeUseCase,
    private readonly deleteType: DeleteAppointmentTypeUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [AppointmentTypeDto] })
  list(
    @Query() query: ListAppointmentTypesQueryDto,
  ): Promise<AppointmentType[]> {
    return this.listTypes.execute({ includeInactive: query.includeInactive });
  }

  @Post()
  @Roles(...APPOINTMENT_TYPE_WRITE_ROLES)
  @ApiCreatedResponse({ type: AppointmentTypeDto })
  @ApiBadRequestResponse({
    description: 'Nombre vacío, duración fuera de rango o color no #RRGGBB',
  })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateAppointmentTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<AppointmentType> {
    return this.createType.execute(
      {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        color: dto.color,
        active: dto.active,
        isUrgent: dto.isUrgent,
      },
      this.audit(req),
    );
  }

  @Patch(':id')
  @Roles(...APPOINTMENT_TYPE_WRITE_ROLES)
  @ApiOkResponse({ type: AppointmentTypeDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({ description: 'Tipo no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya existe un tipo con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentTypeDto,
    @Req() req: AuditableRequest,
  ): Promise<AppointmentType> {
    return this.updateType.execute(
      id,
      {
        name: dto.name,
        durationMinutes: dto.durationMinutes,
        color: dto.color,
        active: dto.active,
        isUrgent: dto.isUrgent,
      },
      this.audit(req),
    );
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
