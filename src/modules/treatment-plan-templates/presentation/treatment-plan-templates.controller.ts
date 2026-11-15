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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  TREATMENT_PLAN_TEMPLATE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreatePlanTemplateUseCase,
  GetPlanTemplateUseCase,
  ListPlanTemplatesUseCase,
  UpdatePlanTemplateUseCase,
} from '../application/use-cases/treatment-plan-templates.use-cases';
import type { TreatmentPlanTemplate } from '../domain/entities/treatment-plan-template.entity';
import {
  CreateTreatmentPlanTemplateDto,
  ListTreatmentPlanTemplatesQueryDto,
  TreatmentPlanTemplateDto,
  UpdateTreatmentPlanTemplateDto,
} from './dto/treatment-plan-template.dto';

const LINE_NOT_FOUND =
  'Plantilla no encontrada en esta clínica, o `code` PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND: el procedimiento de una línea no existe en el catálogo de esta clínica (o está retirado); el cuerpo lleva su `position`';
const NOT_A_PROCEDURE =
  '`code` PLAN_TEMPLATE_NOT_A_PROCEDURE: una línea apunta a un diagnóstico, no a un procedimiento; el cuerpo lleva su `position`';

// Plantillas de plan de tratamiento (DX-559). Leerlas: quien arma planes
// (CLINICAL_ROLES, sin recepción). Crear, editar y desactivar: solo ADMIN,
// auditado en la transacción del cambio (DX-360). No hay DELETE: una
// plantilla se desactiva.
@ApiTags('treatment-plan-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('treatment-plan-templates')
export class TreatmentPlanTemplatesController {
  constructor(
    private readonly listTemplates: ListPlanTemplatesUseCase,
    private readonly getTemplate: GetPlanTemplateUseCase,
    private readonly createTemplate: CreatePlanTemplateUseCase,
    private readonly updateTemplate: UpdatePlanTemplateUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Plantillas de plan de la clínica, con sus líneas',
  })
  @ApiOkResponse({ type: [TreatmentPlanTemplateDto] })
  @ApiForbiddenResponse({ description: 'Recepción no arma planes' })
  list(
    @Query() query: ListTreatmentPlanTemplatesQueryDto,
  ): Promise<TreatmentPlanTemplate[]> {
    return this.listTemplates.execute({
      includeInactive: query.includeInactive,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Una plantilla de plan, activa o no' })
  @ApiOkResponse({ type: TreatmentPlanTemplateDto })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Recepción no arma planes' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TreatmentPlanTemplate> {
    return this.getTemplate.execute(id);
  }

  @Post()
  @Roles(...TREATMENT_PLAN_TEMPLATE_WRITE_ROLES)
  @ApiOperation({ summary: 'Crear una plantilla de plan' })
  @ApiCreatedResponse({ type: TreatmentPlanTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Nombre vacío o largo, sin líneas o con más de 50, cantidad o visita fuera de rango, etiquetas distintas en una visita o días entre visitas inválidos (mensaje en español)',
  })
  @ApiNotFoundResponse({ description: LINE_NOT_FOUND })
  @ApiUnprocessableEntityResponse({ description: NOT_A_PROCEDURE })
  @ApiConflictResponse({
    description:
      '`code` PLAN_TEMPLATE_DUPLICATE_NAME: ya existe una plantilla con ese nombre (sin distinguir mayúsculas)',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateTreatmentPlanTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<TreatmentPlanTemplate> {
    return this.createTemplate.execute(
      {
        name: dto.name,
        visitIntervals: dto.visitIntervals,
        lines: dto.lines,
        active: dto.active,
      },
      this.audit(req),
    );
  }

  @Patch(':id')
  @Roles(...TREATMENT_PLAN_TEMPLATE_WRITE_ROLES)
  @ApiOperation({
    summary: 'Editar, activar o desactivar una plantilla de plan',
    description:
      'Los planes ya creados no cambian (sus ítems son ítems normales). `lines`, si viene, sustituye todas las líneas. `version` es obligatoria (409 PLAN_TEMPLATE_STALE si cambió).',
  })
  @ApiOkResponse({ type: TreatmentPlanTemplateDto })
  @ApiBadRequestResponse({ description: 'Plantilla resultante inválida' })
  @ApiNotFoundResponse({ description: LINE_NOT_FOUND })
  @ApiUnprocessableEntityResponse({ description: NOT_A_PROCEDURE })
  @ApiConflictResponse({
    description:
      '`code` PLAN_TEMPLATE_STALE: la plantilla cambió («La plantilla cambió mientras la editabas: recárgala.»); o PLAN_TEMPLATE_DUPLICATE_NAME',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTreatmentPlanTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<TreatmentPlanTemplate> {
    return this.updateTemplate.execute(
      id,
      {
        name: dto.name,
        visitIntervals: dto.visitIntervals,
        lines: dto.lines,
        active: dto.active,
        version: dto.version,
      },
      this.audit(req),
    );
  }

  /** Quién escribe, para el evento que el repositorio guarda (DX-360). */
  private audit(req: AuditableRequest): AuditRequestContext {
    return requireAuditRequestContext(req, this.tenantContext);
  }
}
