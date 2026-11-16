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
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  EXTERNAL_ORDER_CONFIG_READ_ROLES,
  EXTERNAL_ORDER_CONFIG_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { ExternalOrderTemplatesUseCases } from '../application/external-order-templates.use-cases';
import { EXTERNAL_ORDER_MESSAGES } from '../domain/external-order-rules';
import {
  CreateExternalOrderTemplateDto,
  ExternalOrderTemplateDto,
  ListExternalOrderTemplatesQueryDto,
  UpdateExternalOrderTemplateDto,
} from './dto/external-order.dto';
import { presentTemplate } from './external-order.presenter';

const DUPLICATE =
  '`code` EXTERNAL_ORDER_TEMPLATE_DUPLICATE_NAME: ya existe una plantilla con ese nombre (sin distinguir mayúsculas)';

// Plantillas de órdenes externas (DX-572, D7). Leerlas: los roles clínicos
// (las ofrece «Nueva orden»). Crear, editar, activar y desactivar: solo
// ADMIN, auditado en la transacción del cambio (EXTERNAL_ORDER_TEMPLATE). No
// hay DELETE: una plantilla se desactiva.
@ApiTags('external-order-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXTERNAL_ORDER_CONFIG_READ_ROLES)
@Controller('external-order-templates')
export class ExternalOrderTemplatesController {
  constructor(
    private readonly templates: ExternalOrderTemplatesUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Plantillas de órdenes externas de la clínica' })
  @ApiOkResponse({ type: [ExternalOrderTemplateDto] })
  @ApiForbiddenResponse({ description: 'Recepción no emite órdenes' })
  async list(
    @Query() query: ListExternalOrderTemplatesQueryDto,
  ): Promise<ExternalOrderTemplateDto[]> {
    const list = await this.templates.list(query.includeInactive === true);
    return list.map(presentTemplate);
  }

  @Post()
  @Roles(...EXTERNAL_ORDER_CONFIG_WRITE_ROLES)
  @RolesDeniedMessage(EXTERNAL_ORDER_MESSAGES.templatesForbidden)
  @ApiOperation({
    summary: 'Crear una plantilla de orden externa',
    description:
      'Auditado: CREATE · EXTERNAL_ORDER_TEMPLATE · EXTERNAL_ORDER_TEMPLATE_CREATED (el destinatario y los estudios solo por nombre de campo).',
  })
  @ApiCreatedResponse({ type: ExternalOrderTemplateDto })
  @ApiBadRequestResponse({
    description:
      'Nombre (1–80), tipo, destinatario (≤120) o estudios (1–20 de ≤200) inválidos',
  })
  @ApiConflictResponse({ description: DUPLICATE })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async create(
    @Body() dto: CreateExternalOrderTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<ExternalOrderTemplateDto> {
    return presentTemplate(
      await this.templates.create(
        {
          name: dto.name,
          kind: dto.kind,
          recipient: dto.recipient,
          items: dto.items,
          active: dto.active,
        },
        requireAuditRequestContext(req, this.tenantContext),
      ),
    );
  }

  @Patch(':id')
  @Roles(...EXTERNAL_ORDER_CONFIG_WRITE_ROLES)
  @RolesDeniedMessage(EXTERNAL_ORDER_MESSAGES.templatesForbidden)
  @ApiOperation({
    summary: 'Editar, activar o desactivar una plantilla de orden externa',
    description:
      'Las órdenes ya emitidas no cambian. `version` es obligatoria (409 EXTERNAL_ORDER_TEMPLATE_STALE si cambió). Auditado: UPDATE · EXTERNAL_ORDER_TEMPLATE · EXTERNAL_ORDER_TEMPLATE_UPDATED.',
  })
  @ApiOkResponse({ type: ExternalOrderTemplateDto })
  @ApiBadRequestResponse({ description: 'Plantilla resultante inválida' })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  @ApiConflictResponse({
    description: `\`code\` EXTERNAL_ORDER_TEMPLATE_STALE: la plantilla cambió; o ${DUPLICATE}`,
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExternalOrderTemplateDto,
    @Req() req: AuditableRequest,
  ): Promise<ExternalOrderTemplateDto> {
    return presentTemplate(
      await this.templates.update(
        id,
        {
          name: dto.name,
          kind: dto.kind,
          recipient: dto.recipient,
          items: dto.items,
          active: dto.active,
          version: dto.version,
        },
        requireAuditRequestContext(req, this.tenantContext),
      ),
    );
  }
}
