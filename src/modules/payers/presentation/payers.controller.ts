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
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  PAYER_CREATE_ROLES,
  PAYER_MANAGE_ROLES,
  PAYER_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreatePayerUseCase,
  DeletePayerUseCase,
  ListPayersUseCase,
  UpdatePayerUseCase,
} from '../application/use-cases/payers.use-cases';
import { Payer } from '../domain/entities/payer.entity';
import {
  CreatePayerDto,
  ListPayersQueryDto,
  PayerDto,
  UpdatePayerDto,
} from './dto/payer.dto';

// Pagadores (DX-153). Leerlos: los 4 roles (selectores de cobertura). Darlos
// de alta: ADMIN y recepción (mostrador). Editar, desactivar y retirar: ADMIN.
@ApiTags('payers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...PAYER_ROLES)
@Controller('payers')
export class PayersController {
  constructor(
    private readonly listPayers: ListPayersUseCase,
    private readonly createPayer: CreatePayerUseCase,
    private readonly updatePayer: UpdatePayerUseCase,
    private readonly deletePayer: DeletePayerUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Pagadores de la clínica (activos; con includeInactive, también los desactivados)',
  })
  @ApiOkResponse({ type: [PayerDto] })
  list(@Query() query: ListPayersQueryDto): Promise<Payer[]> {
    return this.listPayers.execute({ includeInactive: query.includeInactive });
  }

  @Post()
  @Roles(...PAYER_CREATE_ROLES)
  @ApiOperation({ summary: 'Crear un pagador' })
  @ApiCreatedResponse({ type: PayerDto })
  @ApiBadRequestResponse({
    description: 'Nombre fuera de 2–120 caracteres o tipo desconocido',
  })
  @ApiConflictResponse({ description: 'Ya existe un pagador con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  create(
    @Body() dto: CreatePayerDto,
    @Req() req: AuditableRequest,
  ): Promise<Payer> {
    return this.createPayer.execute(
      { name: dto.name, type: dto.type },
      this.audit(req),
    );
  }

  @Patch(':id')
  @Roles(...PAYER_MANAGE_ROLES)
  @ApiOperation({ summary: 'Editar o desactivar un pagador' })
  @ApiOkResponse({ type: PayerDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({ description: 'Pagador no encontrado en esta clínica' })
  @ApiConflictResponse({ description: 'Ya existe un pagador con ese nombre' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayerDto,
    @Req() req: AuditableRequest,
  ): Promise<Payer> {
    return this.updatePayer.execute(
      id,
      {
        name: dto.name,
        type: dto.type,
        active: dto.active,
      },
      this.audit(req),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(...PAYER_MANAGE_ROLES)
  @ApiOperation({
    summary: 'Retirar un pagador sin coberturas (borrado lógico)',
  })
  @ApiNoContentResponse({ description: 'Retirado (borrado lógico).' })
  @ApiNotFoundResponse({ description: 'Pagador no encontrado en esta clínica' })
  @ApiConflictResponse({
    description:
      'Tiene coberturas o convenios asociados; se desactiva en lugar de retirarlo',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.deletePayer.execute(id, this.audit(req));
  }

  /** Quién escribe, para el evento que el repositorio guarda (DX-360). */
  private audit(req: AuditableRequest): AuditRequestContext {
    return requireAuditRequestContext(req, this.tenantContext);
  }
}
