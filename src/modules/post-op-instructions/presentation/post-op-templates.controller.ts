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
  POSTOP_ROLES,
  POSTOP_TEMPLATE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreatePostOpTemplateUseCase,
  ListPostOpTemplatesUseCase,
  LoadSamplePostOpTemplatesUseCase,
  UpdatePostOpTemplateUseCase,
} from '../application/use-cases/post-op-templates.use-cases';
import {
  CreatePostOpTemplateDto,
  ListPostOpTemplatesQueryDto,
  PostOpTemplateDto,
  toPostOpTemplateDto,
  UpdatePostOpTemplateDto,
} from './dto/post-op-template.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Plantillas de indicaciones postoperatorias (DX-222). Leerlas: los cuatro
// roles (recepción también las entrega en el mostrador). Crear, editar,
// desactivar y cargar las de ejemplo: solo ADMIN, auditado. No hay DELETE:
// una plantilla se desactiva y las entregas guardan su propia copia.
@ApiTags('post-op-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...POSTOP_ROLES)
@Controller('post-op-templates')
export class PostOpTemplatesController {
  constructor(
    private readonly listTemplates: ListPostOpTemplatesUseCase,
    private readonly createTemplate: CreatePostOpTemplateUseCase,
    private readonly updateTemplate: UpdatePostOpTemplateUseCase,
    private readonly loadSamples: LoadSamplePostOpTemplatesUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Plantillas de indicaciones de la clínica, con sus vínculos',
  })
  @ApiOkResponse({ type: [PostOpTemplateDto] })
  async list(
    @Query() query: ListPostOpTemplatesQueryDto,
  ): Promise<PostOpTemplateDto[]> {
    const templates = await this.listTemplates.execute({
      active: query.active,
    });
    return templates.map(toPostOpTemplateDto);
  }

  @Audit({
    action: 'CREATE',
    resource: 'POSTOP_TEMPLATE',
    resourceId: { response: 'id' },
  })
  @Post()
  @Roles(...POSTOP_TEMPLATE_WRITE_ROLES)
  @ApiOperation({ summary: 'Crear una plantilla de indicaciones' })
  @ApiCreatedResponse({ type: PostOpTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Código con formato inválido, texto vacío, variables no admitidas, o un procedimiento o tipo de cita que no existe en la clínica',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese código',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async create(
    @Body() dto: CreatePostOpTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpTemplateDto> {
    const created = await this.createTemplate.execute(
      {
        code: dto.code,
        title: dto.title,
        body: dto.body,
        catalogItemIds: dto.catalogItemIds,
        appointmentTypeIds: dto.appointmentTypeIds,
      },
      req.user.sub,
    );
    return toPostOpTemplateDto(created);
  }

  @Audit({
    action: 'CREATE',
    resource: 'POSTOP_TEMPLATE',
    reason: 'SAMPLE_TEMPLATES',
  })
  @Post('samples')
  @Roles(...POSTOP_TEMPLATE_WRITE_ROLES)
  @ApiOperation({
    summary: 'Cargar plantillas de ejemplo',
    description:
      'Crea las plantillas de ejemplo que la clínica aún no tiene (por código) y devuelve las creadas. Repetirlo no duplica nada.',
  })
  @ApiCreatedResponse({ type: [PostOpTemplateDto] })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async samples(
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpTemplateDto[]> {
    const created = await this.loadSamples.execute(req.user.sub);
    return created.map(toPostOpTemplateDto);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'POSTOP_TEMPLATE',
    resourceId: { param: 'id' },
  })
  @Patch(':id')
  @Roles(...POSTOP_TEMPLATE_WRITE_ROLES)
  @ApiOperation({
    summary: 'Editar o desactivar una plantilla',
    description:
      'Cambiar título o texto sube la versión; activar, desactivar o cambiar vínculos no. El código no se edita.',
  })
  @ApiOkResponse({ type: PostOpTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Texto vacío, variables no admitidas, o un procedimiento o tipo de cita que no existe en la clínica',
  })
  @ApiNotFoundResponse({
    description: 'Plantilla de indicaciones no encontrada en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePostOpTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PostOpTemplateDto> {
    const updated = await this.updateTemplate.execute(
      id,
      {
        title: dto.title,
        body: dto.body,
        active: dto.active,
        catalogItemIds: dto.catalogItemIds,
        appointmentTypeIds: dto.appointmentTypeIds,
      },
      req.user.sub,
    );
    return toPostOpTemplateDto(updated);
  }
}
