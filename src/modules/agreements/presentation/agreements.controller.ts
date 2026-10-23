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
  AGREEMENT_ROLES,
  AGREEMENT_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateAgreementUseCase,
  DeleteAgreementUseCase,
  ListAgreementsUseCase,
  UpdateAgreementUseCase,
} from '../application/use-cases/agreements.use-cases';
import { Agreement } from '../domain/entities/agreement.entity';
import {
  AgreementDto,
  CreateAgreementDto,
  ListAgreementsQueryDto,
  UpdateAgreementDto,
} from './dto/agreement.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Convenios (DX-105). Leerlos: los 4 roles (selector de la ficha y del plan).
// Crear, editar y retirar: solo ADMIN.
@ApiTags('agreements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...AGREEMENT_ROLES)
@Controller('agreements')
export class AgreementsController {
  constructor(
    private readonly listAgreements: ListAgreementsUseCase,
    private readonly createAgreement: CreateAgreementUseCase,
    private readonly updateAgreement: UpdateAgreementUseCase,
    private readonly deleteAgreement: DeleteAgreementUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Convenios de la clínica (activos; con includeInactive, también los desactivados)',
  })
  @ApiOkResponse({ type: [AgreementDto] })
  list(@Query() query: ListAgreementsQueryDto): Promise<Agreement[]> {
    return this.listAgreements.execute({
      includeInactive: query.includeInactive,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'AGREEMENT',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...AGREEMENT_WRITE_ROLES)
  @ApiOperation({
    summary: 'Crear un convenio con descuento porcentual o lista de precios',
  })
  @ApiCreatedResponse({ type: AgreementDto })
  @ApiBadRequestResponse({
    description:
      'Campos del tipo, porcentaje, categoría, fechas, pagador, lista o sede inválidos',
  })
  @ApiConflictResponse({ description: 'Nombre duplicado' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateAgreementDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Agreement> {
    return this.createAgreement.execute(
      {
        name: dto.name,
        payerId: dto.payerId,
        kind: dto.kind,
        percent: dto.percent,
        percentByCategory: dto.percentByCategory,
        priceListId: dto.priceListId,
        locationId: dto.locationId,
        validFrom: dto.validFrom,
        validTo: dto.validTo,
        active: dto.active,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'AGREEMENT',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...AGREEMENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Editar o desactivar un convenio' })
  @ApiOkResponse({ type: AgreementDto })
  @ApiBadRequestResponse({ description: 'Campo inválido' })
  @ApiNotFoundResponse({
    description: 'Convenio no encontrado en esta clínica',
  })
  @ApiConflictResponse({ description: 'Nombre duplicado' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgreementDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Agreement> {
    return this.updateAgreement.execute(
      id,
      {
        name: dto.name,
        payerId: dto.payerId,
        kind: dto.kind,
        percent: dto.percent,
        percentByCategory: dto.percentByCategory,
        priceListId: dto.priceListId,
        locationId: dto.locationId,
        validFrom: dto.validFrom,
        validTo: dto.validTo,
        active: dto.active,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'DELETE',
    resource: 'AGREEMENT',
    resourceId: { param: 'id' },
  })
  @Delete(':id')
  @HttpCode(204)
  @Roles(...AGREEMENT_WRITE_ROLES)
  @ApiOperation({
    summary: 'Retirar un convenio sin pacientes asignados (borrado lógico)',
  })
  @ApiNoContentResponse({ description: 'Retirado (borrado lógico).' })
  @ApiNotFoundResponse({
    description: 'Convenio no encontrado en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Tiene pacientes asignados; se desactiva en lugar de retirarlo',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    await this.deleteAgreement.execute(id, req.user.sub);
  }
}
