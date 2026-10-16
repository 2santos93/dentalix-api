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
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  CLINICAL_ROLES,
  CONSENT_TEMPLATE_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  CreateConsentTemplateUseCase,
  ListConsentTemplatesUseCase,
  UpdateConsentTemplateUseCase,
} from '../application/use-cases/consent-templates.use-cases';
import { ConsentTemplate } from '../domain/entities/consent-template.entity';
import { ConsentTemplateDto } from './dto/consent-template.dto';
import { CreateConsentTemplateDto } from './dto/create-consent-template.dto';
import { UpdateConsentTemplateDto } from './dto/update-consent-template.dto';
import { ListConsentTemplatesQueryDto } from './dto/list-consent-templates-query.dto';

interface AuthenticatedRequest {
  user: JwtPayload;
}

// Sin @Delete a propósito: una plantilla se DESACTIVA (PATCH active=false),
// nunca se borra; los consentimientos firmados la referencian.
@ApiTags('consent-templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...CLINICAL_ROLES)
@Controller('consent-templates')
export class ConsentTemplatesController {
  constructor(
    private readonly listTemplates: ListConsentTemplatesUseCase,
    private readonly createTemplate: CreateConsentTemplateUseCase,
    private readonly updateTemplate: UpdateConsentTemplateUseCase,
  ) {}

  @Get()
  @ApiOkResponse({ type: [ConsentTemplateDto] })
  list(
    @Query() query: ListConsentTemplatesQueryDto,
  ): Promise<ConsentTemplate[]> {
    return this.listTemplates.execute({ active: query.active });
  }

  @Post()
  @Roles(...CONSENT_TEMPLATE_WRITE_ROLES)
  @ApiCreatedResponse({ type: ConsentTemplateDto })
  @ApiBadRequestResponse({
    description: 'Texto vacío o variables desconocidas',
  })
  @ApiConflictResponse({
    description: 'Ya existe una plantilla con ese título',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateConsentTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConsentTemplate> {
    return this.createTemplate.execute(
      { title: dto.title, body: dto.body, active: dto.active },
      req.user.sub,
    );
  }

  @Patch(':id')
  @Roles(...CONSENT_TEMPLATE_WRITE_ROLES)
  @ApiOkResponse({ type: ConsentTemplateDto })
  @ApiNotFoundResponse({
    description: 'Plantilla no encontrada en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConsentTemplateDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConsentTemplate> {
    return this.updateTemplate.execute(
      id,
      { title: dto.title, body: dto.body, active: dto.active },
      req.user.sub,
    );
  }
}
