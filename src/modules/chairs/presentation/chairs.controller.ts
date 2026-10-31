import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  APPOINTMENT_ROLES,
  CHAIR_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateChairUseCase,
  ListChairsUseCase,
  ReorderChairsUseCase,
  SetChairActiveUseCase,
  UpdateChairUseCase,
} from '../application/use-cases/chairs.use-cases';
import type { Chair } from '../domain/entities/chair.entity';
import {
  ChairDto,
  CreateChairDto,
  ListChairsQueryDto,
  ReorderChairsDto,
  UpdateChairDto,
} from './dto/chair.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

/**
 * Sillones (gabinetes) de cada sede (DX-211). Leerlos: los 4 roles de agenda
 * (selector del formulario de cita y columnas «Sillones» de la vista Día).
 * Crear, editar, ordenar, desactivar y reactivar: solo ADMIN, con
 * `audit_event` CHAIR. No se borran.
 */
@ApiTags('chairs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...APPOINTMENT_ROLES)
@Controller('chairs')
export class ChairsController {
  constructor(
    private readonly listChairs: ListChairsUseCase,
    private readonly createChair: CreateChairUseCase,
    private readonly updateChair: UpdateChairUseCase,
    private readonly setChairActive: SetChairActiveUseCase,
    private readonly reorderChairs: ReorderChairsUseCase,
  ) {}

  @Get()
  @ApiOkResponse({
    type: [ChairDto],
    description: 'Sillones de la sede por `sortOrder` y nombre.',
  })
  @ApiForbiddenResponse({ description: 'Sede no permitida al usuario' })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  list(@Query() query: ListChairsQueryDto): Promise<Chair[]> {
    return this.listChairs.execute({
      locationId: query.locationId,
      includeInactive: query.includeInactive,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'CHAIR',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...CHAIR_WRITE_ROLES)
  @ApiCreatedResponse({ type: ChairDto })
  @ApiBadRequestResponse({
    description:
      'Nombre vacío o de más de 40, orden fuera de 0–999, o el profesional por defecto no atiende pacientes o no atiende en la sede',
  })
  @ApiNotFoundResponse({
    description: 'Sede o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Ya existe un sillón con ese nombre en la sede',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, en una sede permitida' })
  create(
    @Body() dto: CreateChairDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Chair> {
    return this.createChair.execute(
      {
        locationId: dto.locationId,
        name: dto.name,
        sortOrder: dto.sortOrder,
        defaultProviderId: dto.defaultProviderId,
      },
      req.user.sub,
    );
  }

  @Audit({ action: 'UPDATE', resource: 'CHAIR', reason: 'CHAIR_ORDER' })
  @Put('order')
  @Roles(...CHAIR_WRITE_ROLES)
  @ApiOkResponse({
    type: [ChairDto],
    description: 'Los sillones de la sede en el orden nuevo.',
  })
  @ApiBadRequestResponse({
    description: 'No son todos los sillones de la sede, o alguno se repite',
  })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, en una sede permitida' })
  reorder(
    @Body() dto: ReorderChairsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Chair[]> {
    return this.reorderChairs.execute(
      { locationId: dto.locationId, chairIds: dto.chairIds },
      req.user.sub,
    );
  }

  @Audit({ action: 'UPDATE', resource: 'CHAIR', resourceId: { param: 'id' } })
  @Patch(':id')
  @Roles(...CHAIR_WRITE_ROLES)
  @ApiOkResponse({ type: ChairDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({
    description: 'Sillón o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Ya existe un sillón con ese nombre en la sede',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, en una sede permitida' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChairDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Chair> {
    return this.updateChair.execute(
      id,
      {
        name: dto.name,
        sortOrder: dto.sortOrder,
        defaultProviderId: dto.defaultProviderId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CHAIR',
    resourceId: { param: 'id' },
    reason: 'CHAIR_DEACTIVATED',
  })
  @Post(':id/deactivate')
  @HttpCode(200)
  @Roles(...CHAIR_WRITE_ROLES)
  @ApiOkResponse({
    type: ChairDto,
    description:
      'Desactivado (no se borra): deja de ofrecerse para citas nuevas y de salir como columna; sus citas lo conservan.',
  })
  @ApiNotFoundResponse({ description: 'Sillón no encontrado en esta clínica' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, en una sede permitida' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Chair> {
    return this.setChairActive.execute(id, false, req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CHAIR',
    resourceId: { param: 'id' },
    reason: 'CHAIR_REACTIVATED',
  })
  @Post(':id/reactivate')
  @HttpCode(200)
  @Roles(...CHAIR_WRITE_ROLES)
  @ApiOkResponse({ type: ChairDto })
  @ApiNotFoundResponse({ description: 'Sillón no encontrado en esta clínica' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, en una sede permitida' })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Chair> {
    return this.setChairActive.execute(id, true, req.user.sub);
  }
}
