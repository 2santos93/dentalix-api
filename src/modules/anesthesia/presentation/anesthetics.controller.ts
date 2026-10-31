import {
  Body,
  Controller,
  Get,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  ANESTHETIC_CATALOG_WRITE_ROLES,
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import { AnestheticCatalogUseCases } from '../application/use-cases/anesthetic-catalog.use-cases';
import type { AnestheticProduct } from '../domain/entities';
import {
  AnestheticProductDto,
  CreateAnestheticProductDto,
  ListAnestheticsQueryDto,
  UpdateAnestheticProductDto,
} from './dto/anesthesia.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Catálogo de anestésicos locales de la clínica (DX-307). Leerlo: quien
// registra la evolución; crear, editar, desactivar y cargar los sugeridos:
// solo ADMIN, auditado. No hay DELETE: un anestésico se desactiva.
@ApiTags('anesthesia')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Controller('anesthetics')
export class AnestheticsController {
  constructor(private readonly catalog: AnestheticCatalogUseCases) {}

  @Get()
  @Roles(...CLINICAL_ROLES)
  @ApiOperation({
    summary: 'Catálogo de anestésicos de la clínica',
    description:
      'Activos por nombre; con `includeInactive=true`, también los desactivados. Valores de ayuda: no sustituyen la ficha técnica del fabricante.',
  })
  @ApiOkResponse({ type: [AnestheticProductDto] })
  list(@Query() query: ListAnestheticsQueryDto): Promise<AnestheticProduct[]> {
    return this.catalog.list(query.includeInactive === true);
  }

  @Audit({
    action: 'CREATE',
    resource: 'ANESTHETIC_PRODUCT',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...ANESTHETIC_CATALOG_WRITE_ROLES)
  @ApiOperation({ summary: 'Añadir un anestésico al catálogo' })
  @ApiCreatedResponse({ type: AnestheticProductDto })
  @ApiBadRequestResponse({ description: 'Valores fuera de rango' })
  @ApiConflictResponse({ description: 'Ya hay uno con ese nombre' })
  create(
    @Body() dto: CreateAnestheticProductDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnestheticProduct> {
    return this.catalog.create(
      {
        name: dto.name,
        activeIngredient: dto.activeIngredient,
        concentrationPct: dto.concentrationPct,
        vasoconstrictor: dto.vasoconstrictor ?? null,
        mlPerCarpule: dto.mlPerCarpule,
        maxMgPerKg: dto.maxMgPerKg,
        maxAbsoluteMg: dto.maxAbsoluteMg,
        pediatricMaxMgPerKg: dto.pediatricMaxMgPerKg,
        minAgeYears: dto.minAgeYears,
        epinephrineMgPerCarpule: dto.epinephrineMgPerCarpule,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'ANESTHETIC_PRODUCT',
    reason: 'SAMPLE_ANESTHETICS',
  })
  @Post('samples')
  @Roles(...ANESTHETIC_CATALOG_WRITE_ROLES)
  @ApiOperation({
    summary: 'Cargar anestésicos sugeridos',
    description:
      'Crea los 5 anestésicos de ejemplo (lidocaína, articaína, mepivacaína, prilocaína y bupivacaína, con dosis máximas de referencia editables) que la clínica aún no tiene, y devuelve los creados. Repetirlo no duplica nada.',
  })
  @ApiCreatedResponse({ type: [AnestheticProductDto] })
  loadSamples(@Req() req: AuthenticatedRequest): Promise<AnestheticProduct[]> {
    return this.catalog.loadSamples(req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ANESTHETIC_PRODUCT',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...ANESTHETIC_CATALOG_WRITE_ROLES)
  @ApiOperation({
    summary: 'Editar o desactivar un anestésico',
    description:
      'Lo ya registrado no cambia: cada anestesia copió los valores del catálogo.',
  })
  @ApiOkResponse({ type: AnestheticProductDto })
  @ApiNotFoundResponse({ description: 'No es de esta clínica' })
  @ApiConflictResponse({ description: 'Ya hay uno con ese nombre' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnestheticProductDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AnestheticProduct> {
    return this.catalog.update(
      id,
      {
        name: dto.name,
        activeIngredient: dto.activeIngredient,
        concentrationPct: dto.concentrationPct,
        vasoconstrictor: dto.vasoconstrictor,
        mlPerCarpule: dto.mlPerCarpule,
        maxMgPerKg: dto.maxMgPerKg,
        maxAbsoluteMg: dto.maxAbsoluteMg,
        pediatricMaxMgPerKg: dto.pediatricMaxMgPerKg,
        minAgeYears: dto.minAgeYears,
        epinephrineMgPerCarpule: dto.epinephrineMgPerCarpule,
        active: dto.active,
      },
      req.user.sub,
    );
  }
}
