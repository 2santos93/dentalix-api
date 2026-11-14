import {
  Body,
  Controller,
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
  ApiHeader,
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
import { EQUIPMENT_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateEquipmentUseCase,
  GetEquipmentUseCase,
  ListEquipmentUseCase,
  RecordMaintenanceUseCase,
  RetireEquipmentUseCase,
  UpdateEquipmentUseCase,
  VoidMaintenanceUseCase,
  type ListEquipmentOutput,
} from '../application/use-cases/equipment.use-cases';
import {
  ListMaintenanceDueUseCase,
  type ListMaintenanceDueOutput,
} from '../application/use-cases/list-maintenance-due.use-case';
import type {
  EquipmentDetailView,
  EquipmentView,
} from '../application/equipment-view';
import type { EquipmentMaintenance } from '../domain/entities/equipment.entity';
import {
  CreateEquipmentDto,
  EquipmentDetailDto,
  EquipmentDto,
  EquipmentMaintenanceDto,
  EquipmentMaintenanceDueQueryDto,
  EquipmentMaintenanceDueResponseDto,
  ListEquipmentQueryDto,
  ListEquipmentResponseDto,
  RecordMaintenanceDto,
  RetireEquipmentDto,
  UpdateEquipmentDto,
  VoidMaintenanceDto,
} from './dto/equipment.dto';

/** 403 en español para quien no es ADMIN (la web lo enseña tal cual). */
export const EQUIPMENT_FORBIDDEN_MESSAGE =
  'Solo administración gestiona los equipos biomédicos.';

interface AuthenticatedRequest {
  user: JwtPayload;
}

const FORBIDDEN = `${EQUIPMENT_FORBIDDEN_MESSAGE} (o sede no permitida)`;

/**
 * Equipos biomédicos de cada sede y su hoja de vida (DX-542): inventario de
 * dotación, mantenimientos y bajas. Solo ADMIN, lectura y escritura. Nada se
 * borra: el equipo se da de baja y el mantenimiento se anula, con motivo y
 * `audit_event`.
 */
@ApiTags('equipment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EQUIPMENT_ROLES)
@RolesDeniedMessage(EQUIPMENT_FORBIDDEN_MESSAGE)
@Controller('equipment')
export class EquipmentController {
  constructor(
    private readonly listEquipment: ListEquipmentUseCase,
    private readonly getEquipment: GetEquipmentUseCase,
    private readonly createEquipment: CreateEquipmentUseCase,
    private readonly updateEquipment: UpdateEquipmentUseCase,
    private readonly retireEquipment: RetireEquipmentUseCase,
    private readonly recordMaintenance: RecordMaintenanceUseCase,
    private readonly voidMaintenance: VoidMaintenanceUseCase,
    private readonly maintenanceDue: ListMaintenanceDueUseCase,
  ) {}

  @Get()
  @ApiOkResponse({
    type: ListEquipmentResponseDto,
    description:
      'Equipos por nombre, paginados, con su próximo mantenimiento y si está vencido o próximo (≤30 días) en el día de su sede.',
  })
  @ApiBadRequestResponse({ description: 'Filtro inválido' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  list(@Query() query: ListEquipmentQueryDto): Promise<ListEquipmentOutput> {
    return this.listEquipment.execute({
      locationId: query.locationId,
      status: query.status,
      query: query.query,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  // Antes de `:id`: si no, «maintenance-due» llegaría como id (400 del UUID).
  @Get('maintenance-due')
  @ApiOperation({
    summary: 'Mantenimientos de equipos vencidos o por vencer («Mi día»)',
    description:
      'DX-543: equipos ACTIVOS con el próximo preventivo vencido (OVERDUE) o que vence hoy o en los próximos 30 días (DUE_SOON), contados en el día de la sede de cada equipo, con la misma regla que `nextMaintenanceOn`/`maintenanceStatus` de la lista. ' +
      'Fuera: al día, sin programar y dados de baja. En la sede activa (`X-Location-Id`); sin ella, las sedes permitidas al usuario (vista consolidada). De lo más urgente a lo menos. Solo ADMIN.',
  })
  @ApiHeader({
    name: 'X-Location-Id',
    required: false,
    description:
      'Sede activa; sin ella, las sedes permitidas al usuario (vista consolidada)',
  })
  @ApiOkResponse({ type: EquipmentMaintenanceDueResponseDto })
  @ApiBadRequestResponse({ description: 'Límite inválido' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  listMaintenanceDue(
    @Query() query: EquipmentMaintenanceDueQueryDto,
  ): Promise<ListMaintenanceDueOutput> {
    return this.maintenanceDue.execute({ limit: query.limit });
  }

  @Get(':id')
  @ApiOkResponse({
    type: EquipmentDetailDto,
    description:
      'Hoja de vida: el equipo y sus mantenimientos en orden cronológico.',
  })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado en esta clínica' })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<EquipmentDetailView> {
    return this.getEquipment.execute(id);
  }

  @Audit({
    action: 'CREATE',
    resource: 'EQUIPMENT',
    resourceId: { response: 'id' },
  })
  @Post()
  @ApiCreatedResponse({ type: EquipmentDto })
  @ApiBadRequestResponse({
    description:
      'Campo inválido (todos los errores en un mensaje), o el sillón es de otra sede o está desactivado',
  })
  @ApiNotFoundResponse({
    description: 'Sede o sillón no encontrados en esta clínica',
  })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  create(
    @Body() dto: CreateEquipmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<EquipmentView> {
    return this.createEquipment.execute(
      {
        locationId: dto.locationId,
        chairId: dto.chairId,
        name: dto.name,
        category: dto.category,
        brand: dto.brand,
        model: dto.model,
        serialNumber: dto.serialNumber,
        sanitaryRegistration: dto.sanitaryRegistration,
        riskClass: dto.riskClass,
        acquiredOn: dto.acquiredOn,
        maintenanceIntervalMonths: dto.maintenanceIntervalMonths,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'EQUIPMENT',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @ApiOkResponse({ type: EquipmentDto })
  @ApiBadRequestResponse({
    description:
      'Campo inválido, o el sillón es de otra sede o está desactivado',
  })
  @ApiNotFoundResponse({
    description: 'Equipo, sede o sillón no encontrados en esta clínica',
  })
  @ApiConflictResponse({ description: 'El equipo está dado de baja' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEquipmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<EquipmentView> {
    return this.updateEquipment.execute(
      id,
      {
        locationId: dto.locationId,
        chairId: dto.chairId,
        name: dto.name,
        category: dto.category,
        brand: dto.brand,
        model: dto.model,
        serialNumber: dto.serialNumber,
        sanitaryRegistration: dto.sanitaryRegistration,
        riskClass: dto.riskClass,
        acquiredOn: dto.acquiredOn,
        maintenanceIntervalMonths: dto.maintenanceIntervalMonths,
        notes: dto.notes,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'EQUIPMENT',
    resourceId: { param: 'id' },
    reason: 'EQUIPMENT_RETIRED',
  })
  @Post(':id/retire')
  @HttpCode(200)
  @ApiOkResponse({
    type: EquipmentDto,
    description:
      'Dado de baja (no se borra ni se reactiva): conserva su hoja de vida.',
  })
  @ApiBadRequestResponse({ description: 'Motivo o fecha inválidos' })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya estaba dado de baja' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  retire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetireEquipmentDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<EquipmentView> {
    return this.retireEquipment.execute(
      id,
      { retiredOn: dto.retiredOn, reason: dto.reason },
      req.user.sub,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'EQUIPMENT_MAINTENANCE',
    resourceId: { response: 'id' },
  })
  @Post(':id/maintenances')
  @ApiCreatedResponse({
    type: EquipmentMaintenanceDto,
    description:
      'El mantenimiento registrado; un preventivo deja como próximo la fecha + la periodicidad del equipo (o el explícito).',
  })
  @ApiBadRequestResponse({
    description:
      'Campo inválido (fecha futura, costo sin moneda, moneda desconocida…)',
  })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'El equipo está dado de baja' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  addMaintenance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordMaintenanceDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<EquipmentMaintenance> {
    return this.recordMaintenance.execute(
      id,
      {
        kind: dto.kind,
        performedOn: dto.performedOn,
        technician: dto.technician,
        company: dto.company,
        description: dto.description,
        cost: dto.cost,
        currency: dto.currency,
        nextDueOn: dto.nextDueOn,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VOID',
    resource: 'EQUIPMENT_MAINTENANCE',
    resourceId: { param: 'maintenanceId' },
  })
  @Post(':id/maintenances/:maintenanceId/void')
  @HttpCode(200)
  @ApiOkResponse({
    type: EquipmentMaintenanceDto,
    description:
      'Anulado con motivo (no se borra): sigue en la hoja de vida, marcado.',
  })
  @ApiBadRequestResponse({ description: 'Motivo inválido' })
  @ApiNotFoundResponse({
    description: 'Equipo o mantenimiento no encontrados en esta clínica',
  })
  @ApiConflictResponse({ description: 'Ya estaba anulado' })
  @ApiForbiddenResponse({ description: FORBIDDEN })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('maintenanceId', ParseUUIDPipe) maintenanceId: string,
    @Body() dto: VoidMaintenanceDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<EquipmentMaintenance> {
    return this.voidMaintenance.execute(
      id,
      maintenanceId,
      dto.reason,
      req.user.sub,
    );
  }
}
