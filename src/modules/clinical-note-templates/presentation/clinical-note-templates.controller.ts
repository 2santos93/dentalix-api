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
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_NOTE_TEMPLATE_WRITE_ROLES,
  CLINICAL_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateNoteTemplateUseCase,
  ListNoteTemplatesUseCase,
  LoadSampleNoteTemplatesUseCase,
  UpdateNoteTemplateUseCase,
} from '../application/use-cases/clinical-note-templates.use-cases';
import type { ClinicalNoteTemplate } from '../domain/entities/clinical-note-template.entity';
import {
  ClinicalNoteTemplateDto,
  CreateClinicalNoteTemplateDto,
  ListClinicalNoteTemplatesQueryDto,
  UpdateClinicalNoteTemplateDto,
} from './dto/clinical-note-template.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Plantillas de evolución (DX-170). Leerlas: quien documenta evoluciones
// (CLINICAL_ROLES, sin recepción). Crear, editar, desactivar y cargar las de
// ejemplo: solo ADMIN, auditado. No hay DELETE: una plantilla se desactiva.
@ApiTags('clinical-note-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('clinical-note-templates')
export class ClinicalNoteTemplatesController {
  constructor(
    private readonly listTemplates: ListNoteTemplatesUseCase,
    private readonly createTemplate: CreateNoteTemplateUseCase,
    private readonly updateTemplate: UpdateNoteTemplateUseCase,
    private readonly loadSamples: LoadSampleNoteTemplatesUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Plantillas de evolución de la clínica, con sus preguntas',
  })
  @ApiOkResponse({ type: [ClinicalNoteTemplateDto] })
  @ApiForbiddenResponse({ description: 'Recepción no documenta evoluciones' })
  list(
    @Query() query: ListClinicalNoteTemplatesQueryDto,
  ): Promise<ClinicalNoteTemplate[]> {
    return this.listTemplates.execute({
      includeInactive: query.includeInactive,
    });
  }

  @Audit({
    action: 'CREATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...CLINICAL_NOTE_TEMPLATE_WRITE_ROLES)
  @ApiCreatedResponse({ type: ClinicalNoteTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Marcador sin pregunta, pregunta sin marcador, ONE/MULTI sin opciones u otro campo inválido (mensaje en español)',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese nombre',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateClinicalNoteTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicalNoteTemplate> {
    return this.createTemplate.execute(
      {
        name: dto.name,
        category: dto.category,
        body: dto.body,
        prompts: dto.prompts,
        active: dto.active,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    reason: 'SAMPLE_TEMPLATES',
  })
  @Post('samples')
  @Roles(...CLINICAL_NOTE_TEMPLATE_WRITE_ROLES)
  @ApiOperation({
    summary: 'Cargar plantillas de ejemplo',
    description:
      'Crea las 6 plantillas de ejemplo que la clínica aún no tiene (por nombre) y devuelve las creadas. Repetirlo no duplica nada.',
  })
  @ApiCreatedResponse({ type: [ClinicalNoteTemplateDto] })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  samples(@Req() req: AuthenticatedRequest): Promise<ClinicalNoteTemplate[]> {
    return this.loadSamples.execute(req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'CLINICAL_NOTE_TEMPLATE',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...CLINICAL_NOTE_TEMPLATE_WRITE_ROLES)
  @ApiOperation({
    summary: 'Editar o desactivar una plantilla',
    description:
      'Las evoluciones ya guardadas no cambian: llevan su texto compuesto. `prompts`, si viene, sustituye todas las preguntas.',
  })
  @ApiOkResponse({ type: ClinicalNoteTemplateDto })
  @ApiBadRequestResponse({ description: 'Plantilla resultante inválida' })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese nombre',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClinicalNoteTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ClinicalNoteTemplate> {
    return this.updateTemplate.execute(
      id,
      {
        name: dto.name,
        category: dto.category,
        body: dto.body,
        prompts: dto.prompts,
        active: dto.active,
      },
      req.user.sub,
    );
  }
}
