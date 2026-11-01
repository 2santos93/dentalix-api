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
  CLINICAL_ROLES,
  PRESCRIPTION_TEMPLATE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreatePrescriptionTemplateUseCase,
  DeletePrescriptionTemplateUseCase,
  ListPrescriptionTemplatesUseCase,
  UpdatePrescriptionTemplateUseCase,
} from '../application/use-cases/prescription-templates.use-cases';
import type { PrescriptionTemplate } from '../domain/entities/prescription-template.entity';
import {
  CreatePrescriptionTemplateDto,
  PrescriptionTemplateDto,
  UpdatePrescriptionTemplateDto,
} from './dto/prescription-template.dto';

@ApiTags('prescription-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@ApiForbiddenResponse({ description: 'Recepción no lee; solo ADMIN escribe' })
@Controller('prescription-templates')
export class PrescriptionTemplatesController {
  constructor(
    private readonly listTemplates: ListPrescriptionTemplatesUseCase,
    private readonly createTemplate: CreatePrescriptionTemplateUseCase,
    private readonly updateTemplate: UpdatePrescriptionTemplateUseCase,
    private readonly deleteTemplate: DeletePrescriptionTemplateUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOkResponse({ type: [PrescriptionTemplateDto] })
  list(): Promise<PrescriptionTemplate[]> {
    return this.listTemplates.execute();
  }

  @Post()
  @Roles(...PRESCRIPTION_TEMPLATE_WRITE_ROLES)
  @ApiCreatedResponse({ type: PrescriptionTemplateDto })
  @ApiBadRequestResponse({
    description: 'Nombre vacío, sin medicamentos o datos fuera de rango',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese nombre',
  })
  create(
    @Body() dto: CreatePrescriptionTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<PrescriptionTemplate> {
    return this.createTemplate.execute(
      { name: dto.name, notes: dto.notes, items: dto.items },
      this.audit(req),
    );
  }

  @Patch(':id')
  @Roles(...PRESCRIPTION_TEMPLATE_WRITE_ROLES)
  @ApiOkResponse({ type: PrescriptionTemplateDto })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese nombre',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePrescriptionTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<PrescriptionTemplate> {
    return this.updateTemplate.execute(
      id,
      { name: dto.name, notes: dto.notes, items: dto.items },
      this.audit(req),
    );
  }

  // Borrado BLANDO (deletedAt): las recetas emitidas copiaron los datos y no
  // dependen de la plantilla.
  @Delete(':id')
  @HttpCode(204)
  @Roles(...PRESCRIPTION_TEMPLATE_WRITE_ROLES)
  @ApiNoContentResponse({ description: 'Plantilla retirada' })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await this.deleteTemplate.execute(id, this.audit(req));
  }

  /** Quién escribe, para el evento que el repositorio guarda (DX-360). */
  private audit(req: AuditableRequest): AuditRequestContext {
    return requireAuditRequestContext(req, this.tenantContext);
  }
}
